import { describe, expect, it, vi } from 'vitest';
import { runPr, type GitHubLike, type GitLike, type JiraLike, type RunDeps, type RunOptions } from '../src/cli/run.js';
import { DEFAULT_CONFIG, type Config } from '../src/config/index.js';
import type { PullRequest } from '../src/github/index.js';
import { pickTransition, type JiraTransition, type TransitionOutcome } from '../src/jira/index.js';
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
function createWorld(over: { branch?: string | null; dirty?: boolean; status?: string; transitions?: JiraTransition[] } = {}) {
  const state = {
    branch: over.branch === undefined ? 'feature/LOGIS-3938-bulk-last-route' : over.branch,
    dirty: over.dirty ?? true,
    commits: [] as string[],
    pushes: 0,
    prs: [] as PullRequest[],
    status: over.status ?? 'In Progress',
    posts: 0,
    teams: [] as TeamsPayload[],
    copied: [] as string[],
    stdout: [] as string[],
    notified: new Map<string, string>(),
  };
  const transitions = over.transitions ?? [
    { id: '11', name: 'Start', to: { name: 'In Progress' } },
    { id: '21', name: 'Ready for review', to: { name: 'Code Review' } },
  ];

  const git: GitLike = {
    version: async () => 'git version 2.47.0.windows.1',
    isRepo: async () => true,
    currentBranch: async () => state.branch,
    isDirty: async () => state.dirty,
    changedFiles: async () => (state.dirty ? [' M src/a.ts', '?? src/b.ts'] : []),
    remoteUrl: async () => `https://github.com/${REPO}.git`,
    commitAll: vi.fn(async (m: string) => {
      state.commits.push(m);
      state.dirty = false;
    }),
    push: vi.fn(async () => {
      state.pushes++;
    }),
    lastCommitSubject: async () => state.commits.at(-1)?.split('\n')[0] ?? 'LOGIS-3938: commit lama',
  };

  const gh: GitHubLike = {
    version: async () => 'gh version 2.80.0',
    authStatus: async () => ({ ok: true, detail: 'Logged in' }),
    findOpenPr: async () => state.prs[0] ?? null,
    createPr: vi.fn(async (input) => {
      state.prs.push({ number: 1886, url: PR_URL, title: input.title, isDraft: Boolean(input.draft), baseRefName: input.base });
      return PR_URL;
    }),
  };

  const jira: JiraLike = {
    getIssue: async (key) => ({ key, summary: SUMMARY, status: state.status }),
    moveToStatus: vi.fn(async (_key: string, target: string, opts?: { currentStatus?: string; dryRun?: boolean }) => {
      const current = opts?.currentStatus ?? state.status;
      if (current.toLowerCase() === target.toLowerCase()) return { kind: 'already', status: current } as TransitionOutcome;
      const t = pickTransition(transitions, target);
      if (!t) return { kind: 'unavailable', available: transitions.map((x) => x.name) } as TransitionOutcome;
      if (opts?.dryRun) return { kind: 'planned', transition: t } as TransitionOutcome;
      state.posts++;
      state.status = t.to?.name ?? target;
      return { kind: 'moved', transition: t } as TransitionOutcome;
    }),
  };

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
  return { state, git, gh, jira, log, deps };
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
    expect(w.state.status).toBe('Code Review');
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
    expect(w.state.posts).toBe(1);
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
    expect(w.git.commitAll).not.toHaveBeenCalled();
    expect(w.state.pushes).toBe(1);
    expect(w.gh.createPr).toHaveBeenCalledWith(expect.objectContaining({ title: 'LOGIS-3938: commit lama' }));
  });

  it('opsi -b, -d, -t diteruskan', async () => {
    const w = createWorld({ branch: 'feature/no-key' });
    const res = await runPr({ ...baseOpts, base: 'staging', draft: true, ticket: '4001' }, w.deps());
    expect(res.ticketKey).toBe('LOGIS-4001');
    expect(w.gh.createPr).toHaveBeenCalledWith(expect.objectContaining({ base: 'staging', draft: true }));
  });
});

describe('runPr — dry-run', () => {
  it('tidak commit, push, membuat PR, transisi, kirim Teams, atau copy', async () => {
    const w = createWorld();
    const sendTeams = vi.fn();
    const res = await runPr({ ...baseOpts, dryRun: true }, w.deps({ sendTeams }));
    expect(w.git.commitAll).not.toHaveBeenCalled();
    expect(w.git.push).not.toHaveBeenCalled();
    expect(w.gh.createPr).not.toHaveBeenCalled();
    expect(w.state.posts).toBe(0);
    expect(sendTeams).not.toHaveBeenCalled();
    expect(w.state.copied).toEqual([]);
    expect(res).toMatchObject({ jira: 'planned', teams: 'planned' });
    expect(res.message.text).toContain('Task: Review PR LOGIS-3938');
    expect(w.log.lines.join('\n')).toMatch(/\[dry-run\] Akan commit 2 file: "LOGIS-3938: tambah enrichment"/);
  });
});

describe('runPr — langkah non-kritis gagal', () => {
  it('transisi tidak tersedia → warning + daftar transisi, proses lanjut', async () => {
    const w = createWorld({ transitions: [{ id: '31', name: 'Done', to: { name: 'Done' } }] });
    const res = await runPr(baseOpts, w.deps());
    expect(res.jira).toBe('unavailable');
    expect(res.teams).toBe('sent');
    expect(w.log.lines.some((l) => l.startsWith('warn:') && l.includes('Transisi yang ada: Done'))).toBe(true);
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
    ['di base branch', (w) => (w.state.branch = 'development'), /base branch 'development'/],
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
    expect(w.git.commitAll).not.toHaveBeenCalled();
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
