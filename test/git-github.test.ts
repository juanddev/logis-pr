import { describe, expect, it } from 'vitest';
import {
  basesForChoice,
  Git,
  isEmbeddedRepo,
  isHotfixBranch,
  leakedDevCommits,
  looksSensitive,
  parseMergeTree,
  parseRemoteUrl,
  planCommit,
} from '../src/git/index.js';
import { GitHub, prNumberFromUrl } from '../src/github/index.js';
import { lines, normalizeEol } from '../src/utils/exec.js';
import { fakeRunner } from './helpers.js';

describe('normalizeEol / lines', () => {
  it('CRLF dan CR menjadi LF', () => {
    expect(normalizeEol('a\r\nb\rc\n')).toBe('a\nb\nc\n');
    expect(lines(' M a.ts\r\n?? b.ts\r\n\r\n')).toEqual([' M a.ts', '?? b.ts']);
  });
});

describe('parseRemoteUrl', () => {
  it.each([
    ['https://github.com/developerserasiautoraya/SELOG_LOGIS_ServiceOrder.git', 'github.com'],
    ['https://github.com/developerserasiautoraya/SELOG_LOGIS_ServiceOrder', 'github.com'],
    ['https://juan@github.com/developerserasiautoraya/SELOG_LOGIS_ServiceOrder.git', 'github.com'],
    ['git@github.com:developerserasiautoraya/SELOG_LOGIS_ServiceOrder.git', 'github.com'],
    ['ssh://git@github.com/developerserasiautoraya/SELOG_LOGIS_ServiceOrder.git', 'github.com'],
    ['git@github-serasi:developerserasiautoraya/SELOG_LOGIS_ServiceOrder.git', 'github.com'],
  ])('%s', (url, host) => {
    expect(parseRemoteUrl(url)).toEqual({ host, owner: 'developerserasiautoraya', repo: 'SELOG_LOGIS_ServiceOrder' });
  });

  it('null untuk URL yang tidak dikenali', () => {
    expect(parseRemoteUrl('/local/path/repo')).toBeNull();
  });
});

describe('Git (git di-mock)', () => {
  it('tidak pernah memakai git add --all', async () => {
    const { runner, calls } = fakeRunner(() => ({}));
    const git = new Git(runner, '/repo');
    await git.stageTracked();
    await git.stagePaths(['a b.ts', '-n.ts']);
    await git.commitStaged('LOGIS-1: pesan "dengan" kutip & $simbol');
    const all = calls.flatMap((c) => c.args);
    expect(all).not.toContain('--all');
    expect(all).not.toContain('-A');
    expect(calls[0]?.args.slice(-2)).toEqual(['add', '--update']);
    // `--` mencegah nama file yang diawali '-' dibaca sebagai opsi
    expect(calls[1]?.args.slice(-4)).toEqual(['add', '--', 'a b.ts', '-n.ts']);
    expect(calls[2]?.args.slice(-2)).toEqual(['commit', '--file=-']);
    expect(calls[2]?.options?.input).toBe('LOGIS-1: pesan "dengan" kutip & $simbol\n');
    expect(calls[2]?.options?.cwd).toBe('/repo');
  });

  it('stagePaths dicicil per 50 file (batas command line Windows)', async () => {
    const { runner, calls } = fakeRunner(() => ({}));
    await new Git(runner).stagePaths(Array.from({ length: 120 }, (_, i) => `f${i}.ts`));
    expect(calls).toHaveLength(3);
  });

  it('commitStaged: hook gagal → CliError berisi stderr', async () => {
    const { runner } = fakeRunner(() => ({ code: 1, stderr: 'husky - pre-commit failed' }));
    await expect(new Git(runner).commitStaged('x')).rejects.toThrow(/git commit gagal:\nhusky/);
  });

  it('status memparse output -z (spasi, rename, untracked, repo bersarang)', async () => {
    const out = ['M  README.md', ' M src/a b.ts', 'R  new.ts', 'old.ts', 'MM both.ts', '?? .DS_Store', '?? src/shared-libs/', ' D gone.ts', ''].join('\0');
    const { runner, calls } = fakeRunner(() => ({ stdout: out }));
    const st = await new Git(runner).status();
    expect(st).toEqual({
      staged: ['README.md', 'new.ts', 'both.ts'],
      unstaged: ['src/a b.ts', 'both.ts', 'gone.ts'],
      untracked: ['.DS_Store', 'src/shared-libs/'],
    });
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  });

  it('currentBranch: null saat detached HEAD', async () => {
    const { runner } = fakeRunner(() => ({ code: 1, stdout: '' }));
    expect(await new Git(runner).currentBranch()).toBeNull();
  });

  it('currentBranch: membuang CRLF dari output Windows', async () => {
    const { runner } = fakeRunner(() => ({ stdout: 'feature/LOGIS-3938-x\n' }));
    expect(await new Git(runner).currentBranch()).toBe('feature/LOGIS-3938-x');
  });

  it('isDirty mendeteksi perubahan', async () => {
    expect(await new Git(fakeRunner(() => ({ stdout: '' })).runner).isDirty()).toBe(false);
    expect(await new Git(fakeRunner(() => ({ stdout: ' M src/a.ts\0' })).runner).isDirty()).toBe(true);
  });

  it('push memakai --set-upstream dan meneruskan stdin (prompt kredensial)', async () => {
    const { runner, calls } = fakeRunner(() => ({}));
    await new Git(runner).push('feature/LOGIS-1-x');
    expect(calls[0]?.args.slice(-4)).toEqual(['push', '--set-upstream', 'origin', 'feature/LOGIS-1-x']);
    expect(calls[0]?.options?.inheritStdin).toBe(true);
  });
});

describe('GitHub (gh di-mock)', () => {
  const repo = 'developerserasiautoraya/SELOG_LOGIS_ServiceOrder';

  it('findOpenPr: memparse JSON dan memfilter owner', async () => {
    const { runner, calls } = fakeRunner(() => ({
      stdout: JSON.stringify([
        {
          number: 9,
          url: 'https://github.com/fork/x/pull/9',
          title: 'fork',
          isDraft: false,
          baseRefName: 'development',
          headRefName: 'feature/LOGIS-1',
          headRepositoryOwner: { login: 'someone-else' },
        },
        {
          number: 1886,
          url: `https://github.com/${repo}/pull/1886`,
          title: 'LOGIS-1: x',
          isDraft: false,
          baseRefName: 'development',
          headRefName: 'feature/LOGIS-1',
          headRepositoryOwner: { login: 'developerserasiautoraya' },
        },
      ]),
    }));
    const pr = await new GitHub(runner).findOpenPr(repo, 'feature/LOGIS-1');
    expect(pr?.number).toBe(1886);
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['pr', 'list', '--repo', repo, '--head', 'feature/LOGIS-1', '--state', 'open']));
  });

  it('findOpenPr: null bila tidak ada', async () => {
    const { runner } = fakeRunner(() => ({ stdout: '[]\r\n' }));
    expect(await new GitHub(runner).findOpenPr(repo, 'b')).toBeNull();
  });

  it('createPr: body via stdin (--body-file -), judul sebagai argumen tunggal', async () => {
    const { runner, calls } = fakeRunner(() => ({
      stdout: `\r\nCreating pull request...\r\nhttps://github.com/${repo}/pull/1887\r\n`,
    }));
    const url = await new GitHub(runner).createPr({
      repo,
      base: 'development',
      head: 'feature/LOGIS-1',
      title: 'LOGIS-1: judul "kutip" & spasi',
      body: 'Tiket: x\n',
      draft: true,
    });
    expect(url).toBe(`https://github.com/${repo}/pull/1887`);
    const args = calls[0]?.args ?? [];
    expect(args[args.indexOf('--title') + 1]).toBe('LOGIS-1: judul "kutip" & spasi');
    expect(args).toEqual(expect.arrayContaining(['--body-file', '-', '--draft', '--base', 'development']));
    expect(calls[0]?.options?.input).toBe('Tiket: x\n');
  });

  it('createPr: "already exists" → pakai PR yang ada (anti duplikat)', async () => {
    const { runner } = fakeRunner((_c, args) =>
      args[1] === 'create'
        ? { code: 1, stderr: 'a pull request for branch "feature/LOGIS-1" into branch "development" already exists' }
        : {
            stdout: JSON.stringify([
              { number: 5, url: `https://github.com/${repo}/pull/5`, title: 't', isDraft: false, baseRefName: 'development' },
            ]),
          },
    );
    const url = await new GitHub(runner).createPr({ repo, base: 'development', head: 'feature/LOGIS-1', title: 't', body: 'b' });
    expect(url).toBe(`https://github.com/${repo}/pull/5`);
  });

  it('authStatus: auth status gagal (akun lain bermasalah) tetapi API lolos → ok', async () => {
    const { runner, calls } = fakeRunner((_c, args) =>
      args[0] === 'auth'
        ? { code: 1, stdout: 'X Failed to log in to github.com account old-acc (keyring)\n' }
        : { code: 0, stdout: 'juanddev\n' },
    );
    const st = await new GitHub(runner).authStatus();
    expect(st).toEqual({ ok: true, detail: 'login sebagai juanddev' });
    expect(calls[0]?.args).toEqual(['auth', 'status', '--active', '--hostname', 'github.com']);
    expect(calls[1]?.args).toEqual(['api', 'user', '--hostname', 'github.com', '--jq', '.login']);
  });

  it('authStatus: auth status & API sama-sama gagal → tidak ok, dengan detail', async () => {
    const { runner } = fakeRunner((_c, args) =>
      args[0] === 'auth'
        ? { code: 1, stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n' }
        : { code: 1, stderr: 'HTTP 401: Bad credentials\n' },
    );
    const st = await new GitHub(runner).authStatus();
    expect(st.ok).toBe(false);
    expect(st.detail).toMatch(/not logged/);
  });

  it('authStatus: tidak pernah mengembalikan baris token', async () => {
    const { runner } = fakeRunner(() => ({
      code: 0,
      stdout: '  ✓ Logged in to github.com account juan (keyring)\n  - Token: gho_************\n',
    }));
    const st = await new GitHub(runner).authStatus();
    expect(st.ok).toBe(true);
    expect(st.detail).toContain('Logged in');
    expect(st.detail).not.toMatch(/gho_/);
  });
});

describe('planCommit & helper', () => {
  it('mode staged: hanya file staged, sisanya ditinggal', () => {
    const p = planCommit({ staged: ['a'], unstaged: ['b'], untracked: ['c'] }, ['c']);
    expect(p).toMatchObject({ mode: 'staged', stageTracked: false, addUntracked: [], files: ['a'] });
    expect(p.left.sort()).toEqual(['b', 'c']);
  });
  it('mode tracked: file baru hanya yang disetujui & valid', () => {
    const p = planCommit({ staged: [], unstaged: ['b'], untracked: ['c', 'd', 'repo/'] }, ['c', 'repo/', 'tidak-ada']);
    expect(p).toMatchObject({ mode: 'tracked', stageTracked: true, addUntracked: ['c'], files: ['b', 'c'] });
    expect(p.left).toEqual(['d', 'repo/']);
  });
  it('tidak ada perubahan terlacak → tidak git add --update', () => {
    expect(planCommit({ staged: [], unstaged: [], untracked: ['x'] }).stageTracked).toBe(false);
  });
  it('isEmbeddedRepo & looksSensitive', () => {
    expect(isEmbeddedRepo('src/shared-libs/')).toBe(true);
    expect(isEmbeddedRepo('src/a.ts')).toBe(false);
    for (const f of ['.env', 'config/.env.production', 'id_rsa', 'certs/server.pem', 'secrets.json', '.npmrc'])
      expect(looksSensitive(f), f).toBe(true);
    for (const f of ['README.md', 'src/environment.ts', 'docs/secret-santa.md']) expect(looksSensitive(f), f).toBe(false);
  });
});

describe('GitHub reviewers (gh api di-mock)', () => {
  const repo = 'developerserasiautoraya/SELOG_LOGIS_ServiceBilling';
  const world = (pr: { author: string; requested?: string[]; reviewed?: string[] }, postFail?: string) =>
    fakeRunner((_c, args) => {
      const path = args.find((a) => a.startsWith('repos/')) ?? '';
      if (args.includes('POST')) return postFail ? { code: 1, stderr: postFail } : { stdout: '{}' };
      if (path.endsWith('/reviews?per_page=100')) {
        return { stdout: JSON.stringify((pr.reviewed ?? []).map((login) => ({ user: { login } }))) };
      }
      return {
        stdout: JSON.stringify({ user: { login: pr.author }, requested_reviewers: (pr.requested ?? []).map((login) => ({ login })) }),
      };
    });

  it('meminta review via REST API dengan reviewers[]', async () => {
    const { runner, calls } = world({ author: 'juanddev' });
    const r = await new GitHub(runner).ensureReviewers(repo, 808, ['firdausnp']);
    expect(r.requested).toEqual(['firdausnp']);
    const post = calls.find((c) => c.args.includes('POST'));
    expect(post?.args).toEqual(['api', '-X', 'POST', `repos/${repo}/pulls/808/requested_reviewers`, '-f', 'reviewers[]=firdausnp']);
  });

  it('idempoten: sudah diminta / sudah review → tidak POST lagi', async () => {
    const { runner, calls } = world({ author: 'juanddev', requested: ['FirdausNP'], reviewed: ['other'] });
    const r = await new GitHub(runner).ensureReviewers(repo, 808, ['firdausnp', 'other']);
    expect(r).toEqual({ requested: [], alreadyRequested: ['firdausnp'], alreadyReviewed: ['other'], skippedAuthor: [] });
    expect(calls.some((c) => c.args.includes('POST'))).toBe(false);
  });

  it('penulis PR tidak bisa jadi reviewer sendiri', async () => {
    const { runner, calls } = world({ author: 'firdausnp' });
    const r = await new GitHub(runner).ensureReviewers(repo, 808, ['firdausnp']);
    expect(r.skippedAuthor).toEqual(['firdausnp']);
    expect(calls.some((c) => c.args.includes('POST'))).toBe(false);
  });

  it('bukan collaborator → CliError dengan saran', async () => {
    const { runner } = world({ author: 'juanddev' }, 'gh: Reviews may only be requested from collaborators. (HTTP 422)');
    const err = await new GitHub(runner).ensureReviewers(repo, 808, ['firdausnp']).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/Gagal meminta review dari firdausnp/);
    expect((err as { hint?: string }).hint).toMatch(/akses ke repo/);
  });

  it('daftar kosong → tidak memanggil gh', async () => {
    const { runner, calls } = world({ author: 'x' });
    await new GitHub(runner).ensureReviewers(repo, 1, []);
    expect(calls).toHaveLength(0);
  });

  it('prNumberFromUrl', () => {
    expect(prNumberFromUrl(`https://github.com/${repo}/pull/808`)).toBe(808);
    expect(prNumberFromUrl('https://github.com/o/r/pull/<baru>')).toBeNull();
  });
});

describe('alur branch (flow.ts)', () => {
  it('isHotfixBranch', () => {
    expect(isHotfixBranch('hotfix/LOGIS-1-x', ['hotfix/'])).toBe(true);
    expect(isHotfixBranch('Hotfix/LOGIS-1-x', ['hotfix/'])).toBe(true);
    expect(isHotfixBranch('feature/hotfix-x', ['hotfix/'])).toBe(false);
    expect(isHotfixBranch('fix/LOGIS-1', ['hotfix/', 'fix/'])).toBe(true);
  });
  it('leakedDevCommits = irisan commit branch & commit khusus development', () => {
    const c = (sha: string) => ({ sha, line: sha });
    expect(leakedDevCommits([c('a'), c('b')], [c('b'), c('z')]).map((x) => x.sha)).toEqual(['b']);
    expect(leakedDevCommits([c('a')], [])).toEqual([]);
  });
  it('parseMergeTree: bersih, konflik, error', () => {
    const tree = 'a'.repeat(40);
    expect(parseMergeTree(0, `${tree}\n`)).toEqual({ clean: true, conflicts: [] });
    expect(parseMergeTree(1, `${tree}\nf.txt\nsrc/a b.ts\nf.txt\n\nCONFLICT ...\n`)).toEqual({
      clean: false,
      conflicts: ['f.txt', 'src/a b.ts'],
    });
    expect(parseMergeTree(1, 'merge-tree: nope - not something we can merge\n')).toBeNull();
    expect(parseMergeTree(128, '')).toBeNull();
  });
  it('basesForChoice: production selalu didahulukan', () => {
    expect(basesForChoice('both', 'production', 'development')).toEqual(['production', 'development']);
    expect(basesForChoice('production', 'production', 'development')).toEqual(['production']);
    expect(basesForChoice('development', 'production', 'development')).toEqual(['development']);
  });
});

describe('Git: fetch, snapshot & mergeCheck (git di-mock)', () => {
  it('mergeCheck memanggil merge-tree --write-tree dan memparse konflik', async () => {
    const { runner, calls } = fakeRunner(() => ({ code: 1, stdout: `${'b'.repeat(40)}\nREADME.md\n` }));
    const r = await new Git(runner).mergeCheck('origin/development', 'abc');
    expect(r).toEqual({ clean: false, conflicts: ['README.md'] });
    expect(calls[0]?.args.slice(-6)).toEqual(['merge-tree', '--write-tree', '--name-only', '--no-messages', 'origin/development', 'abc']);
  });
  it('mergeCheck: git lama → error dengan saran update', async () => {
    const { runner } = fakeRunner(() => ({ code: 129, stderr: 'usage: git merge-tree <base-tree> <branch1> <branch2>' }));
    const err = await new Git(runner).mergeCheck('origin/development', 'abc').catch((e: unknown) => e);
    expect((err as { hint?: string }).hint).toMatch(/2\.38/);
  });
  it('snapshotCommit (mode tracked) memakai index sementara, bukan index asli', async () => {
    const { runner, calls } = fakeRunner((_c, args) => {
      if (args.includes('rev-parse')) return { stdout: 'HEADSHA\n' };
      if (args.includes('write-tree')) return { stdout: 'TREESHA\n' };
      if (args.includes('commit-tree')) return { stdout: 'SNAPSHA\n' };
      return {};
    });
    const sha = await new Git(runner).snapshotCommit({ mode: 'tracked', stageTracked: true, addUntracked: ['n.ts'], files: ['a.ts', 'n.ts'], left: [] });
    expect(sha).toBe('SNAPSHA');
    for (const c of calls.filter((c) => c.args.some((a) => ['read-tree', 'add', 'write-tree'].includes(a)))) {
      expect(c.options?.env?.GIT_INDEX_FILE).toMatch(/logis-pr-index-/);
    }
    expect(calls.find((c) => c.args.includes('commit-tree'))?.args.slice(-5)).toEqual(['TREESHA', '-p', 'HEADSHA', '-m', 'logis-pr conflict check']);
  });
  it('snapshotCommit tanpa file → HEAD apa adanya', async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: 'HEADSHA\n' }));
    expect(await new Git(runner).snapshotCommit({ mode: 'tracked', stageTracked: false, addUntracked: [], files: [], left: [] })).toBe('HEADSHA');
    expect(calls).toHaveLength(1);
  });
  it('fetch hanya memperbarui remote-tracking, meneruskan stdin untuk kredensial', async () => {
    const { runner, calls } = fakeRunner(() => ({}));
    await new Git(runner).fetch(['production', 'development']);
    expect(calls[0]?.args.slice(-6)).toEqual(['fetch', '--quiet', '--no-tags', 'origin', 'production', 'development']);
    expect(calls[0]?.options?.inheritStdin).toBe(true);
  });
});
