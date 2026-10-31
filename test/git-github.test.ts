import { describe, expect, it } from 'vitest';
import { Git, parseRemoteUrl } from '../src/git/index.js';
import { GitHub } from '../src/github/index.js';
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
  it('commitAll: git add lalu commit dengan pesan via stdin, tanpa shell', async () => {
    const { runner, calls } = fakeRunner(() => ({}));
    await new Git(runner, '/repo').commitAll('LOGIS-1: pesan "dengan" kutip & $simbol');
    expect(calls.map((c) => c.command)).toEqual(['git', 'git']);
    expect(calls[0]?.args.slice(-2)).toEqual(['add', '--all']);
    expect(calls[1]?.args.slice(-2)).toEqual(['commit', '--file=-']);
    expect(calls[1]?.options?.input).toBe('LOGIS-1: pesan "dengan" kutip & $simbol\n');
    expect(calls[1]?.options?.cwd).toBe('/repo');
  });

  it('commitAll: hook gagal → CliError berisi stderr', async () => {
    const { runner } = fakeRunner((_c, args) => (args.includes('commit') ? { code: 1, stderr: 'husky - pre-commit failed' } : {}));
    await expect(new Git(runner).commitAll('x')).rejects.toThrow(/git commit gagal:\nhusky/);
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
    expect(await new Git(fakeRunner(() => ({ stdout: ' M src/a.ts\n' })).runner).isDirty()).toBe(true);
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
