import { missingFields, ENV_VARS, parseReviewers, splitList, type Config } from '../config/index.js';
import {
  basesForChoice,
  isEmbeddedRepo,
  isHotfixBranch,
  looksSensitive,
  parseRemoteUrl,
  planCommit,
  type BaseChoice,
  type Git,
} from '../git/index.js';
import { analyzeDependentTicket, dependentRejections, detectDependencies } from '../git/dependent.js';
import {
  analyzeTicket,
  describeProblems,
  integrationBranchName,
  planIntegration,
  validateIntegrationTip,
  validatePrDiff,
  type IntegrationPlan,
  type IsolationContext,
  type PrDiffReport,
  type Problem,
  type TicketAnalysis,
} from '../git/isolation.js';
import { prNumberFromUrl, type GitHub, type PullRequest } from '../github/index.js';
import type { JiraClient, JiraIssue, TransitionStep } from '../jira/index.js';
import {
  buildDesc,
  buildPrBody,
  buildTeamsMessage,
  ensureCommitPrefix,
  extractTicketKey,
  messageHasTicket,
  normalizeTicketKey,
  serviceFromRepo,
  stripTicketPrefix,
  syncDependsOnSection,
  ticketUrl as buildTicketUrl,
  type TeamsMessage,
} from '../message/index.js';
import { buildPayload, type TeamsSender } from '../teams/index.js';
import { CliError, errorMessage } from '../utils/errors.js';
import { boxed, type Logger, type Symbols } from '../utils/term.js';

export const TEAMS_CHAT_NAME = 'Oknum LOGis';

export interface RunOptions {
  message?: string;
  ticket?: string;
  base?: string;
  draft?: boolean;
  yes?: boolean;
  /** -a/--all: ikutkan file baru (untracked) tanpa ditanya. */
  all?: boolean;
  /** -r/--reviewers: override config prReviewers (dipisah koma; 'none' = tanpa reviewer). */
  reviewers?: string;
  /** false bila --no-jira */
  jira: boolean;
  /** false bila --no-teams */
  teams: boolean;
  dryRun?: boolean;
  /** --push-ticket: push branch tiket walau PR-nya hanya lewat branch integrasi. */
  pushTicket?: boolean;
  /** --dependent: tiket bergantung pada kode development; PR langsung branch tiket → development. */
  dependent?: boolean;
}

export type GitLike = Pick<
  Git,
  | 'version'
  | 'isRepo'
  | 'currentBranch'
  | 'status'
  | 'remoteUrl'
  | 'stageTracked'
  | 'stagePaths'
  | 'commitStaged'
  | 'push'
  | 'lastCommitSubject'
  | 'fetch'
  | 'refExists'
  | 'commitsBetween'
  | 'snapshotCommit'
  | 'mergeCheck'
  | 'remotes'
  | 'inProgressOperations'
  | 'resolve'
  | 'isAncestor'
  | 'revList'
  | 'commitMeta'
  | 'patchIds'
  | 'patchIdsOf'
  | 'remoteBranchesContaining'
  | 'filesOfCommit'
  | 'prDiffFiles'
  | 'isValidBranchName'
  | 'fetchOptional'
  | 'createBranchAt'
  | 'fastForwardBranch'
  | 'pushBranch'
  | 'replayDetached'
  | 'commitsTouching'
  | 'mergeCommits'
  | 'mergeSideFiles'
  | 'mergeCheckReadOnly'
>;
export type GitHubLike = Pick<GitHub, 'version' | 'authStatus' | 'findOpenPr' | 'createPr' | 'ensureReviewers' | 'prDetails' | 'prBody' | 'editPrBody'>;
export type JiraLike = Pick<JiraClient, 'getIssue' | 'moveToStatus'>;

export interface RunDeps {
  config: Config;
  git: GitLike;
  gh: GitHubLike;
  /** null bila kredensial Jira belum diisi. */
  jira: JiraLike | null;
  /** null bila --no-teams. */
  sendTeams: TeamsSender | null;
  /** Pertanyaan ya/tidak; `defaultYes` menentukan jawaban saat Enter. */
  confirm: (question: string, defaultYes: boolean) => Promise<boolean>;
  /** Pilihan tunggal (dipakai untuk memilih target PR hotfix). */
  choose: <T extends string>(question: string, choices: ReadonlyArray<{ name: string; value: T }>, defaultValue: T) => Promise<T>;
  /** Catatan PR yang sudah diumumkan ke Teams (anti kirim ganda saat dijalankan ulang). */
  notified?: NotifiedStore;
  copy: (text: string) => Promise<boolean>;
  log: Logger;
  symbols: Symbols;
  /** stdin & stderr adalah terminal (prompt bisa ditampilkan). */
  interactive: boolean;
  /** Tulis hasil akhir (link PR) ke stdout. */
  printResult: (line: string) => void;
}

export interface NotifiedStore {
  sentAt(prUrl: string): Promise<string | null>;
  markSent(prUrl: string): Promise<void>;
}

export interface PrResult {
  base: string;
  head: string;
  url: string;
  number: number | null;
  created: boolean;
}

export type ReviewersStep = 'requested' | 'already' | 'planned' | 'failed' | 'skipped';

export type JiraStep = 'moved' | 'already' | 'planned' | 'unavailable' | 'failed' | 'skipped';
export type TeamsStep = 'sent' | 'already-sent' | 'planned' | 'cancelled' | 'failed' | 'skipped';

export interface RunResult {
  ticketKey: string;
  branch: string;
  repo: string;
  /** Base PR yang dituju (urut: production dulu). */
  bases: string[];
  /** PR pertama (kompatibilitas). */
  prUrl: string;
  prs: PrResult[];
  prCreated: boolean;
  committed: boolean;
  reviewers: ReviewersStep;
  jira: JiraStep;
  teams: TeamsStep;
  message: TeamsMessage;
  /** Tiket dependensi yang terdeteksi (hanya --dependent). */
  dependsOn: string[];
}

function firstLine(s: string): string {
  return s.split(/\r?\n/)[0]?.trim() ?? '';
}

/**
 * Orkestrasi utama: validasi → commit & push → PR → Jira → Teams → ringkasan.
 * Langkah 1–2 kritis (melempar CliError); langkah 3–4 non-kritis (warning, lanjut).
 * Idempoten: PR yang sudah ada dipakai ulang, tiket yang sudah di status target dilewati.
 */
export async function runPr(opts: RunOptions, deps: RunDeps): Promise<RunResult> {
  const { config, git, gh, log } = deps;
  const dry = Boolean(opts.dryRun);
  const dependent = Boolean(opts.dependent);
  if (dry) {
    log.info('Mode --dry-run: tidak ada commit, branch baru, push, PR, transisi Jira, maupun pesan Teams.');
    log.dim('  Mutasi git yang tetap terjadi: git fetch (remote-tracking refs) dan objek sementara untuk simulasi');
    log.dim('  (commit bayangan, cherry-pick di worktree sementara yang langsung dihapus). Branch, index, dan file Anda tidak berubah.');
  }

  // ── Validasi awal ────────────────────────────────────────────────────────────
  log.step('Validasi');
  const big = (lines: string[]) => {
    const rule = deps.symbols.line.repeat(64);
    log.fail(rule);
    for (const l of lines) log.fail(l);
    log.fail(rule);
  };
  log.ok(await git.version());
  log.ok(await gh.version());

  const auth = await gh.authStatus();
  if (!auth.ok) {
    throw new CliError(`GitHub CLI belum login atau token tidak valid${auth.detail ? ` (${auth.detail})` : ''}.`, {
      hint: 'Cek detail dengan: gh auth status. Bila GH_TOKEN/GITHUB_TOKEN ter-set di shell, hapus (unset) atau perbarui. Lalu: gh auth login',
    });
  }
  log.ok('gh sudah login');

  if (!(await git.isRepo())) {
    throw new CliError('Folder ini bukan repository git.', { hint: 'Masuk ke folder repo, mis. cd SELOG_LOGIS_ServiceOrder' });
  }

  // F1: commit di tengah merge/cherry-pick/rebase bisa membawa history branch lain ke branch tiket.
  const ops = await git.inProgressOperations();
  if (ops.length) {
    big([
      `ADA OPERASI GIT YANG BELUM SELESAI: ${ops.join(', ')}`,
      'Commit sekarang akan ikut menyelesaikan operasi itu dan bisa membawa',
      'history branch lain (mis. development) ke branch tiket.',
      'Tidak ada yang diubah.',
    ]);
    throw new CliError(`Dihentikan: ${ops.join(', ')} sedang berjalan.`, {
      hint:
        'Selesaikan atau batalkan sendiri dulu (git merge --abort / git cherry-pick --abort / git rebase --abort), ' +
        'periksa git status, lalu jalankan lagi.',
    });
  }

  const branch = await git.currentBranch();
  if (!branch) {
    throw new CliError('HEAD sedang detached (tidak di branch mana pun).', {
      hint: 'Checkout branch tiket dulu: git switch LOGIS-1234',
    });
  }

  const R = config.remote;
  const prod = config.productionBranch;
  const dev = config.baseBranch;
  const envs = [...new Set([...splitList(config.envBranches), dev])].filter((e) => e !== prod);
  if ([prod, ...envs].includes(branch)) {
    throw new CliError(`Anda sedang berada di branch '${branch}' (branch utama, bukan branch tiket).`, {
      hint: `Buat branch tiket dari ${prod}: git switch ${prod} && git pull && git switch -c LOGIS-1234`,
    });
  }

  const remoteUrl = await git.remoteUrl(R);
  const remote = parseRemoteUrl(remoteUrl);
  if (!remote) {
    throw new CliError(`Remote '${R}' bukan URL GitHub yang dikenali: ${remoteUrl}`);
  }
  const repoFull = `${remote.owner}/${remote.repo}`;
  const otherRemotes = (await git.remotes()).filter((r) => r !== R);
  if (otherRemotes.length) log.dim(`  Remote yang dipakai: ${R} (diabaikan: ${otherRemotes.join(', ')})`);
  const service = serviceFromRepo(remote.repo, config.repoPrefix);
  if (service === remote.repo) {
    log.warn(`Nama repo '${remote.repo}' tidak diawali '${config.repoPrefix}'; Service = nama repo.`);
  }

  const ticketKey = opts.ticket
    ? normalizeTicketKey(opts.ticket, config.jiraProjectKey)
    : extractTicketKey(branch, config.jiraProjectKey);
  if (!ticketKey) {
    throw new CliError(`Key tiket ${config.jiraProjectKey}-XXXX tidak ditemukan di nama branch '${branch}'.`, {
      hint: `Beri manual: logis-pr -t ${config.jiraProjectKey}-1234 ...`,
    });
  }

  const integrationFor = (b: string) => integrationBranchName(config.devBranchPattern, ticketKey, branch, b, dev);
  if (envs.some((e) => integrationFor(e) === branch)) {
    throw new CliError(`Branch '${branch}' adalah branch integrasi yang dikelola logis-pr.`, {
      hint: `Jalankan logis-pr dari branch tiket (mis. ${ticketKey}), bukan dari branch integrasi.`,
    });
  }

  // Target PR: -b menang; branch hotfix memilih production/development; selain itu development.
  const hotfix = isHotfixBranch(branch, splitList(config.hotfixPrefixes));
  if (dependent) {
    const rejected = dependentRejections({
      branch,
      hotfix,
      requestedBases: splitList(opts.base ?? ''),
      dev,
      prod,
      pushTicket: Boolean(opts.pushTicket),
    })[0];
    if (rejected) throw new CliError(rejected.message, { hint: rejected.hint });
  }
  let bases: string[];
  if (dependent) {
    bases = [dev];
  } else if (opts.base?.trim()) {
    bases = splitList(opts.base);
  } else if (hotfix) {
    let choice: BaseChoice = 'both';
    if (deps.interactive && !opts.yes && !dry) {
      choice = await deps.choose<BaseChoice>(
        `Branch hotfix: PR ke mana?`,
        [
          { name: `${prod} dan ${dev}`, value: 'both' },
          { name: `${prod} saja`, value: 'production' },
          { name: `${dev} saja`, value: 'development' },
        ],
        'both',
      );
    } else if (dry) {
      log.info(`[dry-run] Branch hotfix: target PR akan ditanyakan (default: ${prod} dan ${dev}).`);
    }
    bases = basesForChoice(choice, prod, dev);
  } else {
    bases = [dev];
  }
  if (bases.includes(branch)) {
    throw new CliError(`Branch '${branch}' tidak bisa di-PR ke dirinya sendiri.`);
  }
  for (const b of bases) {
    if (b !== prod && !(await git.isValidBranchName(integrationFor(b)))) {
      throw new CliError(`Nama branch integrasi '${integrationFor(b)}' tidak valid.`, { hint: 'Periksa devBranchPattern di config.' });
    }
  }
  const headFor = (b: string) => (b === prod || dependent ? branch : integrationFor(b));
  log.ok(`Repo ${repoFull} · branch tiket ${branch} · tiket ${ticketKey}`);
  log.ok(`PR: ${bases.map((b) => `${headFor(b)} → ${b}`).join(', ')}`);
  if (dependent) log.info(`Mode --dependent: branch tiket berbasis ${dev}, tanpa branch integrasi. Tiket ini belum bisa naik ke ${prod}.`);

  const missing = missingFields(config, { jira: opts.jira, teams: opts.teams });
  if (missing.length > 0) {
    throw new CliError(`Config belum lengkap: ${missing.join(', ')}.`, {
      hint: `Jalankan: logis-pr init — atau set env var ${missing.map((k) => ENV_VARS[k]).join(', ')}`,
    });
  }

  const wt = await git.status();
  const hasTrackedChanges = wt.staged.length + wt.unstaged.length > 0;
  if (hasTrackedChanges && !opts.message?.trim()) {
    throw new CliError('Ada perubahan yang belum di-commit, tetapi pesan commit tidak diberikan.', {
      hint: 'Contoh: logis-pr -m "tambah validasi payload"',
    });
  }
  if (!hasTrackedChanges && opts.all && wt.untracked.some((p) => !isEmbeddedRepo(p)) && !opts.message?.trim()) {
    throw new CliError('Opsi -a dipakai untuk mengikutkan file baru, tetapi pesan commit tidak diberikan.', {
      hint: 'Contoh: logis-pr -a -m "tambah modul baru"',
    });
  }

  if (dependent) {
    const devHead = integrationFor(dev);
    const devPr = await gh.findOpenPr(repoFull, devHead, dev);
    if (devPr) {
      throw new CliError(`Sudah ada PR open dari '${devHead}' ke '${dev}' (#${devPr.number}).`, {
        hint:
          `--dependent membuka PR dari branch tiket, sehingga akan ada dua PR ke ${dev}. Tutup salah satu:\n` +
          `  tutup PR #${devPr.number} (${devPr.url}) lalu jalankan --dependent lagi, atau\n` +
          `  lanjutkan PR itu dengan logis-pr tanpa --dependent.`,
      });
    }
  }

  // ── Fetch (satu-satunya mutasi git saat --dry-run: remote-tracking refs) ──────
  const required = [...new Set([prod, ...bases])];
  try {
    await git.fetch(required, R);
  } catch {
    // dicek satu per satu di bawah agar pesannya jelas
  }
  for (const b of required) {
    if (!(await git.refExists(`${R}/${b}`))) {
      throw new CliError(`Branch '${b}' tidak ada di remote '${R}'.`, {
        hint:
          b === prod
            ? `logis-pr tidak mengganti branch produksi secara diam-diam. Set productionBranch (atau LOGIS_PR_PRODUCTION_BRANCH) sesuai repo ini.`
            : 'Periksa nama branch target (config baseBranch / opsi -b).',
      });
    }
  }
  const presentEnvs: string[] = [];
  for (const e of envs) {
    if (required.includes(e) || (await git.fetchOptional(e, R))) presentEnvs.push(e);
    else log.dim(`  Branch '${e}' tidak ada di ${R}; tidak dipakai untuk deteksi commit asing.`);
  }
  const integrations = dependent ? [] : bases.filter((b) => b !== prod).map((b) => ({ base: b, name: integrationFor(b) }));
  for (const i of integrations) await git.fetchOptional(i.name, R);
  if (dry) log.dim(`  [dry-run] git fetch ${R} ${[...required, ...presentEnvs].filter((v, i, a) => a.indexOf(v) === i).join(' ')} memperbarui remote-tracking refs.`);

  const ctx: IsolationContext = {
    remote: R,
    prod,
    envs: presentEnvs,
    ticketKey,
    ownBranches: [branch, ...integrations.map((i) => i.name)],
  };

  const tUrl = buildTicketUrl(config.jiraBaseUrl, ticketKey);
  let issue: JiraIssue | null = null;
  if (deps.jira) {
    try {
      issue = await deps.jira.getIssue(ticketKey);
      log.ok(`Jira ${ticketKey}: "${issue.summary}" [${issue.status}]`);
    } catch (err) {
      // Dengan Jira aktif, tiket yang tidak bisa diakses = gagal kritis (validasi di awal).
      if (opts.jira) throw err;
      log.warn(`Tiket tidak bisa dibaca di Jira (${errorMessage(err)}); Desc memakai judul PR.`);
    }
  } else {
    log.warn('Kredensial Jira kosong; Desc memakai judul PR.');
  }

  // ── 1. Branch tiket ──────────────────────────────────────────────────────────
  log.step(`[1/5] Branch tiket ${branch}`);
  let committed = false;
  let commitMessage: string | undefined;
  const wantCommit = Boolean(opts.message?.trim());
  const nestedRepos = wt.untracked.filter(isEmbeddedRepo);
  const newFiles = wt.untracked.filter((p) => !isEmbeddedRepo(p));
  const listFiles = (files: readonly string[], max = 15) => {
    for (const f of files.slice(0, max)) {
      log.dim(`    ${f}${looksSensitive(f) ? `  ${deps.symbols.warn} kemungkinan berisi rahasia!` : ''}`);
    }
    if (files.length > max) log.dim(`    … dan ${files.length - max} file lain`);
  };

  for (const repo of nestedRepos) {
    log.warn(`'${repo}' adalah repo git terpisah — tidak pernah ikut di-commit otomatis.`);
  }

  // Tentukan file baru yang ikut (hanya relevan bila belum ada yang di-stage manual).
  let approvedNew: string[] = [];
  if (wantCommit && wt.staged.length === 0 && newFiles.length > 0) {
    if (opts.all) {
      approvedNew = newFiles;
      log.info(`-a: ${newFiles.length} file baru ikut di-commit.`);
    } else if (dry) {
      log.info(`[dry-run] Ada ${newFiles.length} file baru (belum dilacak git). Akan ditanyakan dulu, default TIDAK ikut:`);
      listFiles(newFiles);
    } else if (deps.interactive && !opts.yes) {
      log.plain(`Ada ${newFiles.length} file baru yang belum dilacak git:`);
      listFiles(newFiles, 30);
      approvedNew = (await deps.confirm(`Ikutkan ${newFiles.length} file baru ini ke commit?`, false)) ? newFiles : [];
    } else {
      // -y hanya melewati konfirmasi; untuk file baru jawaban amannya selalu "tidak".
      log.warn(
        `${newFiles.length} file baru tidak ikut di-commit (${opts.yes ? '-y' : 'terminal non-interaktif'}). Pakai -a untuk mengikutkan.`,
      );
      listFiles(newFiles);
    }
  }

  const plan = planCommit(wt, approvedNew);
  const willCommit = wantCommit && plan.files.length > 0;
  if (willCommit) commitMessage = ensureCommitPrefix(opts.message ?? '', ticketKey);
  // Commit bayangan = isi branch tiket SETELAH commit, tanpa menyentuh branch/index/file.
  // --dependent memvalidasi pesan commit, jadi commit bayangan harus membawa pesan sungguhan.
  const snapshot = await git.snapshotCommit(willCommit ? plan : { ...plan, files: [] }, dependent ? commitMessage : undefined);

  const stopProblems = (title: string, problems: readonly Problem[], hint: string, exitCode = 1): never => {
    big([title, ...describeProblems(problems), 'Tidak ada push, PR, transisi Jira, maupun pesan Teams yang dijalankan.']);
    throw new CliError(`Dihentikan: ${title.toLowerCase()}.`, { hint, exitCode });
  };
  const ticketHint =
    `Buat ulang branch tiket dari ${prod} lalu ambil commit Anda saja:\n` +
    `  git switch ${prod} && git pull\n` +
    `  git switch -c ${branch}-v2\n` +
    `  git cherry-pick <sha commit Anda>\n` +
    `Untuk sinkron dengan ${prod}, merge ${R}/${prod} (bukan ${dev}/staging).`;
  const dependentHint =
    `Dengan --dependent, setiap commit di ${R}/${dev}..HEAD harus memuat key ${ticketKey}. Buat ulang branch dari ${dev}:\n` +
    `  git switch -c ${branch}-v2 ${R}/${dev}\n` +
    `  git cherry-pick <sha commit Anda>\n` +
    `Untuk sinkron, merge ${R}/${dev} saja. Tiket lain yang belum masuk ${dev} harus di-merge dulu ke ${dev}.`;
  const stopHint = dependent ? dependentHint : ticketHint;
  const dependencyScope = { remote: R, prod, base: dev, projectKey: config.jiraProjectKey, ticketKey };

  /**
   * Jalur normal berhenti karena commit development/staging: bila commit tiket tidak bisa di-cherry-pick ke
   * production (simulasi di worktree sementara), kemungkinan besar tiket memang bergantung pada kode development.
   */
  const ticketStopHint = async (t: TicketAnalysis, head: string): Promise<string> => {
    const fromEnv = t.problems.some(
      (p) => p.kind === 'env-commit' || p.kind === 'env-patch' || (p.kind === 'merge' && presentEnvs.includes(p.source)),
    );
    // Hotfix dan -b selain development akan ditolak --dependent, jadi jangan disarankan.
    if (!fromEnv || hotfix || bases.length !== 1 || bases[0] !== dev) return ticketHint;
    try {
      const metas = await git.commitMeta(await git.revList(head, [`${R}/${dev}`]));
      const own = metas.filter((m) => m.parents.length < 2 && ((willCommit && m.sha === head) || messageHasTicket(m.body, ticketKey)));
      if (own.length === 0) return ticketHint;
      const pick = await git.replayDetached(`${R}/${prod}`, own.map((c) => ({ kind: 'pick', sha: c.sha })));
      // Gagal tanpa file konflik berarti bukan konflik (mis. identitas git belum diisi).
      if (pick.ok || pick.files.length === 0) return ticketHint;
      const deps = await detectDependencies(git, dependencyScope, own);
      return [
        `Tiket tampaknya bergantung pada kode ${dev}: cherry-pick commit tiket ke ${prod} konflik di:`,
        ...pick.files.slice(0, 10).map((f) => `  ${f}`),
        `Jalankan logis-pr --dependent untuk PR ke ${dev}.`,
        ...(deps.length ? [`Dependensi terdeteksi: ${deps.join(', ')}`] : []),
        `Bila ternyata tidak bergantung: ${ticketHint}`,
      ].join('\n');
    } catch {
      return ticketHint; // simulasi hanya untuk saran; kegagalannya tidak boleh mengubah hasil validasi
    }
  };

  const analyzeHead = (head: string) => (dependent ? analyzeDependentTicket(git, ctx, dev, head) : analyzeTicket(git, ctx, head));
  const analyze = async (head: string) => {
    const t = await analyzeHead(head);
    if (t.problems.length) {
      const hint = dependent ? dependentHint : await ticketStopHint(t, head);
      stopProblems('BRANCH TIKET MEMBAWA COMMIT YANG BUKAN MILIK TIKET', t.problems, hint);
    }
    return t;
  };
  let ticket = await analyze(snapshot);
  for (const w of ticket.warnings) log.warn(w);
  const homeBranch = dependent ? dev : prod;
  if (ticket.commits.length === 0) {
    throw new CliError(`Branch '${branch}' belum punya commit tiket di luar '${homeBranch}'.`, {
      hint: 'Buat perubahan lalu jalankan dengan -m "pesan commit".',
    });
  }
  log.ok(`Branch tiket berbasis '${homeBranch}', ${ticket.commits.length} commit tiket:`);
  for (const c of ticket.commits) log.dim(`    ${c.sha === snapshot ? '(commit baru)' : c.short} ${c.sha === snapshot ? firstLine(commitMessage ?? '') : c.subject}`);
  if (ticket.syncMerges.length) log.dim(`    + ${ticket.syncMerges.length} merge sinkronisasi dari ${homeBranch}${dependent ? '' : ' (tidak di-cherry-pick)'}`);

  // ── 2. Branch integrasi & validasi isi PR (simulasi penuh, belum mengubah ref) ──
  interface Target {
    base: string;
    head: string;
    tip: string;
    plan: IntegrationPlan | null;
    report: PrDiffReport;
  }
  const prepare = async (t: TicketAnalysis, ticketHead: string, label: string): Promise<Target[]> => {
    const out: Target[] = [];
    for (const b of bases) {
      if (b === prod || dependent) {
        const conflict = await git.mergeCheck(`${R}/${b}`, ticketHead);
        if (!conflict.clean) await stopConflict(b, branch, conflict.conflicts);
        const report = await validatePrDiff(git, ctx, t, b, ticketHead);
        if (report.problems.length) stopProblems(`ISI PR ${branch} → ${b} TIDAK BERSIH`, report.problems, stopHint);
        out.push({ base: b, head: branch, tip: ticketHead, plan: null, report });
        continue;
      }
      const name = integrationFor(b);
      const ip = await planIntegration(git, ctx, t, b, name);
      if (ip.problems.length) {
        stopProblems(
          `BRANCH INTEGRASI '${name}' TIDAK BERSIH`,
          ip.problems,
          `logis-pr tidak menimpa/menghapus branch. Periksa isinya: git log --oneline ${R}/${prod}..${name}\n` +
            `Bila memang salah, ganti nama branch lama (git branch -m ${name} ${name}-old) lalu jalankan lagi.`,
        );
      }
      if (ip.toPick.length === 0 && !ip.existed) {
        log.info(`${label}Semua commit tiket sudah ada di '${b}' — PR ke ${b} tidak diperlukan.`);
        continue;
      }
      const pick = await git.replayDetached(ip.start, ip.steps);
      if (!pick.ok) {
        big([
          `CHERRY-PICK KE '${name}' KONFLIK`,
          `Commit ${pick.failedAt.slice(0, 7)} tidak bisa diterapkan di atas ${ip.existed ? name : `titik awal branch tiket di ${prod}`}:`,
          ...pick.files.slice(0, 15).map((f) => `  ${f}`),
          'Simulasi dilakukan di worktree sementara; branch tiket & branch integrasi tidak diubah.',
        ]);
        throw new CliError('Dihentikan: cherry-pick ke branch integrasi konflik.', {
          exitCode: 2,
          hint: ip.existed
            ? `Branch integrasi sudah berisi perubahan lain. Selesaikan manual: git switch ${name} && git cherry-pick -x ${pick.failedAt.slice(0, 7)}`
            : `Laporkan ke maintainer logis-pr: commit tiket seharusnya bisa diputar ulang di titik awalnya.`,
        });
      }
      const post = await validateIntegrationTip(git, ctx, t, b, name, pick.sha);
      if (post.length) stopProblems(`HASIL CHERRY-PICK '${name}' TIDAK BERSIH`, post, 'Laporkan ke maintainer logis-pr.');
      const conflict = await git.mergeCheck(`${R}/${b}`, pick.sha);
      if (!conflict.clean) await stopConflict(b, name, conflict.conflicts);
      const report = await validatePrDiff(git, ctx, t, b, pick.sha);
      if (report.problems.length) stopProblems(`ISI PR ${name} → ${b} TIDAK BERSIH`, report.problems, ticketHint);
      out.push({ base: b, head: name, tip: pick.sha, plan: ip, report });
    }
    return out;
  };
  const stopConflict = async (b: string, head: string, files: string[]): Promise<never> => {
    const unsynced = b === prod || dependent ? [] : await git.commitsBetween(`${R}/${prod}`, [`${R}/${b}`]);
    big([
      'KONFLIK — PROSES DIHENTIKAN',
      `Merge ${head} → ${b} akan konflik di ${files.length} file:`,
      ...files.slice(0, 15).map((f) => `  ${f}`),
      ...(files.length > 15 ? [`  … dan ${files.length - 15} file lain`] : []),
      ...(unsynced.length
        ? [
            `Catatan: ${prod} punya ${unsynced.length} commit yang belum ada di ${b} (ikut terbawa sebagai baseline);`,
            `konflik bisa berasal dari sana, bukan dari commit tiket:`,
            ...unsynced.slice(0, 5).map((c) => `  ${c.line}`),
          ]
        : []),
      'Tidak ada push, PR, transisi Jira, maupun pesan Teams yang dijalankan.',
    ]);
    throw new CliError('Dihentikan karena konflik.', {
      exitCode: 2,
      hint: dependent
        ? `Di mode --dependent konflik diselesaikan di branch tiket:\n` +
          `  git merge ${R}/${b}   → selesaikan konflik → commit\n` +
          `Lalu jalankan logis-pr --dependent lagi. Merge dari ${R}/${b} diizinkan di mode ini.`
        : b === prod
          ? `Sinkronkan branch tiket dengan ${prod} (git merge ${R}/${prod}), selesaikan konflik, lalu jalankan lagi.`
          : `Konflik khusus '${b}' diselesaikan di branch integrasi, BUKAN di branch tiket:\n` +
            `  git switch ${integrationFor(b)}   (setelah logis-pr membuatnya, atau buat dari ${R}/${prod})\n` +
            `  git merge ${R}/${b}   → selesaikan konflik → commit → git switch ${branch}\n` +
            `Lalu jalankan logis-pr lagi. Branch tiket tetap bersih dari ${b}.` +
            (unsynced.length ? `\nBila konflik dari commit ${prod} yang belum di-merge balik ke ${b}, minta lead menyinkronkan ${prod} → ${b} dulu.` : ''),
    });
  };

  log.step(`[2/5] Validasi isi PR`);
  let targets = await prepare(ticket, snapshot, dry ? '[dry-run] ' : '');
  const showTargets = (ts: Target[]) => {
    for (const t of ts) {
      const p = t.plan;
      if (p) {
        const what = p.existed ? `perbarui '${p.name}'` : `buat '${p.name}' dari ${prod} (titik awal branch tiket)`;
        log.ok(`${what}: ${p.toPick.length} commit di-cherry-pick, ${p.present.length} sudah ada${p.inBase.length ? `, ${p.inBase.length} sudah ada di ${t.base}` : ''}`);
      }
      const r = t.report;
      log.ok(
        `PR ${t.head} → ${t.base}: ${r.ticket.length} commit tiket` +
          `${r.baseline.length ? `, ${r.baseline.length} commit baseline ${prod}` : ''}` +
          `${r.sync.length ? `, ${r.sync.length} merge sinkronisasi` : ''} · ${r.files.length} file`,
      );
      if (r.baseline.length) log.dim(`    Baseline = commit ${prod} yang belum ada di ${t.base}; ikut tampil di PR.`);
    }
  };
  showTargets(targets);

  let dependsOn: string[] = [];
  if (dependent) {
    dependsOn = await detectDependencies(git, dependencyScope, ticket.commits);
    if (dependsOn.length) {
      log.ok(`Dependensi terdeteksi (menyentuh file yang sama, belum ada di ${prod}): ${dependsOn.join(', ')}`);
    } else {
      log.info(`Tidak ada dependensi terdeteksi dari file yang disentuh tiket ini.`);
    }
  }

  if (targets.length === 0) {
    throw new CliError('Tidak ada PR yang perlu dibuat: semua commit tiket sudah ada di target.', { exitCode: 0 });
  }

  // Konfirmasi allowlist: developer menyatakan semua commit di atas memang milik tiket.
  if (!dry && deps.interactive && !opts.yes) {
    const ok = await deps.confirm(`Semua ${ticket.commits.length} commit tiket di atas memang milik ${ticketKey}?`, false);
    if (!ok) {
      throw new CliError('Dibatalkan: daftar commit tidak dikonfirmasi. Tidak ada yang diubah.', {
        hint: `Rapikan branch tiket (buat ulang dari ${homeBranch} + cherry-pick commit yang benar), lalu jalankan lagi.`,
      });
    }
  }

  // ── 3. Commit, update branch integrasi, push, PR ──────────────────────────────
  log.step(`[3/5] Commit, push & Pull Request`);
  if (!wantCommit) {
    if (newFiles.length > 0) log.info(`${newFiles.length} file baru tidak ikut (tanpa -m tidak ada commit).`);
  } else if (plan.files.length === 0) {
    log.warn('Tidak ada file yang di-commit — pesan -m diabaikan.');
  } else if (dry) {
    log.info(`[dry-run] Akan commit ${plan.files.length} file: "${firstLine(commitMessage ?? '')}"`);
    listFiles(plan.files);
  } else {
    if (plan.mode === 'staged') log.info('Ada file yang sudah di-stage → hanya file tersebut yang di-commit.');
    if (plan.stageTracked) await git.stageTracked();
    if (plan.addUntracked.length) await git.stagePaths(plan.addUntracked);
    await git.commitStaged(commitMessage ?? '');
    committed = true;
    log.ok(`Commit ${plan.files.length} file: ${firstLine(commitMessage ?? '')}`);
    const left = plan.left.filter((p) => !isEmbeddedRepo(p));
    if (left.length) log.dim(`    ${left.length} file tidak ikut commit (tetap ada di folder Anda).`);
    // F2: validasi ulang pada commit SUNGGUHAN sebelum ada yang di-push.
    const realHead = (await git.resolve('HEAD')) as string;
    ticket = await analyzeHead(realHead);
    if (ticket.problems.length) {
      stopProblems(
        'BRANCH TIKET TIDAK BERSIH SETELAH COMMIT',
        ticket.problems,
        `Commit sudah dibuat di lokal tetapi TIDAK di-push. Batalkan bila perlu: git reset --soft HEAD~1`,
      );
    }
    targets = await prepare(ticket, realHead, '');
    if (dependent) dependsOn = await detectDependencies(git, dependencyScope, ticket.commits);
  }

  // Branch tiket hanya di-push bila ada PR darinya (production/hotfix), kecuali diminta. Push yang tidak
  // perlu memunculkan notice "Compare & pull request" di GitHub dan mengundang PR kedua ke development.
  const pushTicket = Boolean(opts.pushTicket) || config.pushTicketBranch === 'always' || targets.some((t) => !t.plan);
  const skipTicketPushNote =
    `Branch tiket '${branch}' tidak di-push: PR ke ${targets.map((t) => t.base).join(', ')} lewat branch integrasi. ` +
    `Pakai --push-ticket (atau config pushTicketBranch: always) bila ingin backup di remote.`;
  if (dry) {
    for (const t of targets) {
      if (t.plan) {
        log.info(
          `[dry-run] Akan ${t.plan.existed ? 'memperbarui' : 'membuat'} branch '${t.plan.name}' ` +
            `(cherry-pick -x: ${t.plan.toPick.map((c) => (c.sha === snapshot ? 'commit baru' : c.short)).join(', ') || '-'}` +
            `${t.plan.steps.some((x) => x.kind === 'merge') ? ' + merge sinkronisasi production' : ''}) lalu push`,
        );
      }
    }
    if (pushTicket) log.info(`[dry-run] Akan push branch tiket: git push --set-upstream ${R} ${branch}`);
    else log.dim(`  [dry-run] ${skipTicketPushNote}`);
  } else {
    for (const t of targets) {
      const p = t.plan;
      if (!p) continue;
      if (p.local === null) await git.createBranchAt(p.name, t.tip);
      else if (p.local !== t.tip) await git.fastForwardBranch(p.name, t.tip, p.local);
    }
    if (pushTicket) {
      await git.push(branch, R);
      log.ok(`Push ${R}/${branch}`);
    } else {
      log.dim(`  ${skipTicketPushNote}`);
    }
    for (const t of targets) {
      if (t.plan && t.plan.remote !== t.tip) {
        await git.pushBranch(t.plan.name, R);
        log.ok(`Push ${R}/${t.plan.name}`);
      }
    }
  }

  const subject = commitMessage ? firstLine(commitMessage) : await git.lastCommitSubject();
  let prTitle = subject ? ensureCommitPrefix(subject, ticketKey) : '';
  const baseBody = buildPrBody({ ticketKey, ticketUrl: tUrl, summary: issue?.summary });
  const body = dependent ? syncDependsOnSection(baseBody, dependsOn, config.jiraBaseUrl).body : baseBody;
  const prs: PrResult[] = [];
  bases = targets.map((t) => t.base);
  for (const t of targets) {
    if (t.plan) {
      const stale = await gh.findOpenPr(repoFull, branch, t.base);
      if (stale) log.warn(`Ada PR lama langsung dari branch tiket ke ${t.base} (#${stale.number}). PR yang benar sekarang dari '${t.head}'; tutup PR lama secara manual.`);
    }
    const existing: PullRequest | null = await gh.findOpenPr(repoFull, t.head, t.base);
    if (existing) {
      prs.push({ base: t.base, head: t.head, url: existing.url, number: existing.number, created: false });
      prTitle = prTitle || existing.title;
      log.ok(`PR ${t.head} → ${t.base} sudah ada, dipakai ulang: #${existing.number} ${existing.title}`);
      if (opts.draft && !existing.isDraft) log.warn(`PR ke ${t.base} sudah ada dan bukan draft; --draft diabaikan.`);
      continue;
    }
    if (dry) {
      prs.push({ base: t.base, head: t.head, url: `https://github.com/${repoFull}/pull/<baru-${t.base}>`, number: null, created: false });
      log.info(`[dry-run] Akan membuat PR${opts.draft ? ' (draft)' : ''} ${t.head} → ${t.base}`);
      log.dim(`    Judul: ${prTitle}`);
    } else {
      const url = await gh.createPr({ repo: repoFull, base: t.base, head: t.head, title: prTitle, body, draft: opts.draft });
      prs.push({ base: t.base, head: t.head, url, number: prNumberFromUrl(url), created: true });
      log.ok(`PR ${t.head} → ${t.base} dibuat: ${url}`);
    }
  }

  // Verifikasi PR di GitHub harus sama dengan validasi lokal (fail-closed: tidak diumumkan bila beda).
  if (!dry) {
    const mismatches: string[] = [];
    for (const pr of prs) {
      const t = targets.find((x) => x.base === pr.base);
      if (!t || !pr.number) continue;
      const d = await gh.prDetails(repoFull, pr.number);
      const expectedShas = new Set([...t.report.ticket, ...t.report.baseline, ...t.report.sync].map((m) => m.sha));
      const tag = `PR #${pr.number} (${pr.head} → ${pr.base})`;
      if (d.headRefName !== t.head) mismatches.push(`${tag}: head di GitHub '${d.headRefName}'`);
      if (d.baseRefName !== t.base) mismatches.push(`${tag}: base di GitHub '${d.baseRefName}'`);
      if (d.headRefOid !== t.tip) mismatches.push(`${tag}: ujung head di GitHub ${d.headRefOid.slice(0, 7)} ≠ lokal ${t.tip.slice(0, 7)}`);
      if (expectedShas.size <= 100) {
        const extra = d.commits.filter((c) => !expectedShas.has(c));
        if (extra.length) mismatches.push(`${tag}: ${extra.length} commit di GitHub tidak ada di validasi lokal (${extra.slice(0, 5).map((c) => c.slice(0, 7)).join(', ')})`);
        if (d.commits.length !== expectedShas.size) mismatches.push(`${tag}: GitHub ${d.commits.length} commit, lokal ${expectedShas.size}`);
      }
      if (d.changedFiles !== t.report.files.length) mismatches.push(`${tag}: GitHub ${d.changedFiles} file, lokal ${t.report.files.length}`);
    }
    if (mismatches.length) {
      big(['ISI PR DI GITHUB TIDAK SAMA DENGAN VALIDASI LOKAL', ...mismatches, 'Reviewer, Jira, dan Teams TIDAK dijalankan.']);
      throw new CliError('Dihentikan: verifikasi PR di GitHub gagal.', {
        exitCode: 3,
        hint: 'Buka PR di GitHub dan periksa tab Commits/Files. Bila salah, ubah ke draft/tutup PR secara manual, lalu jalankan logis-pr --audit.',
      });
    }
    if (prs.length) log.ok('Isi PR di GitHub cocok dengan validasi lokal.');
  }
  // Bagian depends-on di body PR (non-kritis). Teks di luar penanda tidak disentuh; isi sama → tidak ada request.
  if (dependent) {
    for (const pr of prs) {
      if (!pr.number) {
        if (dependsOn.length) log.info(`[dry-run] PR baru akan memuat bagian depends-on: ${dependsOn.join(', ')}`);
        continue;
      }
      try {
        const synced = syncDependsOnSection(await gh.prBody(repoFull, pr.number), dependsOn, config.jiraBaseUrl);
        if (synced.status === 'malformed') {
          log.warn(`Penanda depends-on di body PR #${pr.number} rusak (tidak berpasangan/ganda); body tidak diubah. Perbaiki manual di GitHub.`);
        } else if (synced.status !== 'unchanged') {
          const verb = synced.status === 'added' ? 'ditambahkan' : 'diperbarui';
          if (dry) {
            log.info(`[dry-run] Bagian depends-on di PR #${pr.number} akan ${verb}.`);
          } else {
            await gh.editPrBody(repoFull, pr.number, synced.body);
            log.ok(`Bagian depends-on di PR #${pr.number} ${verb}.`);
          }
        }
      } catch (err) {
        log.warn(`Gagal memperbarui bagian depends-on di PR #${pr.number}: ${errorMessage(err)}`);
        if (err instanceof CliError && err.hint) log.dim(`    Saran: ${err.hint}`);
      }
    }
  }

  const prUrl = prs[0]?.url ?? '';
  const prCreated = prs.some((p) => p.created);

  // Reviewer (non-kritis): gagal → warning, proses lanjut.
  const reviewers = opts.reviewers !== undefined ? parseReviewers(opts.reviewers) : parseReviewers(config.prReviewers);
  let reviewersStep: ReviewersStep = 'skipped';
  if (reviewers.length > 0) {
    if (dry) {
      reviewersStep = 'planned';
      log.info(`[dry-run] Akan meminta review dari: ${reviewers.join(', ')}`);
    } else {
      let anyRequested = false;
      let anyFailed = false;
      for (const pr of prs) {
        const tag = prs.length > 1 ? ` (PR ${pr.base})` : '';
        if (!pr.number) {
          anyFailed = true;
          log.warn(`Nomor PR tidak terbaca dari ${pr.url}; reviewer tidak di-assign.`);
          continue;
        }
        try {
          const r = await gh.ensureReviewers(repoFull, pr.number, reviewers);
          if (r.requested.length) log.ok(`Review diminta dari: ${r.requested.join(', ')}${tag}`);
          if (r.alreadyRequested.length) log.ok(`Reviewer sudah terpasang: ${r.alreadyRequested.join(', ')}${tag}`);
          if (r.alreadyReviewed.length) log.ok(`Sudah memberi review (tidak diminta ulang): ${r.alreadyReviewed.join(', ')}${tag}`);
          if (r.skippedAuthor.length) log.info(`Dilewati karena penulis PR sendiri: ${r.skippedAuthor.join(', ')}${tag}`);
          anyRequested ||= r.requested.length > 0;
        } catch (err) {
          anyFailed = true;
          log.warn(`Gagal meminta review${tag}: ${errorMessage(err)}`);
          if (err instanceof CliError && err.hint) log.dim(`    Saran: ${err.hint}`);
        }
      }
      reviewersStep = anyFailed ? 'failed' : anyRequested ? 'requested' : 'already';
    }
  }

  // ── 3. Jira → Code Review ────────────────────────────────────────────────────
  log.step(`[4/5] Jira → ${config.jiraReviewStatus}`);
  let jiraStep: JiraStep;
  if (!opts.jira || !deps.jira) {
    jiraStep = 'skipped';
    log.info('Dilewati (--no-jira).');
  } else {
    try {
      const outcome = await deps.jira.moveToStatus(ticketKey, config.jiraReviewStatus, {
        currentStatus: issue?.status,
        dryRun: dry,
        via: splitList(config.jiraTransitionPath),
      });
      const fmt = (st: TransitionStep) => `'${st.from}' → '${st.to}' (via '${st.transition.name}')`;
      switch (outcome.kind) {
        case 'already':
          jiraStep = 'already';
          log.ok(`Tiket sudah di status '${outcome.status}', dilewati.`);
          break;
        case 'planned': {
          jiraStep = 'planned';
          const first = outcome.steps[0];
          if (first) log.info(`[dry-run] Akan memindahkan tiket ${fmt(first)}.`);
          if (outcome.next.length) log.dim(`    Lalu lanjut bertahap ke: ${outcome.next.join(' → ')}`);
          break;
        }
        case 'moved':
          jiraStep = 'moved';
          for (const st of outcome.steps) log.ok(`Tiket dipindah ${fmt(st)}.`);
          break;
        case 'unavailable':
          jiraStep = 'unavailable';
          for (const st of outcome.steps) log.ok(`Tiket dipindah ${fmt(st)}.`);
          log.warn(`Berhenti di status '${outcome.status}': tidak ada transisi ke status berikutnya di jalur menuju '${config.jiraReviewStatus}'.`);
          log.warn(
            `Transisi yang ada: ${outcome.available.length ? outcome.available.join(', ') : '(tidak ada)'}. ` +
              'Pindahkan manual di Jira, atau sesuaikan jiraTransitionPath.',
          );
          log.dim('    Catatan: Jira menyembunyikan transisi yang syaratnya belum terpenuhi (mis. assignee kosong).');
          break;
      }
    } catch (err) {
      jiraStep = 'failed';
      log.warn(`Gagal memindahkan tiket: ${errorMessage(err)}`);
      if (err instanceof CliError && err.hint) log.dim(`    Saran: ${err.hint}`);
    }
  }

  // ── 4. Teams ─────────────────────────────────────────────────────────────────
  log.step(`[5/5] Teams → ${TEAMS_CHAT_NAME}`);
  const summary = issue?.summary?.trim() || stripTicketPrefix(prTitle, ticketKey);
  const desc = buildDesc(summary, service);
  const message = buildTeamsMessage({ ticketKey, desc, prUrl, prs, ticketUrl: tUrl, dependsOn });
  const prUrls = prs.map((p) => p.url);
  const notifyKey = prUrls.join(' ');

  let teamsStep: TeamsStep;
  if (!opts.teams || !deps.sendTeams) {
    teamsStep = 'skipped';
    log.info('Dilewati (--no-teams).');
  } else {
    log.plain('Preview pesan:');
    log.plain(boxed(message.text, deps.symbols));
    if (dry) {
      teamsStep = 'planned';
      log.info('[dry-run] Pesan tidak dikirim.');
    } else {
      const sentAt = deps.notified ? await deps.notified.sentAt(notifyKey) : null;
      let proceed = true;
      if (sentAt) {
        // Anti-spam: PR ini sudah pernah diumumkan dari mesin ini.
        log.info(`Pesan untuk PR ini sudah pernah dikirim (${sentAt}).`);
        if (opts.yes || !deps.interactive) {
          proceed = false;
          log.info('Tidak dikirim ulang. Jalankan tanpa -y di terminal untuk mengirim ulang.');
        } else {
          proceed = await deps.confirm(`Kirim ULANG ke grup "${TEAMS_CHAT_NAME}"?`, false);
        }
      } else if (!opts.yes) {
        if (!deps.interactive) {
          proceed = false;
          log.warn('Terminal non-interaktif, konfirmasi tidak bisa ditanyakan. Pakai -y untuk mengirim otomatis.');
        } else {
          proceed = await deps.confirm(`Kirim pesan ini ke grup "${TEAMS_CHAT_NAME}"?`, true);
        }
      }
      if (!proceed) {
        teamsStep = sentAt ? 'already-sent' : deps.interactive ? 'cancelled' : 'skipped';
        if (teamsStep === 'cancelled') log.warn('Pengiriman ke Teams dibatalkan.');
      } else {
        try {
          await deps.sendTeams(buildPayload(message, { ticket: ticketKey, desc, prUrl, prUrls, ticketUrl: tUrl }));
          teamsStep = 'sent';
          log.ok(`Pesan terkirim ke "${TEAMS_CHAT_NAME}".`);
          await deps.notified?.markSent(notifyKey).catch(() => undefined);
        } catch (err) {
          teamsStep = 'failed';
          log.warn(`Gagal mengirim ke Teams: ${errorMessage(err)}`);
          if (err instanceof CliError && err.hint) log.dim(`    Saran: ${err.hint}`);
        }
      }
    }
  }

  // ── Ringkasan ────────────────────────────────────────────────────────────────
  log.step('Selesai');
  if (teamsStep !== 'sent' && teamsStep !== 'planned' && teamsStep !== 'already-sent') {
    log.plain('Pesan Teams untuk dikirim manual:');
    log.plain(boxed(message.text, deps.symbols));
  }
  if (!dry) {
    const copied = await deps.copy(prUrls.join('\n'));
    if (copied) log.ok(`Link PR disalin ke clipboard${prUrls.length > 1 ? ` (${prUrls.length} link)` : ''}.`);
    else log.warn('Link PR tidak bisa disalin ke clipboard; salin manual dari baris di bawah.');
  }
  log.plain('Link PR:');
  for (const u of prUrls) deps.printResult(u);

  return {
    ticketKey,
    branch,
    repo: repoFull,
    bases,
    prUrl,
    prs,
    prCreated,
    committed,
    reviewers: reviewersStep,
    jira: jiraStep,
    teams: teamsStep,
    message,
    dependsOn,
  };
}
