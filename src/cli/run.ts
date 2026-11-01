import { missingFields, ENV_VARS, parseReviewers, splitList, type Config } from '../config/index.js';
import { isEmbeddedRepo, looksSensitive, parseRemoteUrl, planCommit, type Git } from '../git/index.js';
import { prNumberFromUrl, type GitHub, type PullRequest } from '../github/index.js';
import type { JiraClient, JiraIssue, TransitionStep } from '../jira/index.js';
import {
  buildDesc,
  buildPrBody,
  buildTeamsMessage,
  ensureCommitPrefix,
  extractTicketKey,
  normalizeTicketKey,
  serviceFromRepo,
  stripTicketPrefix,
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
>;
export type GitHubLike = Pick<GitHub, 'version' | 'authStatus' | 'findOpenPr' | 'createPr' | 'ensureReviewers'>;
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

export type ReviewersStep = 'requested' | 'already' | 'planned' | 'failed' | 'skipped';

export type JiraStep = 'moved' | 'already' | 'planned' | 'unavailable' | 'failed' | 'skipped';
export type TeamsStep = 'sent' | 'already-sent' | 'planned' | 'cancelled' | 'failed' | 'skipped';

export interface RunResult {
  ticketKey: string;
  branch: string;
  repo: string;
  prUrl: string;
  prCreated: boolean;
  committed: boolean;
  reviewers: ReviewersStep;
  jira: JiraStep;
  teams: TeamsStep;
  message: TeamsMessage;
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
  if (dry) {
    log.info('Mode --dry-run: tidak ada commit, push, PR, transisi Jira, maupun pesan Teams.');
    log.dim('  Hanya pembacaan (git status, gh pr list, GET Jira) agar rencana akurat.');
  }

  // ── Validasi awal ────────────────────────────────────────────────────────────
  log.step('Validasi');
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

  const branch = await git.currentBranch();
  if (!branch) {
    throw new CliError('HEAD sedang detached (tidak di branch mana pun).', {
      hint: 'Checkout branch fitur dulu: git switch feature/LOGIS-1234-deskripsi',
    });
  }

  const base = opts.base?.trim() || config.baseBranch;
  if (branch === base) {
    throw new CliError(`Anda sedang berada di base branch '${base}'.`, {
      hint: 'Buat branch fitur: git switch -c feature/LOGIS-1234-deskripsi',
    });
  }

  const remoteUrl = await git.remoteUrl('origin');
  const remote = parseRemoteUrl(remoteUrl);
  if (!remote) {
    throw new CliError(`Remote origin bukan URL GitHub yang dikenali: ${remoteUrl}`);
  }
  const repoFull = `${remote.owner}/${remote.repo}`;
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
  log.ok(`Repo ${repoFull} · branch ${branch} → ${base} · tiket ${ticketKey}`);

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

  // ── 1. Commit & push ─────────────────────────────────────────────────────────
  log.step('[1/4] Commit & push');
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
  if (!wantCommit) {
    if (newFiles.length > 0) log.info(`${newFiles.length} file baru tidak ikut (tanpa -m tidak ada commit).`);
    log.ok(hasTrackedChanges ? 'Tidak ada yang di-commit.' : 'Tidak ada perubahan file terlacak, tidak ada yang di-commit.');
  } else if (plan.files.length === 0) {
    log.warn('Tidak ada file yang di-commit — pesan -m diabaikan.');
  } else {
    commitMessage = ensureCommitPrefix(opts.message ?? '', ticketKey);
    if (plan.mode === 'staged') log.info('Ada file yang sudah di-stage → hanya file tersebut yang di-commit.');
    if (dry) {
      log.info(`[dry-run] Akan commit ${plan.files.length} file: "${firstLine(commitMessage)}"`);
      listFiles(plan.files);
    } else {
      if (plan.stageTracked) await git.stageTracked();
      if (plan.addUntracked.length) await git.stagePaths(plan.addUntracked);
      await git.commitStaged(commitMessage);
      committed = true;
      log.ok(`Commit ${plan.files.length} file: ${firstLine(commitMessage)}`);
    }
    const left = plan.left.filter((p) => !isEmbeddedRepo(p));
    if (left.length && !dry) {
      log.dim(`    ${left.length} file tidak ikut commit (tetap ada di folder Anda).`);
    } else if (left.length && dry && plan.mode === 'staged') {
      log.dim(`    ${left.length} file lain tidak ikut karena hanya file yang di-stage yang di-commit.`);
    }
  }

  if (dry) {
    log.info(`[dry-run] Akan menjalankan: git push --set-upstream origin ${branch}`);
  } else {
    await git.push(branch);
    log.ok(`Push ke origin/${branch}`);
  }

  // ── 2. Pull Request ──────────────────────────────────────────────────────────
  log.step('[2/4] Pull Request');
  const existing: PullRequest | null = await gh.findOpenPr(repoFull, branch);
  let prUrl: string;
  let prTitle: string;
  let prCreated = false;
  if (existing) {
    prUrl = existing.url;
    prTitle = existing.title;
    log.ok(`PR sudah ada, dipakai ulang: #${existing.number} ${existing.title}`);
    if (existing.baseRefName !== base) log.warn(`PR tersebut menuju '${existing.baseRefName}', bukan '${base}'.`);
    if (opts.draft && !existing.isDraft) log.warn('PR sudah ada dan bukan draft; --draft diabaikan.');
  } else {
    const subject = commitMessage ? firstLine(commitMessage) : await git.lastCommitSubject();
    if (!subject) throw new CliError('Branch ini belum punya commit.', { hint: 'Buat commit dulu atau pakai -m.' });
    prTitle = ensureCommitPrefix(subject, ticketKey);
    const body = buildPrBody({ ticketKey, ticketUrl: tUrl, summary: issue?.summary });
    if (dry) {
      prUrl = `https://github.com/${repoFull}/pull/<baru>`;
      log.info(`[dry-run] Akan membuat PR${opts.draft ? ' (draft)' : ''} ${branch} → ${base}`);
      log.dim(`    Judul: ${prTitle}`);
    } else {
      prUrl = await gh.createPr({ repo: repoFull, base, head: branch, title: prTitle, body, draft: opts.draft });
      prCreated = true;
      log.ok(`PR dibuat: ${prUrl}`);
    }
  }

  // Reviewer (non-kritis): gagal → warning, proses lanjut.
  const reviewers = opts.reviewers !== undefined ? parseReviewers(opts.reviewers) : parseReviewers(config.prReviewers);
  let reviewersStep: ReviewersStep = 'skipped';
  if (reviewers.length > 0) {
    const prNumber = existing?.number ?? prNumberFromUrl(prUrl);
    if (dry) {
      reviewersStep = 'planned';
      log.info(`[dry-run] Akan meminta review dari: ${reviewers.join(', ')}`);
    } else if (!prNumber) {
      reviewersStep = 'failed';
      log.warn(`Nomor PR tidak terbaca dari ${prUrl}; reviewer tidak di-assign.`);
    } else {
      try {
        const r = await gh.ensureReviewers(repoFull, prNumber, reviewers);
        if (r.requested.length) log.ok(`Review diminta dari: ${r.requested.join(', ')}`);
        if (r.alreadyRequested.length) log.ok(`Reviewer sudah terpasang: ${r.alreadyRequested.join(', ')}`);
        if (r.alreadyReviewed.length) log.ok(`Sudah memberi review (tidak diminta ulang): ${r.alreadyReviewed.join(', ')}`);
        if (r.skippedAuthor.length) log.info(`Dilewati karena penulis PR sendiri: ${r.skippedAuthor.join(', ')}`);
        reviewersStep = r.requested.length ? 'requested' : 'already';
      } catch (err) {
        reviewersStep = 'failed';
        log.warn(`Gagal meminta review: ${errorMessage(err)}`);
        if (err instanceof CliError && err.hint) log.dim(`    Saran: ${err.hint}`);
      }
    }
  }

  // ── 3. Jira → Code Review ────────────────────────────────────────────────────
  log.step(`[3/4] Jira → ${config.jiraReviewStatus}`);
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
  log.step(`[4/4] Teams → ${TEAMS_CHAT_NAME}`);
  const summary = issue?.summary?.trim() || stripTicketPrefix(prTitle, ticketKey);
  const desc = buildDesc(summary, service);
  const message = buildTeamsMessage({ ticketKey, desc, prUrl, ticketUrl: tUrl });

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
      const sentAt = deps.notified ? await deps.notified.sentAt(prUrl) : null;
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
          await deps.sendTeams(buildPayload(message, { ticket: ticketKey, desc, prUrl, ticketUrl: tUrl }));
          teamsStep = 'sent';
          log.ok(`Pesan terkirim ke "${TEAMS_CHAT_NAME}".`);
          await deps.notified?.markSent(prUrl).catch(() => undefined);
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
    const copied = await deps.copy(prUrl);
    if (copied) log.ok('Link PR disalin ke clipboard.');
    else log.warn('Link PR tidak bisa disalin ke clipboard; salin manual dari baris di bawah.');
  }
  log.plain('Link PR:');
  deps.printResult(prUrl);

  return {
    ticketKey,
    branch,
    repo: repoFull,
    prUrl,
    prCreated,
    committed,
    reviewers: reviewersStep,
    jira: jiraStep,
    teams: teamsStep,
    message,
  };
}
