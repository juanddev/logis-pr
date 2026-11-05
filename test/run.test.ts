/**
 * Test orkestrasi dengan repo git SUNGGUHAN (folder temp). GitHub, Jira, dan Teams tiruan.
 * Fokus: PR tercemar tidak mungkin terjadi — regresi untuk kasus "PR berisi puluhan commit / ratusan file".
 */
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Repo git sungguhan: lebih lambat dari test mock (terutama di Windows).
vi.setConfig({ testTimeout: 60_000 });
import { runAudit } from '../src/cli/audit.js';
import { runPr, type RunDeps, type RunOptions } from '../src/cli/run.js';
import { DEFAULT_CONFIG, type Config } from '../src/config/index.js';
import { Git } from '../src/git/index.js';
import { JiraClient } from '../src/jira/index.js';
import type { TeamsPayload } from '../src/teams/index.js';
import { CliError } from '../src/utils/errors.js';
import { runCommand } from '../src/utils/exec.js';
import { ASCII_SYMBOLS, createMemoryLogger } from '../src/utils/term.js';
import { fakeGitHub, localState, makeFixture, REPO, type Fixture } from './gitfixture.js';
import { fakeJiraWorkflow } from './helpers.js';

const SUMMARY = '[Backend] Enhance Bulk Last Route Location Response';
const BRANCH = 'feature/LOGIS-3938-bulk-last-route';
const DEV = 'LOGIS-3938-dev';
const config: Config = {
  ...DEFAULT_CONFIG,
  jiraEmail: 'dev@example.com',
  jiraApiToken: 'tok',
  teamsWebhookUrl: 'https://prod.logic.azure.com/x?sig=y',
};

const fixtures: Fixture[] = [];
afterEach(() => {
  while (fixtures.length) fixtures.pop()?.cleanup();
});

interface WorldOpts {
  branch?: string;
  /** branch asal di remote (default production) */
  from?: string;
  /** tanpa commit tiket awal */
  empty?: boolean;
  /** tanpa perubahan README yang belum di-commit */
  clean?: boolean;
  status?: string;
  tamperExtraCommit?: string;
  config?: Partial<Config>;
}

function world(o: WorldOpts = {}) {
  const fx = makeFixture();
  fixtures.push(fx);
  const branch = o.branch ?? BRANCH;
  fx.g('switch', '-q', '-c', branch, `origin/${o.from ?? 'production'}`);
  if (!o.empty) fx.commit('LOGIS-3938: commit lama', { 't1.ts': 'satu\n' });
  if (!o.clean) fx.write('README.md', '# svc\nubah\n');
  const github = fakeGitHub(fx, { tamperExtraCommit: o.tamperExtraCommit });
  const jfake = fakeJiraWorkflow(o.status ?? 'In Progress');
  const client = new JiraClient({ baseUrl: 'https://serasiautoraya.atlassian.net', email: 'e', apiToken: 't' }, jfake.fetchImpl);
  const state = { teams: [] as TeamsPayload[], copied: [] as string[], notified: new Map<string, string>() };
  const jira = {
    getIssue: async (key: string) => ({ ...(await client.getIssue(key)), key, summary: SUMMARY }),
    moveToStatus: vi.fn((key: string, target: string, opt?: Parameters<JiraClient['moveToStatus']>[2]) =>
      client.moveToStatus(key, target, opt),
    ),
  };
  const git = new Git(runCommand, fx.work);
  const log = createMemoryLogger();
  const deps = (extra: Partial<RunDeps> = {}): RunDeps => ({
    config: { ...config, ...o.config },
    git,
    gh: github.gh,
    jira,
    sendTeams: async (p) => {
      state.teams.push(p);
    },
    // Enter = default, kecuali konfirmasi allowlist commit (developer menjawab "y").
    confirm: async (q, d) => (q.includes('memang milik') ? true : d),
    choose: async (_q, _c, d) => d,
    notified: {
      sentAt: async (url) => state.notified.get(url) ?? null,
      markSent: async (url) => {
        state.notified.set(url, '2 Nov 2026 10.00');
      },
    },
    copy: async (t) => {
      state.copied.push(t);
      return true;
    },
    log,
    symbols: ASCII_SYMBOLS,
    interactive: true,
    printResult: () => undefined,
    ...extra,
  });
  const fails = () => log.lines.filter((l) => l.startsWith('fail:')).join('\n');
  return { fx, git, github, jfake, jira, log, deps, state, fails, branch };
}
type World = ReturnType<typeof world>;

const baseOpts: RunOptions = { message: 'tambah enrichment', jira: true, teams: true, yes: true };
const devRange = (fx: Fixture, ref = `origin/${DEV}`) =>
  fx.g('log', '--format=%s', `origin/production..${ref}`).split('\n').filter(Boolean);
const changed = (fx: Fixture, ref = 'HEAD') => fx.g('show', '--name-only', '--format=', ref).split('\n').filter(Boolean).sort();
const wtDirs = () => readdirSync(os.tmpdir()).filter((d) => d.startsWith('logis-pr-wt-')).length;

/** Harus berhenti dengan CliError dan TIDAK ada efek samping eksternal sama sekali. */
async function expectBlocked(w: World, opts: RunOptions, re: RegExp, exitCode = 1): Promise<CliError> {
  const before = w.fx.remoteRefs();
  const err = await runPr(opts, w.deps()).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).message).toMatch(re);
  expect((err as CliError).exitCode).toBe(exitCode);
  expect(w.fx.remoteRefs()).toBe(before); // tidak ada push
  expect(w.github.prs).toHaveLength(0);
  expect(w.jfake.state.posts).toBe(0);
  expect(w.state.teams).toHaveLength(0);
  return err as CliError;
}

/** Commit di branch tiket tanpa mengganggu perubahan README yang belum di-commit. */
function withStash(w: World, fn: () => void) {
  w.fx.g('stash', '-q');
  fn();
  w.fx.g('stash', 'pop', '-q');
}

describe('alur utama: branch tiket dari production → LOGIS-XXXX-dev → development', () => {
  it('membuat -dev dari production berisi cherry-pick -x commit tiket saja, lalu PR -dev → development', async () => {
    const w = world();
    const oldCommit = w.fx.g('rev-parse', 'HEAD');
    const res = await runPr(baseOpts, w.deps());

    expect(res.prs).toEqual([expect.objectContaining({ base: 'development', head: DEV, created: true })]);
    expect(devRange(w.fx)).toEqual(['LOGIS-3938: tambah enrichment', 'LOGIS-3938: commit lama']);
    expect(w.fx.g('log', '-1', '--format=%B', `origin/${DEV}~1`)).toContain(`(cherry picked from commit ${oldCommit})`);
    // Isi PR versi GitHub (dihitung di repo bare): 2 commit tiket, 2 file tiket.
    expect(w.fx.b('rev-list', '--count', `refs/heads/${DEV}`, '^refs/heads/development')).toBe('2');
    expect(w.fx.b('diff', '--name-only', `refs/heads/development...refs/heads/${DEV}`).split('\n').sort()).toEqual(['README.md', 't1.ts']);
    // Branch tiket tetap production + commit tiket; tetap checkout di branch tiket; tidak ada worktree sisa.
    expect(w.fx.g('rev-list', '--count', 'HEAD', '^origin/production')).toBe('2');
    expect(w.fx.g('rev-list', '--count', 'origin/development', '^HEAD', '^origin/production')).toBe('3');
    expect(w.fx.g('symbolic-ref', '--short', 'HEAD')).toBe(BRANCH);
    expect(w.fx.g('worktree', 'list').split('\n')).toHaveLength(1);
    expect(res.jira).toBe('moved');
    expect(w.state.teams[0]?.text).toContain(`PR: https://github.com/${REPO}/pull/901`);
    expect(w.log.lines).toContain('ok: Isi PR di GitHub cocok dengan validasi lokal.');
  });

  it('dijalankan ulang: tidak ada cherry-pick ganda, -dev tidak berubah, PR/Jira/Teams tidak dobel', async () => {
    const w = world();
    await runPr(baseOpts, w.deps());
    const devSha = w.fx.b('rev-parse', `refs/heads/${DEV}`);
    const again = await runPr({ ...baseOpts, message: undefined }, w.deps());
    expect(w.fx.b('rev-parse', `refs/heads/${DEV}`)).toBe(devSha);
    expect(again.prCreated).toBe(false);
    expect(again.teams).toBe('already-sent');
    expect(again.jira).toBe('already');
    expect(w.github.prs).toHaveLength(1);
    expect(w.log.lines.some((l) => l.includes('0 commit di-cherry-pick, 2 sudah ada'))).toBe(true);
  });

  it('commit tiket baru setelah PR ada → -dev maju fast-forward dengan tepat 1 cherry-pick', async () => {
    const w = world();
    await runPr(baseOpts, w.deps());
    const old = w.fx.b('rev-parse', `refs/heads/${DEV}`);
    w.fx.write('t2.ts', 'dua\n');
    w.fx.g('add', 't2.ts');
    const res = await runPr({ ...baseOpts, message: 'tambah t2' }, w.deps());
    expect(res.prCreated).toBe(false);
    expect(w.fx.b('rev-parse', `refs/heads/${DEV}~1`)).toBe(old);
    expect(devRange(w.fx)).toEqual(['LOGIS-3938: tambah t2', 'LOGIS-3938: tambah enrichment', 'LOGIS-3938: commit lama']);
  });

  it('format commit tim (ver/tkt/msg) dipakai apa adanya', async () => {
    const w = world();
    const msg = 'ver:1.0.0 tkt:LOGIS-3938 msg:add guide';
    await runPr({ ...baseOpts, message: msg }, w.deps());
    expect(w.fx.g('log', '-1', '--format=%s')).toBe(msg);
    expect(w.github.prs[0]?.title).toBe(msg);
  });

  it('konfirmasi daftar commit ditolak → tidak ada commit, branch, push, maupun PR', async () => {
    const w = world();
    const before = localState(w.fx);
    const err = await runPr(
      { ...baseOpts, yes: false },
      w.deps({ confirm: async (q, d) => (q.includes('memang milik') ? false : d) }),
    ).catch((e: unknown) => e);
    expect((err as CliError).message).toMatch(/tidak dikonfirmasi/);
    expect(localState(w.fx)).toBe(before);
    expect(w.github.prs).toHaveLength(0);
  });

  it('commit tiket yang sudah masuk development (lewat -dev lama) tidak dianggap pencemaran dan tidak di-pick ulang', async () => {
    const w = world();
    await runPr(baseOpts, w.deps());
    // PR -dev di-merge ke development; -dev dihapus di remote & lokal.
    w.fx.s('fetch', '-q', 'origin');
    w.fx.s('switch', '-q', 'development');
    w.fx.s('merge', '-q', '--no-ff', '-m', 'Merge PR', `origin/${DEV}`);
    w.fx.s('push', '-q', 'origin', 'development', `:${DEV}`);
    w.fx.g('fetch', '-q', '--prune', 'origin');
    w.fx.g('branch', '-q', '-D', DEV);
    w.github.prs.length = 0;
    w.fx.write('t3.ts', 'tiga\n');
    w.fx.g('add', 't3.ts');
    await runPr({ ...baseOpts, message: 'tambah t3' }, w.deps());
    expect(devRange(w.fx)).toEqual(['LOGIS-3938: tambah t3']);
    expect(w.fx.b('diff', '--name-only', `refs/heads/development...refs/heads/${DEV}`)).toBe('t3.ts');
  });

  it('commit baru mengubah file dari commit tiket yang sudah di development → -dev dimulai dari development, tanpa konflik', async () => {
    const w = world();
    await runPr(baseOpts, w.deps());
    w.fx.s('fetch', '-q', 'origin');
    w.fx.s('switch', '-q', 'development');
    w.fx.s('merge', '-q', '--no-ff', '-m', 'Merge PR', `origin/${DEV}`);
    w.fx.s('push', '-q', 'origin', 'development', `:${DEV}`);
    w.fx.g('fetch', '-q', '--prune', 'origin');
    w.fx.g('branch', '-q', '-D', DEV);
    w.github.prs.length = 0;
    // t1.ts dibuat oleh commit yang sudah masuk development; commit baru bergantung padanya.
    w.fx.write('t1.ts', 'satu\ndua\n');
    w.fx.g('add', 't1.ts');
    await runPr({ ...baseOpts, message: 'ubah t1' }, w.deps());
    expect(w.fails()).toBe('');
    expect(w.fx.b('log', '--format=%s', `refs/heads/development..refs/heads/${DEV}`)).toBe('LOGIS-3938: ubah t1');
    expect(w.fx.b('diff', '--name-only', `refs/heads/development...refs/heads/${DEV}`)).toBe('t1.ts');
    expect(w.fx.b('show', `refs/heads/${DEV}:t1.ts`)).toBe('satu\ndua');
    expect(w.log.lines.join('\n')).toMatch(/dari ujung development/);
    expect(w.fx.g('worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('commit tiket lain yang sudah di development (SHA beda, patch sama) dipakai sebagai dasar → PR hanya berisi tiket ini', async () => {
    const w = world({ empty: true, clean: true });
    // Tiket dasar (mis. LOGIS-3943) sudah masuk development lewat -dev-nya sendiri (SHA berbeda).
    w.fx.commit('LOGIS-3937: dasar', { 'base.ts': 'a\nb\nc\n' });
    const own = w.fx.g('rev-parse', 'HEAD');
    w.fx.s('fetch', '-q', 'origin');
    w.fx.s('switch', '-q', 'development');
    w.fx.g('push', '-q', 'origin', `${own}:refs/heads/tmp-3937`);
    w.fx.s('fetch', '-q', 'origin');
    w.fx.s('cherry-pick', '-x', 'origin/tmp-3937');
    w.fx.s('push', '-q', 'origin', 'development', ':tmp-3937');
    w.fx.g('fetch', '-q', '--prune', 'origin');
    w.fx.write('base.ts', 'a\nB-3938\nc\n');
    w.fx.g('add', 'base.ts');
    await runPr({ ...baseOpts, message: 'ubah base' }, w.deps());
    expect(w.fails()).toBe('');
    expect(w.fx.b('log', '--format=%s', `refs/heads/development..refs/heads/${DEV}`)).toBe('LOGIS-3938: ubah base');
    expect(w.fx.b('diff', '--name-only', `refs/heads/development...refs/heads/${DEV}`)).toBe('base.ts');
    expect(w.github.prs).toHaveLength(1);
  });
});

describe('REGRESI PR TERCEMAR — harus berhenti sebelum push/PR', () => {
  it('branch tiket dibuat dari development', async () => {
    const w = world({ from: 'development' });
    await expectBlocked(w, baseOpts, /bukan milik tiket/);
    expect(w.fails()).toMatch(/Commit milik 'development'/);
    expect(w.fx.g('rev-list', '--count', 'HEAD', '^origin/development')).toBe('1'); // belum ada commit baru
  });

  it('development di-merge ke branch tiket', async () => {
    const w = world();
    withStash(w, () => w.fx.g('merge', '-q', '--no-edit', 'origin/development'));
    await expectBlocked(w, baseOpts, /bukan milik tiket/);
    expect(w.fails()).toMatch(/LOGIS-371: fitur dev 1/);
  });

  it('merge development SEDANG berjalan (MERGE_HEAD) → berhenti, tidak commit, tidak meng-abort', async () => {
    const w = world({ clean: true });
    w.fx.g('merge', '--no-ff', '--no-commit', 'origin/development');
    const head = w.fx.g('rev-parse', 'HEAD');
    await expectBlocked(w, baseOpts, /merge sedang berjalan/);
    expect(w.fx.g('rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(path.join(w.fx.work, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  it('commit dari branch tiket lain (LOGIS-3920) di-merge', async () => {
    const w = world();
    withStash(w, () => w.fx.g('merge', '-q', '--no-edit', 'origin/LOGIS-3920'));
    await expectBlocked(w, baseOpts, /bukan milik tiket/);
    expect(w.fails()).toMatch(/origin\/LOGIS-3920/);
  });

  it('commit tiket lain di-cherry-pick (SHA baru, hanya ada di satu branch) → peringatan subject', async () => {
    const w = world();
    withStash(w, () => w.fx.g('cherry-pick', 'origin/LOGIS-3920'));
    // Patch-nya bukan dari env branch & SHA-nya baru → tidak bisa dibuktikan asing; minimal diperingatkan dan
    // tetap diminta konfirmasi allowlist (di test ini -y). Lihat ADR: sisa risiko.
    const res = await runPr({ ...baseOpts }, w.deps());
    expect(res.prs).toHaveLength(1);
    expect(w.log.lines.some((l) => l.startsWith('warn:') && l.includes('LOGIS-3920'))).toBe(true);
  });

  it('branch tiket dibuat dari staging', async () => {
    const w = world({ from: 'staging' });
    await expectBlocked(w, baseOpts, /bukan milik tiket/);
    expect(w.fails()).toMatch(/Commit milik 'staging'/);
  });

  it('commit development di-cherry-pick (SHA beda, patch sama)', async () => {
    const w = world();
    withStash(w, () => w.fx.g('cherry-pick', 'origin/development'));
    await expectBlocked(w, baseOpts, /bukan milik tiket/);
    expect(w.fails()).toMatch(/Salinan \(cherry-pick\) commit 'development'/);
  });

  it('merge commit yang tidak berasal dari production', async () => {
    const w = world({ clean: true });
    w.fx.g('switch', '-q', '-c', 'sub');
    w.fx.commit('LOGIS-3938: sub', { 'sub.ts': 'x\n' });
    w.fx.g('switch', '-q', BRANCH);
    w.fx.g('merge', '-q', '--no-ff', '--no-edit', 'sub');
    await expectBlocked(w, { ...baseOpts, message: undefined }, /bukan milik tiket/);
    expect(w.fails()).toMatch(/Merge commit/);
  });

  it('-b production pada branch yang dibuat dari development', async () => {
    const w = world({ from: 'development' });
    await expectBlocked(w, { ...baseOpts, base: 'production' }, /bukan milik tiket/);
  });

  it('-dev di remote berisi commit asing (staging di-merge orang lain) → berhenti, -dev tidak disentuh', async () => {
    const w = world();
    await runPr(baseOpts, w.deps());
    w.fx.s('fetch', '-q', 'origin');
    w.fx.s('switch', '-q', '-c', 'x', `origin/${DEV}`);
    w.fx.s('merge', '-q', '--no-edit', 'origin/staging');
    w.fx.s('push', '-q', 'origin', `HEAD:${DEV}`);
    const tampered = w.fx.b('rev-parse', `refs/heads/${DEV}`);
    w.github.prs.length = 0;
    w.state.teams.length = 0;
    w.jfake.state.posts = 0;
    await expectBlocked(w, { ...baseOpts, message: undefined }, /branch integrasi 'LOGIS-3938-dev' tidak bersih/i);
    expect(w.fails()).toMatch(/Merge PR|Merge|staging/);
    expect(w.fx.b('rev-parse', `refs/heads/${DEV}`)).toBe(tampered);
  });

  it('-dev lokal & remote bercabang → berhenti tanpa menimpa salah satunya', async () => {
    const w = world();
    await runPr(baseOpts, w.deps());
    const localTip = w.fx.g('commit-tree', `${DEV}^{tree}`, '-p', DEV, '-m', 'LOGIS-3938: lokal');
    w.fx.g('update-ref', `refs/heads/${DEV}`, localTip);
    w.fx.s('fetch', '-q', 'origin');
    w.fx.s('switch', '-q', '-c', 'y', `origin/${DEV}`);
    w.fx.commit('LOGIS-3938: remote', { 'r.ts': 'r\n' }, 'seed');
    w.fx.s('push', '-q', 'origin', `HEAD:${DEV}`);
    const remoteTip = w.fx.b('rev-parse', `refs/heads/${DEV}`);
    w.github.prs.length = 0;
    w.state.teams.length = 0;
    w.jfake.state.posts = 0;
    await expectBlocked(w, { ...baseOpts, message: undefined }, /branch integrasi/);
    expect(w.fails()).toMatch(/bercabang/);
    expect(w.fx.g('rev-parse', DEV)).toBe(localTip);
    expect(w.fx.b('rev-parse', `refs/heads/${DEV}`)).toBe(remoteTip);
  });

  it('isi PR di GitHub berbeda dari validasi lokal → exit 3 sebelum reviewer/Jira/Teams', async () => {
    const w = world({ tamperExtraCommit: 'deadbeef'.repeat(5) });
    const err = await runPr(baseOpts, w.deps()).catch((e: unknown) => e);
    expect((err as CliError).exitCode).toBe(3);
    expect(w.fails()).toMatch(/ISI PR DI GITHUB TIDAK SAMA/);
    expect(w.github.reviewers.size).toBe(0);
    expect(w.jfake.state.posts).toBe(0);
    expect(w.state.teams).toHaveLength(0);
  });

  it('PR lama langsung dari branch tiket ke development → diperingatkan', async () => {
    const w = world();
    withStash(w, () => w.fx.g('push', '-q', 'origin', BRANCH));
    await w.github.gh.createPr({ repo: REPO, base: 'development', head: BRANCH, title: 'lama', body: '' });
    await runPr(baseOpts, w.deps());
    expect(w.log.lines.some((l) => l.startsWith('warn:') && l.includes('PR lama langsung dari branch tiket'))).toBe(true);
  });
});

describe('sinkronisasi production, konflik, kegagalan di tengah', () => {
  it('merge origin/production (sinkron) diizinkan; -dev diputar ulang dengan isi identik branch tiket', async () => {
    const w = world();
    w.fx.commit('hotfix prod', { 'p.ts': 'prod\n' }, 'seed');
    w.fx.s('push', '-q', 'origin', 'production');
    w.fx.g('fetch', '-q', 'origin');
    withStash(w, () => w.fx.g('merge', '-q', '--no-edit', 'origin/production'));
    await runPr(baseOpts, w.deps());
    expect(w.fx.g('rev-parse', `origin/${DEV}^{tree}`)).toBe(w.fx.g('rev-parse', 'HEAD^{tree}'));
    expect(w.log.lines.some((l) => l.includes('merge sinkronisasi'))).toBe(true);
  });

  it('konflik dengan development → berhenti SEBELUM commit (exit 2), repo lokal tidak berubah', async () => {
    const w = world();
    w.fx.s('switch', '-q', 'development');
    w.fx.commit('LOGIS-3799: ubah app', { 'app.ts': 'a\nDEV\nc\n' }, 'seed');
    w.fx.s('push', '-q', 'origin', 'development');
    w.fx.write('app.ts', 'a\nTIKET\nc\n');
    const before = localState(w.fx);
    await expectBlocked(w, baseOpts, /konflik/, 2);
    expect(localState(w.fx)).toBe(before);
    expect(w.fails()).toMatch(/app\.ts/);
  });

  it('cherry-pick ke -dev yang sudah ada konflik → exit 2; -dev & branch tiket utuh; worktree sementara dibersihkan', async () => {
    const w = world({ clean: true });
    w.fx.s('switch', '-q', 'development');
    w.fx.commit('LOGIS-3799: ubah app', { 'app.ts': 'a\nDEV\nc\n' }, 'seed');
    w.fx.s('push', '-q', 'origin', 'development');
    w.fx.commit('LOGIS-3938: app tiket', { 'app.ts': 'a\nT1\nc\n' });
    w.fx.g('fetch', '-q', 'origin');
    // -dev dibuat manual; konflik development diselesaikan developer di -dev (diizinkan).
    w.fx.g('switch', '-q', '-c', DEV, 'origin/production');
    w.fx.g('cherry-pick', '-x', `${BRANCH}~1`, BRANCH);
    try {
      w.fx.g('merge', '--no-edit', 'origin/development');
    } catch {
      w.fx.write('app.ts', 'a\nDEV+T1\nc\n');
      w.fx.g('add', 'app.ts');
      w.fx.g('commit', '-q', '--no-edit');
    }
    w.fx.g('push', '-q', 'origin', DEV);
    w.fx.g('switch', '-q', BRANCH);
    w.fx.write('app.ts', 'a\nT2\nc\n');
    const devBefore = w.fx.g('rev-parse', DEV);
    const ticketBefore = w.fx.g('rev-parse', 'HEAD');
    const tmpBefore = wtDirs();
    const err = await expectBlocked(w, baseOpts, /cherry-pick ke branch integrasi konflik/, 2);
    expect(err.hint).toMatch(/git cherry-pick -x/);
    expect(w.fx.g('rev-parse', DEV)).toBe(devBefore);
    expect(w.fx.g('rev-parse', 'HEAD')).toBe(ticketBefore);
    expect(w.fx.g('status', '--porcelain')).toBe('M app.ts');
    expect(w.fx.g('worktree', 'list').split('\n')).toHaveLength(1);
    expect(wtDirs()).toBe(tmpBefore);
  });
});

describe('push branch tiket (notice "Compare & pull request" di GitHub)', () => {
  const hasRemote = (fx: Fixture, b: string) => fx.remoteRefs().includes(`refs/heads/${b} `);

  it('default: PR ke development → hanya -dev yang di-push, branch tiket tidak', async () => {
    const w = world();
    await runPr(baseOpts, w.deps());
    expect(hasRemote(w.fx, DEV)).toBe(true);
    expect(hasRemote(w.fx, BRANCH)).toBe(false);
    expect(w.log.lines.some((l) => l.includes(`Branch tiket '${BRANCH}' tidak di-push`))).toBe(true);
    // dijalankan ulang dengan commit baru: tetap tidak di-push, -dev maju
    w.fx.write('t2.ts', 'dua\n');
    w.fx.g('add', 't2.ts');
    await runPr({ ...baseOpts, message: 'tambah t2' }, w.deps());
    expect(hasRemote(w.fx, BRANCH)).toBe(false);
    expect(devRange(w.fx)[0]).toBe('LOGIS-3938: tambah t2');
  });

  it('--push-ticket → branch tiket ikut di-push', async () => {
    const w = world();
    await runPr({ ...baseOpts, pushTicket: true }, w.deps());
    expect(w.fx.b('rev-parse', `refs/heads/${BRANCH}`)).toBe(w.fx.g('rev-parse', 'HEAD'));
  });

  it("config pushTicketBranch: 'always' → branch tiket ikut di-push", async () => {
    const w = world({ config: { pushTicketBranch: 'always' } });
    await runPr(baseOpts, w.deps());
    expect(hasRemote(w.fx, BRANCH)).toBe(true);
  });

  it('PR dari branch tiket (production) → branch tiket tetap di-push', async () => {
    const w = world();
    await runPr({ ...baseOpts, base: 'production' }, w.deps());
    expect(hasRemote(w.fx, BRANCH)).toBe(true);
  });

  it('--dry-run menyebutkan branch tiket tidak akan di-push', async () => {
    const w = world();
    await runPr({ ...baseOpts, dryRun: true }, w.deps());
    expect(w.log.lines.some((l) => l.includes('[dry-run]') && l.includes('tidak di-push'))).toBe(true);
  });
});

describe('hotfix & opsi target', () => {
  it('hotfix default: hotfix → production & LOGIS-XXXX-dev → development, satu pesan Teams', async () => {
    const w = world({ branch: 'hotfix/LOGIS-3938-null-driver' });
    const res = await runPr(baseOpts, w.deps());
    expect(res.prs.map((p) => `${p.head}→${p.base}`)).toEqual(['hotfix/LOGIS-3938-null-driver→production', `${DEV}→development`]);
    expect(w.state.teams).toHaveLength(1);
    expect(w.state.teams[0]?.text).toMatch(/PR \(production\): .*\nPR \(development\): /);
    expect(w.fx.b('rev-list', '--count', 'refs/heads/hotfix/LOGIS-3938-null-driver', '^refs/heads/production')).toBe('2');
    expect(w.fx.b('rev-list', '--count', `refs/heads/${DEV}`, '^refs/heads/development')).toBe('2');
  });

  it('hotfix interaktif "production saja"', async () => {
    const w = world({ branch: 'hotfix/LOGIS-3938-x' });
    const res = await runPr({ ...baseOpts, yes: false }, w.deps({ choose: async <T,>() => 'production' as T }));
    expect(res.prs.map((p) => p.base)).toEqual(['production']);
    expect(w.fx.remoteRefs()).not.toContain(`refs/heads/${DEV} `);
  });

  it('-b production pada fitur dari production → PR langsung dari branch tiket', async () => {
    const w = world();
    const res = await runPr({ ...baseOpts, base: 'production' }, w.deps());
    expect(res.prs).toEqual([expect.objectContaining({ head: BRANCH, base: 'production' })]);
  });

  it('dijalankan dari branch -dev → ditolak', async () => {
    const w = world({ branch: DEV });
    await expect(runPr(baseOpts, w.deps())).rejects.toThrow(/branch integrasi/);
  });
});

describe('validasi awal & keamanan working tree', () => {
  it('production tidak ada di remote → berhenti; tidak diganti main/development diam-diam', async () => {
    const w = world({ config: { productionBranch: 'prod' } });
    w.fx.s('push', '-q', 'origin', 'production:main');
    w.fx.g('fetch', '-q', 'origin');
    const before = localState(w.fx);
    const err = await expectBlocked(w, baseOpts, /'prod' tidak ada di remote 'origin'/);
    expect(err.hint).toMatch(/tidak mengganti branch produksi/);
    expect(localState(w.fx)).toBe(before);
  });

  it('remote yang dikonfigurasi tidak ada → berhenti', async () => {
    const w = world({ config: { remote: 'upstream' } });
    await expect(runPr(baseOpts, w.deps())).rejects.toBeInstanceOf(CliError);
    expect(w.github.prs).toHaveLength(0);
  });

  it('ada perubahan tetapi tanpa -m → berhenti tanpa mengubah apa pun', async () => {
    const w = world();
    const before = localState(w.fx);
    await expect(runPr({ ...baseOpts, message: undefined }, w.deps())).rejects.toThrow(/pesan commit tidak diberikan/);
    expect(localState(w.fx)).toBe(before);
  });

  it('detached HEAD → berhenti', async () => {
    const w = world({ clean: true });
    w.fx.g('switch', '-q', '--detach');
    await expect(runPr(baseOpts, w.deps())).rejects.toThrow(/detached/);
  });

  it('dijalankan dari development → ditolak', async () => {
    const w = world({ clean: true });
    w.fx.g('switch', '-q', '-c', 'development', 'origin/development');
    await expect(runPr(baseOpts, w.deps())).rejects.toThrow(/bukan branch tiket/);
  });

  it('belum ada commit tiket → berhenti', async () => {
    const w = world({ empty: true, clean: true });
    await expect(runPr({ ...baseOpts, message: undefined }, w.deps())).rejects.toThrow(/belum punya commit tiket/);
  });
});

describe('--dry-run & --audit tidak mengubah repo', () => {
  it('--dry-run: branch, index, file, worktree, dan remote tidak berubah; rencana ditampilkan', async () => {
    const w = world();
    const before = localState(w.fx);
    const remote = w.fx.remoteRefs();
    const res = await runPr({ ...baseOpts, dryRun: true }, w.deps());
    expect(localState(w.fx)).toBe(before);
    expect(w.fx.remoteRefs()).toBe(remote);
    expect(res.prs[0]?.head).toBe(DEV);
    expect(w.log.lines.join('\n')).toMatch(/Akan membuat branch 'LOGIS-3938-dev'/);
    expect(w.log.lines.join('\n')).toMatch(/\[dry-run\] git fetch/);
    expect(w.jfake.state.posts).toBe(0);
    expect(w.state.teams).toHaveLength(0);
  });

  it('--audit: tanpa fetch & tanpa objek baru; menilai AMAN lalu TIDAK AMAN', async () => {
    const w = world({ clean: true });
    await runPr({ ...baseOpts, message: undefined }, w.deps());
    const state = localState(w.fx);
    const tracking = () => w.fx.g('for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes');
    const trackingBefore = tracking();
    const objects = w.fx.g('count-objects', '-v');
    const ok = await runAudit({}, { config, git: w.git, gh: w.github.gh, log: createMemoryLogger() });
    expect(ok).toEqual({ safe: true, issues: [] });
    expect(localState(w.fx)).toBe(state);
    expect(tracking()).toBe(trackingBefore);
    expect(w.fx.g('count-objects', '-v')).toBe(objects);

    w.fx.g('merge', '-q', '--no-edit', 'origin/development');
    const bad = await runAudit({}, { config, git: w.git, gh: w.github.gh, log: createMemoryLogger() });
    expect(bad.safe).toBe(false);
    expect(bad.issues.join('\n')).toMatch(/Branch tiket: \d+ masalah/);
  });
});

describe('file yang ikut commit (tidak pernah git add --all)', () => {
  it('file baru default tidak ikut; -a mengikutkan', async () => {
    const w = world();
    w.fx.write('baru.ts', 'baru\n');
    await runPr(baseOpts, w.deps());
    expect(changed(w.fx)).toEqual(['README.md']);
    expect(w.fx.g('status', '--porcelain')).toContain('?? baru.ts');

    const w2 = world();
    w2.fx.write('baru.ts', 'baru\n');
    await runPr({ ...baseOpts, all: true }, w2.deps());
    expect(changed(w2.fx)).toEqual(['README.md', 'baru.ts']);
  });

  it('bila ada file yang di-stage, hanya file itu yang di-commit', async () => {
    const w = world();
    w.fx.write('t1.ts', 'diubah\n');
    w.fx.g('add', 't1.ts');
    await runPr(baseOpts, w.deps());
    expect(changed(w.fx)).toEqual(['t1.ts']);
    expect(w.fx.g('status', '--porcelain')).toBe('M README.md');
  });
});

describe('Jira, reviewer, Teams (non-kritis)', () => {
  it('Jira To Do → In Progress → Code Review; reviewer firdausnp diminta di PR -dev', async () => {
    const w = world({ status: 'To Do' });
    const res = await runPr(baseOpts, w.deps());
    expect(w.jfake.state.history).toEqual(['To Do → In Progress', 'In Progress → Code Review']);
    expect(res.reviewers).toBe('requested');
    expect(w.github.reviewers.get(901)).toEqual(['firdausnp']);
  });

  it('Teams gagal → warning, pesan dicetak untuk dikirim manual, PR tetap ada', async () => {
    const w = world();
    const res = await runPr(baseOpts, w.deps({ sendTeams: async () => Promise.reject(new CliError('Flow 403')) }));
    expect(res.teams).toBe('failed');
    expect(res.prs).toHaveLength(1);
    expect(w.log.lines.some((l) => l.includes('dikirim manual'))).toBe(true);
  });

  it('--no-jira & --no-teams', async () => {
    const w = world();
    const res = await runPr({ ...baseOpts, jira: false, teams: false }, w.deps({ sendTeams: null }));
    expect(res).toMatchObject({ jira: 'skipped', teams: 'skipped' });
    expect(w.jira.moveToStatus).not.toHaveBeenCalled();
  });
});
