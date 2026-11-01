import { describe, expect, it, vi } from 'vitest';
import { runPr, type GitHubLike, type GitLike, type JiraLike, type RunDeps, type RunOptions } from '../src/cli/run.js';
import { DEFAULT_CONFIG, type Config } from '../src/config/index.js';
import type { CommitInfo, WorkingTreeStatus } from '../src/git/index.js';
import type { PullRequest } from '../src/github/index.js';
import { JiraClient } from '../src/jira/index.js';
import { fakeJiraWorkflow } from './helpers.js';
import type { TeamsPayload } from '../src/teams/index.js';
import { CliError } from '../src/utils/errors.js';
import { ASCII_SYMBOLS, createMemoryLogger } from '../src/utils/term.js';

const REPO = 'developerserasiautoraya/SELOG_LOGIS_ServiceOrder';
const SUMMARY = '[Backend] Enhance Bulk Last Route Location Response for Shipment and Driver Enrichment';
const PR_URL = `https://github.com/${REPO}/pull/1886`;

const config: Config = {
  ...DEFAULT_CONFIG,
  jiraEmail: 'dev@example.com',
  jiraApiToken: 'tok',
  teamsWebhookUrl: 'https://prod.logic.azure.com/x?sig=y',
};

/** Dunia palsu yang menyimpan state, sehingga run kedua melihat hasil run pertama. */
function createWorld(
  over: {
    branch?: string | null;
    dirty?: boolean;
    wt?: WorkingTreeStatus;
    status?: string;
    workflow?: Record<string, string[]>;
    /** Commit HEAD di luar production. */
    branchCommits?: CommitInfo[];
    /** Commit yang hanya ada di development. */
    devOnly?: CommitInfo[];
    /** Commit production yang belum ada di development. */
    unsynced?: CommitInfo[];
    /** base → file konflik. */
    conflicts?: Record<string, string[]>;
    remoteBranches?: string[];
  } = {},
) {
  const clean: WorkingTreeStatus = { staged: [], unstaged: [], untracked: [] };
  const state = {
    branch: over.branch === undefined ? 'feature/LOGIS-3938-bulk-last-route' : over.branch,
    wt: over.wt ?? (over.dirty === false ? clean : { staged: [], unstaged: ['src/a.ts'], untracked: ['src/b.ts'] }),
    committedFiles: [] as string[][],
    commits: [] as string[],
    pushes: 0,
    prs: [] as PullRequest[],
    teams: [] as TeamsPayload[],
    copied: [] as string[],
    stdout: [] as string[],
    notified: new Map<string, string>(),
    reviewers: [] as string[],
    reviewersByPr: new Map<number, string[]>(),
  };
  const git: GitLike = {
    version: async () => 'git version 2.47.0.windows.1',
    isRepo: async () => true,
    currentBranch: async () => state.branch,
    status: async () => structuredClone(state.wt),
    remoteUrl: async () => `https://github.com/${REPO}.git`,
    stageTracked: vi.fn(async () => {
      state.wt.staged.push(...state.wt.unstaged);
      state.wt.unstaged = [];
    }),
    stagePaths: vi.fn(async (paths: readonly string[]) => {
      state.wt.staged.push(...paths);
      state.wt.untracked = state.wt.untracked.filter((p) => !paths.includes(p));
    }),
    commitStaged: vi.fn(async (m: string) => {
      state.commits.push(m);
      state.committedFiles.push([...state.wt.staged]);
      state.wt.staged = [];
    }),
    push: vi.fn(async () => {
      state.pushes++;
    }),
    lastCommitSubject: async () => state.commits.at(-1)?.split('\n')[0] ?? 'LOGIS-3938: commit lama',
    fetch: vi.fn(async () => undefined),
    refExists: async (ref: string) => (over.remoteBranches ?? ['production', 'development']).map((b) => `origin/${b}`).includes(ref),
    commitsBetween: async (include: string, exclude: readonly string[]) => {
      if (include === 'HEAD') return over.branchCommits ?? [{ sha: 'f1', line: 'f1 fitur' }];
      if (include === 'origin/development' && exclude[0] === 'origin/production') return over.devOnly ?? [{ sha: 'd1', line: 'd1 dev' }];
      if (include === 'origin/production') return over.unsynced ?? [];
      return [];
    },
    snapshotCommit: vi.fn(async () => 'snap'),
    mergeCheck: vi.fn(async (base: string) => {
      const files = over.conflicts?.[base.replace(/^origin\//, '')] ?? [];
      return { clean: files.length === 0, conflicts: files };
    }),
  };

  const gh: GitHubLike = {
    version: async () => 'gh version 2.80.0',
    authStatus: async () => ({ ok: true, detail: 'Logged in' }),
    findOpenPr: vi.fn(async (_repo: string, _branch: string, base?: string) => state.prs.find((p) => !base || p.baseRefName === base) ?? null),
    createPr: vi.fn(async (input) => {
      const number = input.base === 'production' ? 1890 : 1886;
      const url = number === 1886 ? PR_URL : PR_URL.replace('1886', String(number));
      state.prs.push({ number, url, title: input.title, isDraft: Boolean(input.draft), baseRefName: input.base });
      return url;
    }),
    ensureReviewers: vi.fn(async (_repo: string, n: number, reviewers: readonly string[]) => {
      const cur = state.reviewersByPr.get(n) ?? [];
      const toAdd = reviewers.filter((r) => !cur.includes(r));
      state.reviewersByPr.set(n, [...cur, ...toAdd]);
      if (!state.reviewers.length || n === 1886) state.reviewers = [...new Set([...state.reviewers, ...toAdd])];
      return { requested: toAdd, alreadyRequested: reviewers.filter((r) => !toAdd.includes(r)), alreadyReviewed: [], skippedAuthor: [] };
    }),
  };

  const fakeJira = fakeJiraWorkflow(over.status ?? 'In Progress', { workflow: over.workflow });
  const client = new JiraClient({ baseUrl: 'https://x.atlassian.net', email: 'e', apiToken: 't' }, fakeJira.fetchImpl);
  const jira: JiraLike = {
    getIssue: async (key) => ({ ...(await client.getIssue(key)), key, summary: SUMMARY }),
    moveToStatus: vi.fn((key: string, target: string, o?: Parameters<JiraLike['moveToStatus']>[2]) => client.moveToStatus(key, target, o)),
  };
  const jstate = fakeJira.state;

  const log = createMemoryLogger();
  const deps = (extra: Partial<RunDeps> = {}): RunDeps => ({
    config,
    git,
    gh,
    jira,
    sendTeams: async (p) => {
      state.teams.push(p);
    },
    confirm: async (_q, defaultYes) => defaultYes, // = pengguna menekan Enter
    choose: async (_q, _choices, defaultValue) => defaultValue,
    notified: {
      sentAt: async (url) => state.notified.get(url) ?? null,
      markSent: async (url) => {
        state.notified.set(url, '31 Okt 2026 22.40');
      },
    },
    copy: async (t) => {
      state.copied.push(t);
      return true;
    },
    log,
    symbols: ASCII_SYMBOLS,
    interactive: true,
    printResult: (l) => state.stdout.push(l),
    ...extra,
  });
  return { state, jstate, git, gh, jira, log, deps };
}

const baseOpts: RunOptions = { message: 'tambah enrichment', jira: true, teams: true };

describe('runPr — alur lengkap', () => {
  it('commit+push → PR baru → Jira Code Review → Teams → link tercetak & ter-copy', async () => {
    const w = createWorld();
    const res = await runPr(baseOpts, w.deps());

    expect(w.state.commits).toEqual(['LOGIS-3938: tambah enrichment']);
    expect(w.state.pushes).toBe(1);
    expect(w.gh.createPr).toHaveBeenCalledWith(
      expect.objectContaining({ repo: REPO, base: 'development', head: 'feature/LOGIS-3938-bulk-last-route', title: 'LOGIS-3938: tambah enrichment' }),
    );
    expect(res).toMatchObject({ prUrl: PR_URL, prCreated: true, committed: true, jira: 'moved', teams: 'sent' });
    expect(w.jstate.status).toBe('Code Review');
    expect(w.state.teams[0]?.text).toBe(
      [
        'Task: Review PR LOGIS-3938',
        `Desc: ${SUMMARY} in [ServiceOrder]`,
        '',
        `PR: ${PR_URL}`,
        'Tiket: https://serasiautoraya.atlassian.net/browse/LOGIS-3938',
      ].join('\n'),
    );
    expect(w.state.teams[0]?.html).toContain(`<a href="${PR_URL}">${PR_URL}</a>`);
    expect(w.state.copied).toEqual([PR_URL]);
    expect(w.state.stdout).toEqual([PR_URL]);
  });

  it('menjalankan ulang TIDAK membuat PR atau transisi duplikat', async () => {
    const w = createWorld();
    await runPr(baseOpts, w.deps());
    const second = await runPr(baseOpts, w.deps());

    expect(w.gh.createPr).toHaveBeenCalledTimes(1);
    expect(w.jstate.posts).toBe(1);
    expect(w.state.commits).toHaveLength(1); // tree sudah bersih → tidak commit lagi
    expect(second).toMatchObject({ prUrl: PR_URL, prCreated: false, committed: false, jira: 'already', teams: 'already-sent' });
    expect(w.state.teams).toHaveLength(1); // tidak spam grup Teams
    expect(w.log.lines.some((l) => l.includes('pesan -m diabaikan'))).toBe(true);
  });

  it('run ulang interaktif tanpa -y menanyakan kirim ulang dengan default Tidak', async () => {
    const w = createWorld();
    await runPr({ ...baseOpts, yes: true }, w.deps());
    const confirm = vi.fn(async (_q: string, _d: boolean) => true);
    const res = await runPr(baseOpts, w.deps({ confirm }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('ULANG'), false);
    expect(res.teams).toBe('sent');
    expect(w.state.teams).toHaveLength(2);
  });

  it('working tree bersih tanpa -m → langsung push, judul PR dari commit terakhir', async () => {
    const w = createWorld({ dirty: false });
    await runPr({ jira: true, teams: true }, w.deps());
    expect(w.git.commitStaged).not.toHaveBeenCalled();
    expect(w.state.pushes).toBe(1);
    expect(w.gh.createPr).toHaveBeenCalledWith(expect.objectContaining({ title: 'LOGIS-3938: commit lama' }));
  });

  it('format commit tim (ver/tkt/msg) dipakai apa adanya untuk commit & judul PR', async () => {
    const w = createWorld();
    const msg = 'ver:1.0.0 tkt:LOGIS-3938 msg:add logis-pr guide';
    await runPr({ ...baseOpts, message: msg }, w.deps());
    expect(w.state.commits).toEqual([msg]);
    expect(w.gh.createPr).toHaveBeenCalledWith(expect.objectContaining({ title: msg }));
  });

  it('opsi -b, -d, -t diteruskan', async () => {
    const w = createWorld({ branch: 'feature/no-key', remoteBranches: ['production', 'development', 'staging'] });
    const res = await runPr({ ...baseOpts, base: 'staging', draft: true, ticket: '4001' }, w.deps());
    expect(res.ticketKey).toBe('LOGIS-4001');
    expect(w.gh.createPr).toHaveBeenCalledWith(expect.objectContaining({ base: 'staging', draft: true }));
  });
});

describe('runPr — alur branch production / development', () => {
  const opts = { ...baseOpts, yes: true };
  const noSideEffects = (w: ReturnType<typeof createWorld>) => {
    expect(w.git.commitStaged).not.toHaveBeenCalled();
    expect(w.git.push).not.toHaveBeenCalled();
    expect(w.gh.createPr).not.toHaveBeenCalled();
    expect(w.jstate.posts).toBe(0);
    expect(w.state.teams).toHaveLength(0);
  };

  it('fitur: fetch production & development, cek konflik ke development, PR ke development', async () => {
    const w = createWorld();
    const res = await runPr(opts, w.deps());
    expect(w.git.fetch).toHaveBeenCalledWith(['production', 'development']);
    expect(w.git.mergeCheck).toHaveBeenCalledWith('origin/development', 'snap');
    expect(res.bases).toEqual(['development']);
    expect(w.log.lines.some((l) => l.includes("Branch berasal dari 'production'"))).toBe(true);
  });

  it('branch membawa commit development → berhenti dengan warning besar, tanpa efek samping', async () => {
    const w = createWorld({
      branchCommits: [{ sha: 'f1', line: 'f1 fitur' }, { sha: 'd1', line: 'd1 fitur orang lain di dev' }],
      devOnly: [{ sha: 'd1', line: 'd1 fitur orang lain di dev' }],
    });
    await expect(runPr(opts, w.deps())).rejects.toThrow(/harus dibuat dari production/);
    const fails = w.log.lines.filter((l) => l.startsWith('fail:')).join('\n');
    expect(fails).toMatch(/BRANCH TIDAK DIBUAT DARI 'production'/);
    expect(fails).toMatch(/d1 fitur orang lain di dev/);
    noSideEffects(w);
  });

  it('konflik ke development → berhenti SEBELUM commit/push/PR, exit code 2', async () => {
    const w = createWorld({ conflicts: { development: ['src/app.ts', 'README.md'] } });
    const err = await runPr(opts, w.deps()).catch((e: unknown) => e);
    expect((err as CliError).message).toMatch(/konflik/);
    expect((err as CliError).exitCode).toBe(2);
    const fails = w.log.lines.filter((l) => l.startsWith('fail:')).join('\n');
    expect(fails).toMatch(/KONFLIK — PROSES DIHENTIKAN/);
    expect(fails).toMatch(/src\/app\.ts/);
    noSideEffects(w);
  });

  it('dry-run juga mendeteksi konflik', async () => {
    const w = createWorld({ conflicts: { development: ['a.ts'] } });
    await expect(runPr({ ...baseOpts, dryRun: true }, w.deps())).rejects.toThrow(/konflik/);
  });

  it('cek konflik memakai perubahan yang akan di-commit (snapshot), bukan HEAD lama', async () => {
    const w = createWorld();
    await runPr(opts, w.deps());
    expect(w.git.snapshotCommit).toHaveBeenCalledWith(expect.objectContaining({ files: ['src/a.ts'] }));
  });

  it('production punya commit yang belum ada di development → warning', async () => {
    const w = createWorld({ unsynced: [{ sha: 'h1', line: 'h1 hotfix lama' }] });
    await runPr(opts, w.deps());
    expect(w.log.lines.some((l) => l.startsWith('warn:') && l.includes('belum ada di \'development\''))).toBe(true);
  });

  it('origin/production tidak ada → berhenti dengan saran', async () => {
    const w = createWorld({ remoteBranches: ['development'] });
    const err = await runPr(opts, w.deps()).catch((e: unknown) => e);
    expect((err as CliError).message).toMatch(/'production' tidak ada di remote/);
    expect((err as CliError).hint).toMatch(/LOGIS_PR_PRODUCTION_BRANCH/);
  });

  it('hotfix: default 2 PR (production & development), satu transisi Jira, satu pesan Teams berisi 2 link', async () => {
    const w = createWorld({ branch: 'hotfix/LOGIS-3938-null-driver' });
    const res = await runPr(opts, w.deps());
    expect(res.bases).toEqual(['production', 'development']);
    expect(res.prs.map((p) => p.base)).toEqual(['production', 'development']);
    expect(w.git.mergeCheck).toHaveBeenCalledTimes(2);
    expect(w.jstate.posts).toBe(1);
    expect(w.state.teams).toHaveLength(1);
    expect(w.state.teams[0]?.text).toBe(
      [
        'Task: Review PR LOGIS-3938',
        `Desc: ${SUMMARY} in [ServiceOrder]`,
        '',
        `PR (production): ${PR_URL.replace('1886', '1890')}`,
        `PR (development): ${PR_URL}`,
        'Tiket: https://serasiautoraya.atlassian.net/browse/LOGIS-3938',
      ].join('\n'),
    );
    expect(w.state.reviewersByPr.get(1890)).toEqual(['firdausnp']);
    expect(w.state.reviewersByPr.get(1886)).toEqual(['firdausnp']);
    expect(w.state.stdout).toHaveLength(2);
  });

  it('hotfix interaktif: pilihan "production saja"', async () => {
    const w = createWorld({ branch: 'hotfix/LOGIS-3938-x' });
    const choose = vi.fn(async () => 'production' as never);
    const res = await runPr(baseOpts, w.deps({ choose }));
    expect(choose).toHaveBeenCalledWith(
      expect.stringContaining('hotfix'),
      [
        { name: 'production dan development', value: 'both' },
        { name: 'production saja', value: 'production' },
        { name: 'development saja', value: 'development' },
      ],
      'both',
    );
    expect(res.bases).toEqual(['production']);
    expect(w.git.mergeCheck).toHaveBeenCalledTimes(1);
  });

  it('hotfix konflik hanya ke development → berhenti, saran PR ke production saja', async () => {
    const w = createWorld({ branch: 'hotfix/LOGIS-3938-x', conflicts: { development: ['src/x.ts'] } });
    const err = await runPr(opts, w.deps()).catch((e: unknown) => e);
    expect((err as CliError).hint).toMatch(/production saja/);
    noSideEffects(w);
  });

  it('hotfix dijalankan ulang → kedua PR dipakai ulang, Teams tidak dobel', async () => {
    const w = createWorld({ branch: 'hotfix/LOGIS-3938-x' });
    await runPr(opts, w.deps());
    const again = await runPr(opts, w.deps());
    expect(w.gh.createPr).toHaveBeenCalledTimes(2);
    expect(again.prCreated).toBe(false);
    expect(again.teams).toBe('already-sent');
  });

  it('-b production,development memaksa dua target untuk branch apa pun', async () => {
    const w = createWorld();
    const res = await runPr({ ...opts, base: 'production,development' }, w.deps());
    expect(res.bases).toEqual(['production', 'development']);
  });
});

describe('runPr — Jira bertahap & reviewer', () => {
  it('tiket To Do → In Progress → Code Review, dicatat per langkah', async () => {
    const w = createWorld({ status: 'To Do' });
    const res = await runPr({ ...baseOpts, yes: true }, w.deps());
    expect(res.jira).toBe('moved');
    expect(w.jstate.history).toEqual(['To Do → In Progress', 'In Progress → Code Review']);
    const moved = w.log.lines.filter((l) => l.startsWith('ok: Tiket dipindah'));
    expect(moved).toHaveLength(2);
  });

  it('dry-run dari To Do: rencana langkah pertama + lanjutan, tanpa POST', async () => {
    const w = createWorld({ status: 'To Do' });
    const res = await runPr({ ...baseOpts, dryRun: true }, w.deps());
    expect(res.jira).toBe('planned');
    expect(w.jstate.posts).toBe(0);
    const all = w.log.lines.join('\n');
    expect(all).toMatch(/Akan memindahkan tiket 'To Do' → 'In Progress'/);
    expect(all).toMatch(/Lalu lanjut bertahap ke: Code Review/);
    expect(all).toMatch(/Akan meminta review dari: firdausnp/);
    expect(w.gh.ensureReviewers).not.toHaveBeenCalled();
  });

  it('reviewer default firdausnp diminta di PR baru, run ulang tidak minta ulang', async () => {
    const w = createWorld();
    const r1 = await runPr({ ...baseOpts, yes: true }, w.deps());
    expect(w.gh.ensureReviewers).toHaveBeenCalledWith('developerserasiautoraya/SELOG_LOGIS_ServiceOrder', 1886, ['firdausnp']);
    expect(r1.reviewers).toBe('requested');
    const r2 = await runPr({ ...baseOpts, yes: true }, w.deps());
    expect(r2.reviewers).toBe('already');
    expect(w.state.reviewers).toEqual(['firdausnp']);
  });

  it('-r meng-override config; -r none mematikan', async () => {
    const w = createWorld();
    await runPr({ ...baseOpts, yes: true, reviewers: '@a, b' }, w.deps());
    expect(w.gh.ensureReviewers).toHaveBeenLastCalledWith(expect.any(String), 1886, ['a', 'b']);
    const w2 = createWorld();
    const res = await runPr({ ...baseOpts, yes: true, reviewers: 'none' }, w2.deps());
    expect(w2.gh.ensureReviewers).not.toHaveBeenCalled();
    expect(res.reviewers).toBe('skipped');
  });

  it('gagal minta review → warning, Jira & Teams tetap jalan', async () => {
    const w = createWorld();
    w.gh.ensureReviewers = async () => {
      throw new CliError('Gagal meminta review dari firdausnp', { hint: 'akses repo' });
    };
    const res = await runPr({ ...baseOpts, yes: true }, w.deps());
    expect(res).toMatchObject({ reviewers: 'failed', jira: 'moved', teams: 'sent' });
  });
});

describe('runPr — file yang ikut commit (tanpa git add --all)', () => {
  const opts = { ...baseOpts, yes: true };

  it('default: hanya file terlacak; file baru ditanya dengan default Tidak', async () => {
    const w = createWorld();
    const confirm = vi.fn(async (_q: string, d: boolean) => d);
    await runPr(baseOpts, w.deps({ confirm }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Ikutkan 1 file baru'), false);
    expect(w.state.committedFiles).toEqual([['src/a.ts']]);
    expect(w.git.stagePaths).not.toHaveBeenCalled();
    expect(w.state.wt.untracked).toEqual(['src/b.ts']);
  });

  it('jawab y → file baru ikut', async () => {
    const w = createWorld();
    await runPr(baseOpts, w.deps({ confirm: async () => true }));
    expect(w.state.committedFiles).toEqual([['src/a.ts', 'src/b.ts']]);
  });

  it('-a → file baru ikut tanpa ditanya', async () => {
    const w = createWorld();
    const confirm = vi.fn(async () => false);
    await runPr({ ...opts, all: true }, w.deps({ confirm }));
    expect(confirm).not.toHaveBeenCalled();
    expect(w.state.committedFiles).toEqual([['src/a.ts', 'src/b.ts']]);
  });

  it('-y tanpa -a → file baru tidak ikut, tanpa ditanya', async () => {
    const w = createWorld();
    const confirm = vi.fn(async () => true);
    await runPr(opts, w.deps({ confirm }));
    expect(confirm).not.toHaveBeenCalled();
    expect(w.state.committedFiles).toEqual([['src/a.ts']]);
  });

  it('non-interaktif tanpa -a → file baru tidak ikut + warning', async () => {
    const w = createWorld();
    await runPr({ ...baseOpts }, w.deps({ interactive: false }));
    expect(w.state.committedFiles).toEqual([['src/a.ts']]);
    expect(w.log.lines.some((l) => l.startsWith('warn:') && l.includes('Pakai -a'))).toBe(true);
  });

  it('sudah ada file di-stage → hanya itu yang di-commit, tidak ada git add', async () => {
    const w = createWorld({ wt: { staged: ['README.md'], unstaged: ['src/a.ts'], untracked: ['.DS_Store'] } });
    const confirm = vi.fn(async () => true);
    await runPr({ ...opts, all: true }, w.deps({ confirm }));
    expect(w.git.stageTracked).not.toHaveBeenCalled();
    expect(w.git.stagePaths).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(w.state.committedFiles).toEqual([['README.md']]);
  });

  it('repo git terpisah (folder/) tidak pernah ikut, bahkan dengan -a', async () => {
    const w = createWorld({ wt: { staged: [], unstaged: ['README.md'], untracked: ['src/shared-libs/', '.DS_Store'] } });
    await runPr({ ...opts, all: true }, w.deps());
    expect(w.state.committedFiles).toEqual([['README.md', '.DS_Store']]);
    expect(w.log.lines.some((l) => l.includes("'src/shared-libs/' adalah repo git terpisah"))).toBe(true);
  });

  it('hanya file baru, ditolak → tidak ada commit, lanjut push & PR', async () => {
    const w = createWorld({ wt: { staged: [], unstaged: [], untracked: ['notes.txt'] } });
    const res = await runPr(baseOpts, w.deps({ confirm: async () => false }));
    expect(w.git.commitStaged).not.toHaveBeenCalled();
    expect(res.committed).toBe(false);
    expect(w.state.pushes).toBe(1);
  });

  it('file yang kemungkinan rahasia ditandai', async () => {
    const w = createWorld({ wt: { staged: [], unstaged: ['README.md'], untracked: ['.env.local'] } });
    await runPr(baseOpts, w.deps({ confirm: async () => false }));
    expect(w.log.lines.some((l) => l.includes('.env.local') && l.includes('rahasia'))).toBe(true);
  });
});

describe('runPr — dry-run', () => {
  it('tidak commit, push, membuat PR, transisi, kirim Teams, atau copy', async () => {
    const w = createWorld();
    const sendTeams = vi.fn();
    const res = await runPr({ ...baseOpts, dryRun: true }, w.deps({ sendTeams }));
    expect(w.git.commitStaged).not.toHaveBeenCalled();
    expect(w.git.push).not.toHaveBeenCalled();
    expect(w.git.stageTracked).not.toHaveBeenCalled();
    expect(w.git.stagePaths).not.toHaveBeenCalled();
    expect(w.gh.createPr).not.toHaveBeenCalled();
    expect(w.jstate.posts).toBe(0);
    expect(sendTeams).not.toHaveBeenCalled();
    expect(w.state.copied).toEqual([]);
    expect(res).toMatchObject({ jira: 'planned', teams: 'planned' });
    expect(res.message.text).toContain('Task: Review PR LOGIS-3938');
    expect(w.log.lines.join('\n')).toMatch(/\[dry-run\] Akan commit 1 file: "LOGIS-3938: tambah enrichment"/);
    expect(w.log.lines.join('\n')).toMatch(/Ada 1 file baru .* default TIDAK ikut/);
  });
});

describe('runPr — langkah non-kritis gagal', () => {
  it('transisi tidak tersedia → warning + daftar transisi, proses lanjut', async () => {
    const w = createWorld({ status: 'Defect Bugs' });
    const res = await runPr(baseOpts, w.deps());
    expect(res.jira).toBe('unavailable');
    expect(res.teams).toBe('sent');
    expect(w.log.lines.some((l) => l.startsWith('warn:') && l.includes("Berhenti di status 'Defect Bugs'"))).toBe(true);
    expect(w.log.lines.some((l) => l.startsWith('warn:') && l.includes('Transisi yang ada:') && l.includes('In Fixing'))).toBe(true);
    expect(w.jstate.posts).toBe(0);
  });

  it('Teams gagal → warning, pesan dicetak untuk dikirim manual, link PR tetap tercetak', async () => {
    const w = createWorld();
    const res = await runPr(
      baseOpts,
      w.deps({
        sendTeams: async () => {
          throw new CliError('Flow Teams menolak request (403).', { hint: 'Who can trigger = Anyone' });
        },
      }),
    );
    expect(res.teams).toBe('failed');
    expect(w.log.lines.some((l) => l.includes('dikirim manual'))).toBe(true);
    expect(w.state.stdout).toEqual([PR_URL]);
  });

  it('jawaban "n" di konfirmasi → cancelled', async () => {
    const w = createWorld();
    const res = await runPr(baseOpts, w.deps({ confirm: async () => false }));
    expect(res.teams).toBe('cancelled');
    expect(w.state.teams).toHaveLength(0);
  });

  it('-y melewati konfirmasi', async () => {
    const w = createWorld();
    const confirm = vi.fn(async () => false);
    const res = await runPr({ ...baseOpts, yes: true }, w.deps({ confirm }));
    expect(confirm).not.toHaveBeenCalled();
    expect(res.teams).toBe('sent');
  });

  it('non-interaktif tanpa -y → Teams dilewati dengan warning', async () => {
    const w = createWorld();
    const res = await runPr(baseOpts, w.deps({ interactive: false }));
    expect(res.teams).toBe('skipped');
  });

  it('--no-jira & --no-teams', async () => {
    const w = createWorld();
    const res = await runPr({ ...baseOpts, jira: false, teams: false }, w.deps({ sendTeams: null }));
    expect(w.jira.moveToStatus).not.toHaveBeenCalled();
    expect(res).toMatchObject({ jira: 'skipped', teams: 'skipped' });
  });
});

describe('runPr — validasi awal (gagal kritis, tidak ada efek samping)', () => {
  const cases: Array<[string, (w: ReturnType<typeof createWorld>) => void, RegExp]> = [
    ['detached HEAD', (w) => (w.state.branch = null), /detached/],
    ['di branch development', (w) => (w.state.branch = 'development'), /branch utama/],
    ['di branch production', (w) => (w.state.branch = 'production'), /branch utama/],
    ['key tiket tidak ada', (w) => (w.state.branch = 'feature/tanpa-key'), /tidak ditemukan di nama branch/],
    ['gh belum login', (w) => (w.gh.authStatus = async () => ({ ok: false, detail: '' })), /belum login/],
    ['bukan repo git', (w) => (w.git.isRepo = async () => false), /bukan repository git/],
    [
      'tiket tidak bisa diakses di Jira',
      (w) =>
        (w.jira.getIssue = async () => {
          throw new CliError('Tiket LOGIS-3938 tidak ditemukan atau Anda tidak punya akses (404).');
        }),
      /tidak punya akses/,
    ],
  ];

  it.each(cases)('%s', async (_name, mutate, re) => {
    const w = createWorld();
    mutate(w);
    await expect(runPr(baseOpts, w.deps())).rejects.toThrow(re);
    expect(w.git.commitStaged).not.toHaveBeenCalled();
    expect(w.git.push).not.toHaveBeenCalled();
    expect(w.gh.createPr).not.toHaveBeenCalled();
  });

  it('ada perubahan tetapi tanpa -m', async () => {
    const w = createWorld();
    await expect(runPr({ jira: true, teams: true }, w.deps())).rejects.toThrow(/pesan commit tidak diberikan/);
  });

  it('config belum lengkap', async () => {
    const w = createWorld();
    await expect(runPr(baseOpts, w.deps({ config: { ...config, teamsWebhookUrl: '' } }))).rejects.toThrow(
      /Config belum lengkap: teamsWebhookUrl/,
    );
  });
});
