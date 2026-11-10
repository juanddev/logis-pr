/** Mode --dependent: analisis isi branch & deteksi dependensi, di repo git sungguhan (folder temp). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPr, type RunDeps, type RunOptions } from '../src/cli/run.js';
import { DEFAULT_CONFIG, type Config } from '../src/config/index.js';
import {
  analyzeDependentTicket,
  dependentRejections,
  detectDependencies,
  isDependencyIgnoredPath,
  parseDependsOnOption,
  prMergeBranch,
} from '../src/git/dependent.js';
import { Git } from '../src/git/index.js';
import { describeProblems, type IsolationContext } from '../src/git/isolation.js';
import { JiraClient } from '../src/jira/index.js';
import { DEPENDS_ON_END, DEPENDS_ON_START } from '../src/message/index.js';
import type { TeamsPayload } from '../src/teams/index.js';
import { CliError } from '../src/utils/errors.js';
import { runCommand, type Runner } from '../src/utils/exec.js';
import { ASCII_SYMBOLS, createMemoryLogger } from '../src/utils/term.js';
import { fakeGitHub, localState, makeFixture, REPO, type Fixture } from './gitfixture.js';
import { fakeJiraWorkflow } from './helpers.js';

vi.setConfig({ testTimeout: 60_000 });

const KEY = 'LOGIS-3945';
const BRANCH = 'feature/LOGIS-3945-x';
const ctx: IsolationContext = { remote: 'origin', prod: 'production', envs: ['staging', 'development'], ticketKey: KEY, ownBranches: [BRANCH] };
const scope = { remote: 'origin', prod: 'production', base: 'development', projectKey: 'LOGIS', ticketKey: KEY };

const fixtures: Fixture[] = [];
afterEach(() => {
  while (fixtures.length) fixtures.pop()?.cleanup();
});

function setup(prepare?: (fx: Fixture) => void) {
  const fx = makeFixture();
  fixtures.push(fx);
  prepare?.(fx);
  fx.g('fetch', '-q', 'origin');
  fx.g('switch', '-q', '-c', BRANCH, 'origin/development');
  return { fx, git: new Git(runCommand, fx.work) };
}

/** Merge PR ala GitHub di development: isi PR ada di commit tanpa key, key hanya di nama branch. */
function mergePr(fx: Fixture, branch: string, files: Record<string, string>, n = 12) {
  fx.s('switch', '-q', '-c', branch, 'development');
  fx.commit('perbaikan tanpa key', files, 'seed');
  fx.s('switch', '-q', 'development');
  fx.s('merge', '-q', '--no-ff', '-m', `Merge pull request #${n} from developerserasiautoraya/${branch}`, branch);
  fx.s('push', '-q', 'origin', 'development');
}

describe('dependentRejections', () => {
  const base = { branch: BRANCH, hotfix: false, requestedBases: [], dev: 'development', prod: 'production', pushTicket: false };

  it('kombinasi sah → tidak ada penolakan', () => {
    expect(dependentRejections(base)).toEqual([]);
    expect(dependentRejections({ ...base, requestedBases: ['development'] })).toEqual([]);
  });

  it.each([
    [{ hotfix: true }, /hotfix/i],
    [{ requestedBases: ['production'] }, /'production'/],
    [{ requestedBases: ['development', 'production'] }, /'production'/],
    [{ requestedBases: ['staging'] }, /'staging'/],
    [{ pushTicket: true }, /--push-ticket/],
  ])('%j ditolak', (over, re) => {
    const out = dependentRejections({ ...base, ...over });
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toMatch(re);
    expect(out[0]?.hint).toBeTruthy();
  });
});

describe('parseDependsOnOption', () => {
  const parse = (value: string) => parseDependsOnOption(value, 'LOGIS', KEY);

  it.each([
    ['LOGIS-3931', ['LOGIS-3931']],
    ['logis-3944, 3931,LOGIS-3931', ['LOGIS-3931', 'LOGIS-3944']],
    ['LOGIS-3931,LOGIS-999', ['LOGIS-999', 'LOGIS-3931']],
    ['none', []],
    [' NONE ', []],
    ['-', []],
  ])('%j → %j', (value, keys) => {
    expect(parse(value)).toEqual(keys);
  });

  it.each([
    ['', /kosong/],
    [' , ', /kosong/],
    ['ABC-1', /tidak valid/],
    ['none,LOGIS-1', /tidak valid/],
    ['LOGIS-1;LOGIS-2', /tidak valid/],
    ['logis-3945', /tiket ini sendiri/],
    ['3945,LOGIS-1', /tiket ini sendiri/],
  ])('%j ditolak', (value, re) => {
    expect(() => parse(value)).toThrow(re);
  });
});

describe('isDependencyIgnoredPath', () => {
  it.each(['documentation/a.txt', 'documentation/sub/a.ts', 'Documentation/a.txt', 'README.md', 'docs/x.md', 'src/a/b.MD'])('%s diabaikan', (f) => {
    expect(isDependencyIgnoredPath(f)).toBe(true);
  });

  it.each(['documentation.ts', 'src/documentation/x.ts', 'mydocumentation/a.txt', 'a.md.ts', 'md', 'docs/x.txt'])('%s tetap dihitung', (f) => {
    expect(isDependencyIgnoredPath(f)).toBe(false);
  });
});

describe('analyzeDependentTicket', () => {
  it('hanya commit tiket di atas development → bersih, commit development tidak ikut dihitung', async () => {
    const { fx, git } = setup();
    fx.commit('LOGIS-3945: satu', { 'a.ts': '1\n' });
    fx.commit('ver:1.0.0 tkt:LOGIS-3945 msg:dua', { 'b.ts': '2\n' });
    fx.commit('judul tanpa key\n\nRef: LOGIS-3945', { 'c.ts': '3\n' });
    const t = await analyzeDependentTicket(git, ctx, 'development', fx.g('rev-parse', 'HEAD'));
    expect(t.problems).toEqual([]);
    expect(t.commits.map((c) => c.subject)).toEqual(['LOGIS-3945: satu', 'ver:1.0.0 tkt:LOGIS-3945 msg:dua', 'judul tanpa key']);
  });

  it('commit tanpa key tiket, atau key yang hanya mirip → masalah', async () => {
    const { fx, git } = setup();
    fx.commit('LOGIS-3944: tiket lain', { 'a.ts': '1\n' });
    fx.commit('LOGIS-39450: key lebih panjang', { 'b.ts': '2\n' });
    const t = await analyzeDependentTicket(git, ctx, 'development', fx.g('rev-parse', 'HEAD'));
    expect(t.problems.map((p) => p.kind)).toEqual(['dependent-no-ticket', 'dependent-no-ticket']);
    expect(t.commits).toEqual([]);
    expect(describeProblems(t.problems).join('\n')).toMatch(/LOGIS-3944: tiket lain/);
  });

  it('merge dari origin/development = sinkronisasi', async () => {
    const { fx, git } = setup();
    fx.commit('LOGIS-3945: satu', { 'a.ts': '1\n' });
    fx.s('switch', '-q', 'development');
    fx.commit('LOGIS-3800: lanjutan dev', { 'd.ts': 'd\n' }, 'seed');
    fx.s('push', '-q', 'origin', 'development');
    fx.g('fetch', '-q', 'origin');
    fx.g('merge', '-q', '--no-edit', 'origin/development');
    const t = await analyzeDependentTicket(git, ctx, 'development', fx.g('rev-parse', 'HEAD'));
    expect(t.problems).toEqual([]);
    expect(t.syncMerges).toHaveLength(1);
    expect(t.commits).toHaveLength(1);
  });

  it('merge dari production atau branch lain → masalah', async () => {
    const { fx, git } = setup((f) => {
      f.commit('hotfix prod', { 'p.ts': 'p\n' }, 'seed');
      f.s('push', '-q', 'origin', 'production');
    });
    fx.commit('LOGIS-3945: satu', { 'a.ts': '1\n' });
    fx.g('merge', '-q', '--no-edit', 'origin/production');
    const t = await analyzeDependentTicket(git, ctx, 'development', fx.g('rev-parse', 'HEAD'));
    expect(t.problems.map((p) => p.kind)).toContain('dependent-merge');
    expect(describeProblems(t.problems).join('\n')).toMatch(/selain 'development'/);
  });

  it('subject yang juga menyebut tiket lain → peringatan saja', async () => {
    const { fx, git } = setup();
    fx.commit('LOGIS-3945: lanjutan LOGIS-3931', { 'a.ts': '1\n' });
    const t = await analyzeDependentTicket(git, ctx, 'development', fx.g('rev-parse', 'HEAD'));
    expect(t.problems).toEqual([]);
    expect(t.warnings.join('\n')).toMatch(/LOGIS-3931/);
  });
});

describe('prMergeBranch', () => {
  it.each([
    ['Merge pull request #12 from org/feature/LOGIS-1-x', 'feature/LOGIS-1-x'],
    ['Merge pull request #12 from org/LOGIS-1-dev', 'LOGIS-1-dev'],
    ['Merge branch development into LOGIS-1', null],
    ['LOGIS-1: Merge pull request #12 from org/x', null],
  ])('%s', (subject, branch) => {
    expect(prMergeBranch(subject)).toBe(branch);
  });
});

describe('detectDependencies', () => {
  const detect = async (git: Git, fx: Fixture) => {
    const t = await analyzeDependentTicket(git, ctx, 'development', fx.g('rev-parse', 'HEAD'));
    return detectDependencies(git, scope, t.commits);
  };

  it('dari pesan commit: hanya commit yang menyentuh file yang sama; urut numerik & unik', async () => {
    const { fx, git } = setup((f) => {
      f.s('switch', '-q', 'development');
      f.commit('LOGIS-999: file sama', { 'dev1.ts': 'dev 1 lagi\n' }, 'seed');
      f.commit('fix tkt:LOGIS-3931 msg:file sama', { 'dev1.ts': 'dev 1 lagi lagi\n' }, 'seed');
      f.s('push', '-q', 'origin', 'development');
    });
    fx.commit('LOGIS-3945: ubah dev1', { 'dev1.ts': 'punya tiket\n' });
    // dev2.ts/dev3.ts (LOGIS-372, LOGIS-373) tidak disentuh tiket.
    expect(await detect(git, fx)).toEqual(['LOGIS-371', 'LOGIS-999', 'LOGIS-3931']);
  });

  it('dari nama branch merge PR, walau commit di dalamnya tanpa key', async () => {
    const { fx, git } = setup((f) => mergePr(f, 'feature/LOGIS-3944-abc', { 'shared.ts': 'x\n' }));
    fx.commit('LOGIS-3945: ubah shared', { 'shared.ts': 'y\n' });
    expect(await detect(git, fx)).toEqual(['LOGIS-3944']);
  });

  it('merge PR yang tidak menyentuh file tiket → tidak dihitung', async () => {
    const { fx, git } = setup((f) => mergePr(f, 'feature/LOGIS-3944-abc', { 'lain.ts': 'x\n' }));
    fx.commit('LOGIS-3945: ubah shared', { 'shared.ts': 'y\n' });
    expect(await detect(git, fx)).toEqual([]);
  });

  it('commit di sisi merge tetap terbaca walau hasil merge TREESAME ke parent pertama (--full-history)', async () => {
    const { fx, git } = setup((f) => {
      f.s('switch', '-q', 'development');
      f.commit('LOGIS-3800: dev ubah shared', { 'shared.ts': 'x\n' }, 'seed');
      f.s('switch', '-q', '-c', 'side', 'development~1');
      f.commit('LOGIS-3801: sisi ubah shared', { 'shared.ts': 'x\n' }, 'seed');
      f.s('switch', '-q', 'development');
      f.s('merge', '-q', '--no-edit', 'side');
      f.s('push', '-q', 'origin', 'development');
    });
    fx.commit('LOGIS-3945: ubah shared', { 'shared.ts': 'y\n' });
    expect(await detect(git, fx)).toEqual(['LOGIS-3800', 'LOGIS-3801']);
  });

  it('commit yang sudah ada di production tidak dihitung; key tiket sendiri dibuang', async () => {
    const { fx, git } = setup((f) => {
      f.commit('LOGIS-3700: sudah rilis', { 'shared.ts': 'p\n' }, 'seed');
      f.s('push', '-q', 'origin', 'production');
      f.s('switch', '-q', 'development');
      f.s('merge', '-q', '--no-edit', 'production');
      f.commit('LOGIS-3945: commit sendiri lewat -dev lama', { 'shared.ts': 'q\n' }, 'seed');
      f.s('push', '-q', 'origin', 'development');
    });
    fx.commit('LOGIS-3945: ubah shared', { 'shared.ts': 'r\n' });
    expect(await detect(git, fx)).toEqual([]);
  });

  it('nama file berisi karakter glob dibaca harfiah', async () => {
    const { fx, git } = setup((f) => {
      f.s('switch', '-q', 'development');
      f.commit('LOGIS-3800: huruf a', { 'a.ts': 'x\n' }, 'seed');
      f.commit('LOGIS-3801: literal', { '[ab].ts': 'x\n' }, 'seed');
      f.s('push', '-q', 'origin', 'development');
    });
    fx.commit('LOGIS-3945: ubah literal', { '[ab].ts': 'y\n' });
    expect(await detect(git, fx)).toEqual(['LOGIS-3801']);
  });

  it('tanpa commit tiket → kosong, tanpa memanggil git log', async () => {
    const { git } = setup();
    expect(await detectDependencies(git, scope, [])).toEqual([]);
  });

  it('commit development yang hanya menyentuh dokumen yang sama → tidak dihitung', async () => {
    const docs = { 'README.md': '# dev\n', 'documentation/guide.txt': 'dev\n', 'src/notes.md': 'dev\n' };
    const { fx, git } = setup((f) => {
      f.s('switch', '-q', 'development');
      f.commit('LOGIS-3800: dokumen', docs, 'seed');
      f.s('push', '-q', 'origin', 'development');
    });
    fx.commit('LOGIS-3945: dokumen dan kode', { 'README.md': '# tiket\n', 'documentation/guide.txt': 'tiket\n', 'src/notes.md': 'tiket\n', 't.ts': 'x\n' });
    expect(await detect(git, fx)).toEqual([]);
  });

  it('tiket yang hanya menyentuh dokumen → kosong, tanpa memanggil git log', async () => {
    const { fx, git } = setup();
    fx.commit('LOGIS-3945: dokumen', { 'README.md': '# tiket\n', 'documentation/guide.ts': 'x\n' });
    const touching = vi.spyOn(git, 'commitsTouching');
    const merges = vi.spyOn(git, 'mergeCommits');
    expect(await detect(git, fx)).toEqual([]);
    expect(touching).not.toHaveBeenCalled();
    expect(merges).not.toHaveBeenCalled();
  });

  it('merge PR yang hanya menyentuh dokumen yang sama → tidak dihitung', async () => {
    const { fx, git } = setup((f) => mergePr(f, 'feature/LOGIS-3944-abc', { 'documentation/guide.txt': 'x\n', 'notes.md': 'x\n' }));
    fx.commit('LOGIS-3945: dokumen dan kode', { 'documentation/guide.txt': 'y\n', 'notes.md': 'y\n', 't.ts': 'x\n' });
    expect(await detect(git, fx)).toEqual([]);
  });

  it('commit campuran kode + dokumen tetap dihitung lewat file kodenya', async () => {
    const { fx, git } = setup((f) => {
      f.s('switch', '-q', 'development');
      f.commit('LOGIS-3800: kode dan dokumen', { 'shared.ts': 'x\n', 'README.md': '# dev\n' }, 'seed');
      f.commit('LOGIS-3801: dokumen saja', { 'README.md': '# dev lagi\n' }, 'seed');
      f.s('push', '-q', 'origin', 'development');
    });
    fx.commit('LOGIS-3945: kode dan dokumen', { 'shared.ts': 'y\n', 'README.md': '# tiket\n' });
    expect(await detect(git, fx)).toEqual(['LOGIS-3800']);
  });

  it('merge PR campuran kode + dokumen tetap dihitung lewat file kodenya', async () => {
    const { fx, git } = setup((f) => mergePr(f, 'feature/LOGIS-3944-abc', { 'shared.ts': 'x\n', 'README.md': '# pr\n' }));
    fx.commit('LOGIS-3945: kode dan dokumen', { 'shared.ts': 'y\n', 'README.md': '# tiket\n' });
    expect(await detect(git, fx)).toEqual(['LOGIS-3944']);
  });
});

describe('Git: mergeCheckReadOnly', () => {
  it('mendeteksi bersih & konflik tanpa menambah objek di repo', async () => {
    const { fx, git } = setup((f) => {
      f.s('switch', '-q', 'development');
      f.commit('LOGIS-3800: ubah app', { 'app.ts': 'a\nDEV\nc\n' }, 'seed');
      f.s('push', '-q', 'origin', 'development');
    });
    fx.g('switch', '-q', '-c', 'konflik', 'origin/production');
    fx.commit('LOGIS-3945: ubah app', { 'app.ts': 'a\nTIKET\nc\n' });
    fx.g('switch', '-q', '-c', 'bersih', 'origin/production');
    fx.commit('LOGIS-3945: file lain', { 'lain.ts': 'x\n' });
    const objects = fx.g('count-objects', '-v');
    expect(await git.mergeCheckReadOnly('origin/development', 'konflik')).toEqual({ clean: false, conflicts: ['app.ts'] });
    expect(await git.mergeCheckReadOnly('origin/development', 'bersih')).toEqual({ clean: true, conflicts: [] });
    expect(fx.g('count-objects', '-v')).toBe(objects);
  });
});

const config: Config = {
  ...DEFAULT_CONFIG,
  jiraEmail: 'dev@example.com',
  jiraApiToken: 'tok',
  teamsWebhookUrl: 'https://prod.logic.azure.com/x?sig=y',
};
const DEV_BRANCH = 'LOGIS-3945-dev';
const opts: RunOptions = { message: 'tambah fitur', jira: true, teams: true, yes: true, dependent: true };

interface WorldOpts {
  branch?: string;
  from?: string;
  /** isi commit tiket awal (default file baru t1.ts: tanpa dependensi) */
  files?: Record<string, string>;
  /** tanpa perubahan README yang belum di-commit */
  clean?: boolean;
  tamperExtraCommit?: string;
  prepare?: (fx: Fixture) => void;
}

function world(o: WorldOpts = {}) {
  const fx = makeFixture();
  fixtures.push(fx);
  o.prepare?.(fx);
  fx.g('fetch', '-q', 'origin');
  const branch = o.branch ?? BRANCH;
  fx.g('switch', '-q', '-c', branch, `origin/${o.from ?? 'development'}`);
  fx.commit('LOGIS-3945: commit lama', o.files ?? { 't1.ts': 'satu\n' });
  if (!o.clean) fx.write('README.md', '# svc\nubah\n');
  const github = fakeGitHub(fx, { tamperExtraCommit: o.tamperExtraCommit });
  const jfake = fakeJiraWorkflow('In Progress');
  const client = new JiraClient({ baseUrl: 'https://serasiautoraya.atlassian.net', email: 'e', apiToken: 't' }, jfake.fetchImpl);
  const state = { teams: [] as TeamsPayload[], notified: new Map<string, string>() };
  const gitCalls: string[][] = [];
  const recording: Runner = (c, a, op) => {
    gitCalls.push([...a]);
    return runCommand(c, a, op);
  };
  const log = createMemoryLogger();
  const deps = (extra: Partial<RunDeps> = {}): RunDeps => ({
    config,
    git: new Git(recording, fx.work),
    gh: github.gh,
    jira: {
      getIssue: async (key: string) => ({ ...(await client.getIssue(key)), key, summary: 'Ringkasan' }),
      moveToStatus: (key, target, opt) => client.moveToStatus(key, target, opt),
    },
    sendTeams: async (p) => {
      state.teams.push(p);
    },
    confirm: async (q, d) => (q.includes('memang milik') ? true : d),
    choose: async (_q, _c, d) => d,
    notified: {
      sentAt: async (url) => state.notified.get(url) ?? null,
      markSent: async (url) => {
        state.notified.set(url, '5 Nov 2026 10.00');
      },
    },
    copy: async () => true,
    log,
    symbols: ASCII_SYMBOLS,
    interactive: true,
    printResult: () => undefined,
    ...extra,
  });
  const output = () => log.lines.join('\n');
  return { fx, github, jfake, log, deps, state, gitCalls, output, branch };
}
type World = ReturnType<typeof world>;

const hasRemote = (fx: Fixture, b: string) => fx.remoteRefs().includes(`refs/heads/${b} `);

async function expectBlocked(w: World, o: RunOptions, re: RegExp, exitCode = 1): Promise<CliError> {
  const refs = w.fx.remoteRefs();
  const prs = w.github.prs.length;
  const before = localState(w.fx);
  const err = await runPr(o, w.deps()).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).message).toMatch(re);
  expect((err as CliError).exitCode).toBe(exitCode);
  expect(localState(w.fx)).toBe(before);
  expect(w.fx.remoteRefs()).toBe(refs);
  expect(w.github.prs).toHaveLength(prs);
  expect(w.github.edits).toHaveLength(0);
  expect(w.jfake.state.posts).toBe(0);
  expect(w.state.teams).toHaveLength(0);
  return err as CliError;
}

/** Baris daftar commit tiket di langkah [1/5], tanpa prefix logger. */
function commitList(w: World): string[] {
  const from = w.log.lines.findIndex((l) => /commit tiket:$/.test(l));
  expect(from).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (const l of w.log.lines.slice(from + 1)) {
    if (!l.startsWith('dim: ')) break;
    out.push(l.slice('dim: '.length).trim());
  }
  return out;
}

const shadowCommits = (w: World) => w.gitCalls.filter((a) => a.includes('commit-tree'));

describe('daftar commit tiket & commit bayangan', () => {
  const line = (w: World, rev = 'HEAD') => w.fx.g('log', '-1', '--format=%h %s', rev);

  it('regresi: tanpa -m dan tree bersih → daftar berakhir di SHA HEAD, tanpa "(commit baru)" dan tanpa commit bayangan', async () => {
    const w = world({ clean: true });
    w.fx.commit('LOGIS-3945: commit kedua', { 't2.ts': 'dua\n' });
    const res = await runPr({ ...opts, message: undefined }, w.deps());
    expect(commitList(w)).toEqual([line(w, 'HEAD~1'), line(w)]);
    expect(commitList(w).at(-1)).toMatch(/^[0-9a-f]{7,} LOGIS-3945: commit kedua$/);
    expect(w.output()).not.toContain('commit baru');
    expect(shadowCommits(w)).toEqual([]);
    expect(res.committed).toBe(false);
  });

  it('-m tanpa file yang bisa di-commit → tanpa label dan tanpa commit bayangan', async () => {
    const w = world({ clean: true });
    const res = await runPr(opts, w.deps());
    expect(commitList(w)).toEqual([line(w)]);
    expect(shadowCommits(w)).toEqual([]);
    expect(res.committed).toBe(false);
    expect(w.output()).toContain('pesan -m diabaikan');
  });

  it('-m dengan perubahan → commit bayangan dibuat dan berlabel di baris terakhir', async () => {
    const w = world();
    const lama = line(w);
    const res = await runPr(opts, w.deps());
    expect(commitList(w)).toEqual([lama, '(commit baru) LOGIS-3945: tambah fitur']);
    expect(shadowCommits(w)).toHaveLength(1);
    expect(res.committed).toBe(true);
  });

  it('--dry-run tanpa -m → daftar berakhir di SHA HEAD, tanpa commit bayangan', async () => {
    const w = world({ clean: true });
    await runPr({ ...opts, message: undefined, dryRun: true }, w.deps());
    expect(commitList(w)).toEqual([line(w)]);
    expect(shadowCommits(w)).toEqual([]);
  });

  it('jalur normal --dry-run tanpa -m → daftar & rencana cherry-pick memakai SHA HEAD', async () => {
    const w = world({ from: 'production', clean: true });
    const short = w.fx.g('log', '-1', '--format=%h');
    await runPr({ ...opts, dependent: false, message: undefined, dryRun: true }, w.deps());
    expect(commitList(w)).toEqual([line(w)]);
    expect(w.output()).not.toContain('commit baru');
    expect(w.output()).toContain(`cherry-pick -x: ${short}`);
    expect(shadowCommits(w)).toEqual([]);
  });
});

describe('alur --dependent', () => {
  it('branch berbasis development berisi commit tiket saja → PR dari branch tiket, tanpa -dev, push tanpa force', async () => {
    const w = world();
    const res = await runPr(opts, w.deps());
    expect(res.prs).toEqual([expect.objectContaining({ head: BRANCH, base: 'development', created: true })]);
    expect(w.fx.b('rev-parse', `refs/heads/${BRANCH}`)).toBe(w.fx.g('rev-parse', 'HEAD'));
    expect(w.fx.g('log', '-1', '--format=%s')).toBe('LOGIS-3945: tambah fitur');
    expect(hasRemote(w.fx, DEV_BRANCH)).toBe(false);
    expect(w.fx.g('for-each-ref', '--format=%(refname:short)', 'refs/heads')).not.toContain(DEV_BRANCH);
    const pushes = w.gitCalls.filter((a) => a.includes('push'));
    expect(pushes.length).toBeGreaterThan(0);
    for (const a of pushes) expect(a.join(' ')).not.toMatch(/--force|\s-f\b|\s\+/);
    expect(w.output()).toContain('ok: Isi PR di GitHub cocok dengan validasi lokal.');
    expect(res.reviewers).toBe('requested');
    expect(res.jira).toBe('moved');
    expect(res.teams).toBe('sent');
    expect(res.dependsOn).toEqual([]);
  });

  it('dijalankan ulang: PR dipakai ulang, tidak ada edit body, Jira & Teams tidak dobel', async () => {
    const w = world({ files: { 'dev1.ts': 'punya tiket\n' } });
    await runPr(opts, w.deps());
    const again = await runPr({ ...opts, message: undefined }, w.deps());
    expect(again.prCreated).toBe(false);
    expect(w.github.prs).toHaveLength(1);
    expect(w.github.edits).toHaveLength(0);
    expect(again.jira).toBe('already');
    expect(again.teams).toBe('already-sent');
    expect(w.state.teams).toHaveLength(1);
  });

  it('merge sinkronisasi dari origin/development diizinkan sampai PR terverifikasi', async () => {
    const w = world({ clean: true });
    w.fx.s('switch', '-q', 'development');
    w.fx.commit('LOGIS-3800: lanjutan', { 'lanjut.ts': 'x\n' }, 'seed');
    w.fx.s('push', '-q', 'origin', 'development');
    w.fx.g('fetch', '-q', 'origin');
    w.fx.g('merge', '-q', '--no-edit', 'origin/development');
    const res = await runPr({ ...opts, message: undefined }, w.deps());
    expect(res.prs).toHaveLength(1);
    expect(w.output()).toContain('merge sinkronisasi dari development');
  });

  it('format commit tim (ver/tkt/msg) dipakai apa adanya dan lolos cek key', async () => {
    const w = world();
    const msg = 'ver:1.0.0 tkt:LOGIS-3945 msg:tambah';
    await runPr({ ...opts, message: msg }, w.deps());
    expect(w.fx.g('log', '-1', '--format=%s')).toBe(msg);
  });

  it('ada commit tiket lain di base..HEAD → exit 1 tanpa efek samping, commit bermasalah ditampilkan', async () => {
    const w = world({ clean: true });
    w.fx.commit('LOGIS-3944: tiket lain', { 'x.ts': 'x\n' });
    const err = await expectBlocked(w, { ...opts, message: undefined }, /bukan milik tiket/);
    expect(w.output()).toMatch(/LOGIS-3944: tiket lain/);
    expect(err.hint).toMatch(/origin\/development/);
  });

  it('commit -m ikut divalidasi: tetap berhenti sebelum commit bila ada commit asing', async () => {
    const w = world();
    w.fx.g('stash', '-q');
    w.fx.commit('tanpa key', { 'x.ts': 'x\n' });
    w.fx.g('stash', 'pop', '-q');
    await expectBlocked(w, opts, /bukan milik tiket/);
  });

  it('merge dari branch selain development → exit 1 tanpa efek samping', async () => {
    const w = world({ clean: true });
    w.fx.g('merge', '-q', '--no-edit', 'origin/LOGIS-3920');
    await expectBlocked(w, { ...opts, message: undefined }, /bukan milik tiket/);
    expect(w.output()).toMatch(/selain 'development'/);
  });

  it.each([
    ['-b production', { base: 'production' }, /'production'/],
    ['-b development,production', { base: 'development,production' }, /'production'/],
    ['-b staging', { base: 'staging' }, /'staging'/],
    ['--push-ticket', { pushTicket: true }, /--push-ticket/],
  ])('%s ditolak sebelum efek samping', async (_n, over, re) => {
    await expectBlocked(world(), { ...opts, ...over }, re);
  });

  it('-b development diterima', async () => {
    const res = await runPr({ ...opts, base: 'development' }, world().deps());
    expect(res.prs[0]?.base).toBe('development');
  });

  it('branch hotfix ditolak sebelum memilih target', async () => {
    const w = world({ branch: 'hotfix/LOGIS-3945-x' });
    await expectBlocked(w, opts, /hotfix/i);
  });

  it('PR -dev masih open ke development → ditolak, menyarankan menutup salah satu', async () => {
    const w = world();
    w.github.prs.push({ number: 800, url: `https://github.com/${REPO}/pull/800`, title: 'lama', isDraft: false, baseRefName: 'development', headRefName: DEV_BRANCH });
    const err = await expectBlocked(w, opts, /Sudah ada PR open dari 'LOGIS-3945-dev'/);
    expect(err.hint).toMatch(/Tutup salah satu/);
  });

  it('konflik ke development → exit 2, saran merge di branch tiket, tanpa catatan baseline', async () => {
    const w = world();
    w.fx.s('switch', '-q', 'development');
    w.fx.commit('LOGIS-3799: ubah app', { 'app.ts': 'a\nDEV\nc\n' }, 'seed');
    w.fx.s('push', '-q', 'origin', 'development');
    w.fx.write('app.ts', 'a\nTIKET\nc\n');
    const err = await expectBlocked(w, opts, /konflik/, 2);
    expect(w.output()).toMatch(/app\.ts/);
    expect(err.hint).toMatch(/git merge origin\/development/);
    expect(w.output()).not.toMatch(/baseline/);
  });

  it('isi PR di GitHub berbeda → exit 3, reviewer/Jira/Teams/edit body tidak jalan', async () => {
    const w = world({ tamperExtraCommit: 'deadbeef'.repeat(5) });
    const err = await runPr(opts, w.deps()).catch((e: unknown) => e);
    expect((err as CliError).exitCode).toBe(3);
    expect(w.github.reviewers.size).toBe(0);
    expect(w.jfake.state.posts).toBe(0);
    expect(w.state.teams).toHaveLength(0);
    expect(w.github.edits).toHaveLength(0);
  });

  it('branch belum punya commit di luar development → exit 1', async () => {
    const w = world({ clean: true });
    w.fx.g('reset', '-q', '--hard', 'origin/development');
    await expectBlocked(w, { ...opts, message: undefined }, /belum punya commit tiket di luar 'development'/);
  });
});

describe('--dependent: dependensi di output, body PR, dan Teams', () => {
  const section = (b = '') => b.slice(b.indexOf(DEPENDS_ON_START), b.indexOf(DEPENDS_ON_END));

  it('PR baru memuat bagian depends-on sejak dibuat, tanpa edit tambahan', async () => {
    const w = world({ files: { 'dev1.ts': 'punya tiket\n' } });
    const res = await runPr(opts, w.deps());
    expect(res.dependsOn).toEqual(['LOGIS-371']);
    expect(w.output()).toMatch(/Dependensi terdeteksi .*LOGIS-371/);
    expect(section(w.github.prs[0]?.body)).toContain('[LOGIS-371](https://serasiautoraya.atlassian.net/browse/LOGIS-371)');
    expect(section(w.github.prs[0]?.body)).toMatch(/tidak bisa naik ke production sebelum dependensinya rilis/);
    expect(w.github.prs[0]?.body).toContain('Tiket: [LOGIS-3945]');
    expect(w.github.edits).toHaveLength(0);
  });

  it('tanpa dependensi → body tanpa bagian, tanpa edit', async () => {
    const w = world();
    await runPr(opts, w.deps());
    expect(w.github.prs[0]?.body).not.toContain(DEPENDS_ON_START);
    expect(w.github.edits).toHaveLength(0);
  });

  it('PR yang sudah ada: bagian ditambah, lalu hanya bagian itu yang diganti saat dependensi berubah', async () => {
    const baris = (awal: string, akhir: string) => `${awal}\n${'isi\n'.repeat(8)}${akhir}\n`;
    const w = world({
      clean: true,
      files: { 'shared.ts': baris('TIKET', 'akhir') },
      prepare: (f) => {
        f.s('switch', '-q', 'development');
        f.commit('LOGIS-3900: buat shared', { 'shared.ts': baris('awal', 'akhir') }, 'seed');
        f.s('push', '-q', 'origin', 'development');
      },
    });
    w.fx.g('push', '-q', 'origin', BRANCH);
    const asli = 'Tulisan reviewer\r\n\r\nJangan diubah\r\n';
    await w.github.gh.createPr({ repo: REPO, base: 'development', head: BRANCH, title: 'lama', body: asli });

    await runPr({ ...opts, message: undefined }, w.deps());
    expect(w.github.edits).toHaveLength(1);
    const pertama = w.github.prs[0]?.body ?? '';
    expect(pertama.startsWith(asli)).toBe(true);
    expect(section(pertama)).toContain('LOGIS-3900');
    expect(section(pertama)).not.toContain('LOGIS-3931');

    // Tiket lain menyentuh file yang sama (baris lain, jadi tidak konflik), lalu dijalankan ulang.
    w.fx.commit('LOGIS-3931: file sama', { 'shared.ts': baris('awal', 'DARI 3931') }, 'seed');
    w.fx.s('push', '-q', 'origin', 'development');
    await runPr({ ...opts, message: undefined }, w.deps());
    expect(w.github.edits).toHaveLength(2);
    const kedua = w.github.prs[0]?.body ?? '';
    expect(kedua.startsWith(asli)).toBe(true);
    expect(section(kedua)).toContain('LOGIS-3931');
    expect(kedua.split(DEPENDS_ON_START)).toHaveLength(2);

    // Dijalankan ulang tanpa perubahan → tidak ada request edit.
    await runPr({ ...opts, message: undefined }, w.deps());
    expect(w.github.edits).toHaveLength(2);
  });

  it('penanda rusak → warning, body tidak disentuh, proses lanjut', async () => {
    const w = world({ files: { 'dev1.ts': 'punya tiket\n' }, clean: true });
    w.fx.g('push', '-q', 'origin', BRANCH);
    const rusak = `isi ${DEPENDS_ON_START} tanpa penutup`;
    await w.github.gh.createPr({ repo: REPO, base: 'development', head: BRANCH, title: 'lama', body: rusak });
    const res = await runPr({ ...opts, message: undefined }, w.deps());
    expect(w.github.prs[0]?.body).toBe(rusak);
    expect(w.github.edits).toHaveLength(0);
    expect(w.log.lines.some((l) => l.startsWith('warn:') && l.includes('Penanda depends-on'))).toBe(true);
    expect(res.teams).toBe('sent');
  });

  it('gagal memperbarui body → warning, Jira & Teams tetap jalan', async () => {
    const w = world({ files: { 'dev1.ts': 'punya tiket\n' }, clean: true });
    w.fx.g('push', '-q', 'origin', BRANCH);
    await w.github.gh.createPr({ repo: REPO, base: 'development', head: BRANCH, title: 'lama', body: 'x' });
    const gh = { ...w.github.gh, editPrBody: async () => Promise.reject(new CliError('HTTP 403')) };
    const res = await runPr({ ...opts, message: undefined }, w.deps({ gh }));
    expect(w.log.lines.some((l) => l.startsWith('warn:') && l.includes('HTTP 403'))).toBe(true);
    expect(res.teams).toBe('sent');
  });

  it('Teams: format standar walau ada dependensi, tidak terkirim ulang dengan -y, kunci state tetap URL PR', async () => {
    const w = world({ files: { 'dev1.ts': 'punya tiket\n' } });
    const res = await runPr(opts, w.deps());
    expect(res.dependsOn).toEqual(['LOGIS-371']);
    const lines = (w.state.teams[0]?.text ?? '').split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^Task: Review PR LOGIS-\d+$/);
    expect(lines[1]).toMatch(/^Desc: /);
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe(`PR: ${res.prUrl}`);
    expect(lines[4]).toMatch(/^Tiket: /);
    expect(w.state.teams[0]?.text).not.toContain('Depends on');
    expect(w.state.teams[0]?.html).not.toContain('Depends on');
    expect([...w.state.notified.keys()]).toEqual([res.prUrl]);
    const again = await runPr({ ...opts, message: undefined }, w.deps());
    expect(again.teams).toBe('already-sent');
    expect(w.state.teams).toHaveLength(1);
  });

  it('Teams: tanpa dependensi → tidak ada baris Depends on', async () => {
    const w = world();
    await runPr(opts, w.deps());
    expect(w.state.teams[0]?.text).not.toContain('Depends on');
    expect(w.state.teams[0]?.html).not.toContain('Depends on');
  });

  it('--dry-run: dependensi tampil; tidak ada commit, push, PR, edit, transisi, maupun pesan', async () => {
    const w = world({ files: { 'dev1.ts': 'punya tiket\n' } });
    const before = localState(w.fx);
    const refs = w.fx.remoteRefs();
    const res = await runPr({ ...opts, dryRun: true }, w.deps());
    expect(localState(w.fx)).toBe(before);
    expect(w.fx.remoteRefs()).toBe(refs);
    expect(w.github.prs).toHaveLength(0);
    expect(w.github.edits).toHaveLength(0);
    expect(w.jfake.state.posts).toBe(0);
    expect(w.state.teams).toHaveLength(0);
    expect(res.dependsOn).toEqual(['LOGIS-371']);
    expect(w.output()).toMatch(/Dependensi terdeteksi .*LOGIS-371/);
    expect(w.output()).toMatch(/\[dry-run\] PR baru akan memuat bagian depends-on: LOGIS-371/);
    expect(w.output()).toContain(`[dry-run] Akan membuat PR ${BRANCH} → development`);
    // Preview pesan Teams memakai format standar (tanpa baris Depends on).
    expect(w.output()).not.toContain('Depends on:');
    expect(w.gitCalls.some((a) => a.includes('push'))).toBe(false);
  });

  it('--dry-run pada PR yang sudah ada: melaporkan rencana, tanpa request edit', async () => {
    const w = world({ files: { 'dev1.ts': 'punya tiket\n' }, clean: true });
    w.fx.g('push', '-q', 'origin', BRANCH);
    await w.github.gh.createPr({ repo: REPO, base: 'development', head: BRANCH, title: 'lama', body: 'x' });
    await runPr({ ...opts, message: undefined, dryRun: true }, w.deps());
    expect(w.github.edits).toHaveLength(0);
    expect(w.github.prs[0]?.body).toBe('x');
    expect(w.output()).toMatch(/\[dry-run\] Bagian depends-on di PR #901 akan ditambahkan/);
  });
});

describe('--depends-on menimpa hasil deteksi', () => {
  const section = (b = '') => b.slice(b.indexOf(DEPENDS_ON_START), b.indexOf(DEPENDS_ON_END));
  const detected = { files: { 'dev1.ts': 'punya tiket\n' } }; // tanpa override: LOGIS-371
  const ranDetection = (w: World) => w.gitCalls.some((a) => a.includes('--full-history'));

  it('dengan commit -m: hasil & body PR hanya memuat override, Teams tetap format standar; deteksi tidak dijalankan', async () => {
    const w = world(detected);
    const res = await runPr({ ...opts, dependsOn: 'logis-3944, 3931' }, w.deps());
    expect(res.committed).toBe(true);
    expect(res.dependsOn).toEqual(['LOGIS-3931', 'LOGIS-3944']);
    expect(section(w.github.prs[0]?.body)).toContain('[LOGIS-3931]');
    expect(section(w.github.prs[0]?.body)).toContain('[LOGIS-3944]');
    expect(section(w.github.prs[0]?.body)).not.toContain('LOGIS-371');
    expect(w.state.teams[0]?.text.split('\n').at(-1)).toMatch(/^Tiket: /);
    expect(w.state.teams[0]?.text).not.toContain('Depends on');
    expect(w.github.edits).toHaveLength(0);
    expect(ranDetection(w)).toBe(false);
    expect(w.output()).toContain('Dependensi dari --depends-on (deteksi dilewati): LOGIS-3931, LOGIS-3944');
    expect(w.output()).not.toContain('Dependensi terdeteksi');
  });

  it('tanpa override, kasus yang sama tetap memakai deteksi', async () => {
    const w = world(detected);
    const res = await runPr(opts, w.deps());
    expect(res.dependsOn).toEqual(['LOGIS-371']);
    expect(ranDetection(w)).toBe(true);
  });

  it('none pada PR baru: tanpa bagian depends-on dan tanpa baris Teams', async () => {
    const w = world(detected);
    const res = await runPr({ ...opts, dependsOn: 'none' }, w.deps());
    expect(res.dependsOn).toEqual([]);
    expect(w.github.prs[0]?.body).not.toContain(DEPENDS_ON_START);
    expect(w.state.teams[0]?.text).not.toContain('Depends on');
    expect(ranDetection(w)).toBe(false);
    expect(w.output()).toContain('Dependensi dari --depends-on (deteksi dilewati): tidak ada');
  });

  it('none pada PR yang sudah punya bagian depends-on: isinya diganti', async () => {
    const w = world({ ...detected, clean: true });
    await runPr({ ...opts, message: undefined }, w.deps());
    expect(section(w.github.prs[0]?.body)).toContain('LOGIS-371');
    await runPr({ ...opts, message: undefined, dependsOn: 'none' }, w.deps());
    expect(w.github.edits).toHaveLength(1);
    expect(section(w.github.prs[0]?.body)).not.toContain('LOGIS-371');
    expect(section(w.github.prs[0]?.body)).toContain('Tidak ada dependensi');
  });

  it('--dry-run menampilkan override tanpa efek samping', async () => {
    const w = world(detected);
    const before = localState(w.fx);
    const res = await runPr({ ...opts, dryRun: true, dependsOn: 'LOGIS-3931' }, w.deps());
    expect(res.dependsOn).toEqual(['LOGIS-3931']);
    expect(localState(w.fx)).toBe(before);
    expect(w.github.prs).toHaveLength(0);
    expect(w.output()).toContain('[dry-run] PR baru akan memuat bagian depends-on: LOGIS-3931');
    expect(w.output()).not.toContain('Depends on:');
  });

  it.each([
    ['tanpa --dependent', { dependent: false, dependsOn: 'LOGIS-3931' }, /hanya berlaku bersama --dependent/],
    ['tanpa --dependent, nilai none', { dependent: false, dependsOn: 'none' }, /hanya berlaku bersama --dependent/],
    ['key tidak valid', { dependsOn: 'ABC-1' }, /tidak valid/],
    ['key tiket sendiri', { dependsOn: 'LOGIS-3945' }, /tiket ini sendiri/],
    ['string kosong', { dependsOn: '' }, /kosong/],
  ])('%s → ditolak sebelum efek samping', async (_n, over, re) => {
    await expectBlocked(world(detected), { ...opts, ...over }, re);
  });
});

describe('jalur normal: saran --dependent', () => {
  const normal: RunOptions = { ...opts, dependent: false };
  const conflicting = { files: { 'dev1.ts': 'punya tiket\n' } };

  it('cherry-pick ke production konflik → saran --dependent + dependensi; error & exit code tetap', async () => {
    const w = world({ ...conflicting, clean: true });
    const err = await expectBlocked(w, { ...normal, message: undefined }, /branch tiket membawa commit yang bukan milik tiket/);
    expect(err.hint).toMatch(/bergantung pada kode development/);
    expect(err.hint).toMatch(/logis-pr --dependent/);
    expect(err.hint).toMatch(/dev1\.ts/);
    expect(err.hint).toMatch(/Dependensi terdeteksi: LOGIS-371/);
    expect(w.fx.g('worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('cherry-pick ke production bersih → hanya saran lama', async () => {
    const w = world({ clean: true });
    const err = await expectBlocked(w, { ...normal, message: undefined }, /bukan milik tiket/);
    expect(err.hint).not.toMatch(/--dependent/);
    expect(err.hint).toMatch(/git cherry-pick <sha commit Anda>/);
    expect(w.gitCalls.some((a) => a.includes('worktree'))).toBe(true);
  });

  it('perubahan yang akan di-commit (-m) ikut disimulasikan', async () => {
    const w = world({ clean: true });
    w.fx.write('dev1.ts', 'diubah\n');
    const err = await expectBlocked(w, normal, /bukan milik tiket/);
    expect(err.hint).toMatch(/logis-pr --dependent/);
  });

  it.each([
    ['-b production', { branch: BRANCH }, { base: 'production' }],
    ['branch hotfix', { branch: 'hotfix/LOGIS-3945-x' }, {}],
  ])('%s → tidak disarankan, karena --dependent akan ditolak', async (_n, w0, over) => {
    const w = world({ ...conflicting, ...w0, clean: true });
    const err = await expectBlocked(w, { ...normal, ...over, message: undefined }, /bukan milik tiket/);
    expect(err.hint).not.toMatch(/--dependent/);
  });

  it('masalah bukan dari development/staging → tanpa simulasi, saran lama', async () => {
    const w = world({ from: 'production', clean: true });
    w.fx.g('merge', '-q', '--no-edit', 'origin/LOGIS-3920');
    const err = await expectBlocked(w, { ...normal, message: undefined }, /bukan milik tiket/);
    expect(err.hint).not.toMatch(/--dependent/);
    expect(w.gitCalls.some((a) => a.includes('worktree'))).toBe(false);
  });

  it('--dry-run: saran tetap muncul, repo tidak berubah', async () => {
    const w = world({ ...conflicting, clean: true });
    const err = await expectBlocked(w, { ...normal, message: undefined, dryRun: true }, /bukan milik tiket/);
    expect(err.hint).toMatch(/logis-pr --dependent/);
  });

  it('simulasi gagal total → saran lama, hasil validasi tidak berubah', async () => {
    const w = world({ ...conflicting, clean: true });
    const base = w.deps();
    const git = Object.create(base.git) as RunDeps['git'];
    git.replayDetached = async () => Promise.reject(new CliError('worktree gagal'));
    const err = (await runPr({ ...normal, message: undefined }, { ...base, git }).catch((e: unknown) => e)) as CliError;
    expect(err.exitCode).toBe(1);
    expect(err.message).toMatch(/bukan milik tiket/);
    expect(err.hint).not.toMatch(/--dependent/);
  });
});
