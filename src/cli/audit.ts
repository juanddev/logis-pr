import { splitList, type Config } from '../config/index.js';
import { basesForChoice, isHotfixBranch, parseRemoteUrl } from '../git/index.js';
import {
  analyzeTicket,
  describeProblems,
  integrationBranchName,
  planIntegration,
  validatePrDiff,
  type IsolationContext,
  type PrDiffReport,
  type Problem,
} from '../git/isolation.js';
import { extractTicketKey, normalizeTicketKey } from '../message/index.js';
import { CliError } from '../utils/errors.js';
import type { Logger } from '../utils/term.js';
import type { GitHubLike, GitLike } from './run.js';

export interface AuditOptions {
  ticket?: string;
  base?: string;
  /** false bila --no-baseline: branch integrasi diharapkan berbasis target, tanpa baseline production. */
  baseline?: boolean;
}

export interface AuditResult {
  safe: boolean;
  issues: string[];
}

/**
 * `logis-pr --audit`: memeriksa keadaan repo & PR TANPA mengubah apa pun.
 * Tidak ada fetch, commit-tree, merge-tree, worktree, maupun perubahan ref. Data remote memakai
 * remote-tracking refs yang ada; kebasian dicek lewat `git ls-remote` (baca jaringan saja).
 */
export async function runAudit(
  opts: AuditOptions,
  deps: { config: Config; git: GitLike & Pick<import('../git/index.js').Git, 'lsRemote'>; gh: GitHubLike | null; log: Logger },
): Promise<AuditResult> {
  const { config, git, gh, log } = deps;
  const issues: string[] = [];
  const R = config.remote;
  const prod = config.productionBranch;
  const dev = config.baseBranch;
  const iopts = { from: opts.baseline === false ? 'base' : 'production' } as const;

  log.info('Mode --audit: hanya membaca. Tidak ada fetch, commit, branch, push, maupun PR.');
  log.step('Repo');
  if (!(await git.isRepo())) throw new CliError('Folder ini bukan repository git.');
  const branch = await git.currentBranch();
  log.plain(`Branch aktif      : ${branch ?? '(detached HEAD)'}`);
  const remotes = await git.remotes();
  log.plain(`Remote            : ${remotes.join(', ') || '(tidak ada)'} → dipakai: ${R}`);
  if (!remotes.includes(R)) throw new CliError(`Remote '${R}' tidak ada.`, { hint: 'Set remote di config.' });
  const repo = parseRemoteUrl(await git.remoteUrl(R));
  log.plain(`Repo GitHub       : ${repo ? `${repo.owner}/${repo.repo}` : '(tidak dikenali)'}`);
  const ops = await git.inProgressOperations();
  if (ops.length) issues.push(`Operasi git belum selesai: ${ops.join(', ')}`);
  const wt = await git.status();
  log.plain(
    `Working tree      : ${wt.staged.length} staged, ${wt.unstaged.length} berubah, ${wt.untracked.length} file baru` +
      (ops.length ? ` · SEDANG ${ops.join(', ').toUpperCase()}` : ''),
  );
  if (!branch) {
    issues.push('Detached HEAD');
    return finish();
  }

  const envs = [...new Set([...splitList(config.envBranches), dev])].filter((e) => e !== prod);
  const ticketKey = opts.ticket ? normalizeTicketKey(opts.ticket, config.jiraProjectKey) : extractTicketKey(branch, config.jiraProjectKey);
  if (!ticketKey) {
    issues.push(`Key tiket tidak ditemukan di nama branch '${branch}' (pakai -t).`);
    return finish();
  }
  const integrationFor = (b: string) => integrationBranchName(config.devBranchPattern, ticketKey, branch, b, dev);
  const hotfix = isHotfixBranch(branch, splitList(config.hotfixPrefixes));
  const bases = opts.base?.trim() ? splitList(opts.base) : hotfix ? basesForChoice('both', prod, dev) : [dev];
  log.plain(`Tiket             : ${ticketKey}${hotfix ? ' (hotfix)' : ''}`);
  log.plain(`Production        : ${R}/${prod}`);
  log.plain(`Target PR         : ${bases.map((b) => `${b === prod ? branch : integrationFor(b)} → ${b}`).join(', ')}`);
  if (iopts.from === 'base') log.plain(`Branch integrasi  : dari ujung target (--no-baseline), tanpa baseline ${prod}`);

  log.step('Kesegaran data remote (ls-remote, tanpa fetch)');
  const watch = [...new Set([prod, ...envs, ...bases, branch, ...bases.filter((b) => b !== prod).map(integrationFor)])];
  const live = await git.lsRemote(R, watch);
  for (const b of watch) {
    const local = await git.resolve(`${R}/${b}`);
    const remote = live.get(b) ?? null;
    const state = !remote && !local ? 'tidak ada' : local === remote ? 'terbaru' : !local ? 'belum di-fetch' : !remote ? 'sudah dihapus di remote' : 'BASI';
    log.plain(`  ${`${R}/${b}`.padEnd(40)} ${state}`);
    if ((b === prod || bases.includes(b)) && !local) issues.push(`${R}/${b} tidak ada secara lokal (jalankan git fetch).`);
    if (state === 'BASI') log.dim(`    Hasil audit untuk ${b} memakai data lama. Jalankan git fetch untuk data terbaru.`);
  }
  if (!(await git.resolve(`${R}/${prod}`))) return finish();
  const presentEnvs: string[] = [];
  for (const e of envs) if (await git.resolve(`${R}/${e}`)) presentEnvs.push(e);
  const ctx: IsolationContext = {
    remote: R,
    prod,
    envs: presentEnvs,
    ticketKey,
    ownBranches: [branch, ...bases.filter((b) => b !== prod).map(integrationFor)],
  };

  log.step(`Branch tiket ${branch}`);
  const head = (await git.resolve('HEAD')) as string;
  const ticket = await analyzeTicket(git, ctx, head);
  log.plain(`Commit tiket di luar ${prod}: ${ticket.commits.length}${ticket.syncMerges.length ? ` (+${ticket.syncMerges.length} merge sinkronisasi ${prod})` : ''}`);
  for (const c of ticket.commits.slice(0, 20)) log.dim(`    ${c.short} ${c.subject}`);
  for (const w of ticket.warnings) log.warn(w);
  report('Branch tiket', ticket.problems);
  if (wt.staged.length + wt.unstaged.length) log.dim('    Catatan: perubahan yang belum di-commit tidak ikut diaudit.');

  for (const b of bases) {
    if (!(await git.resolve(`${R}/${b}`))) continue;
    let pr: PrDiffReport;
    let headName = branch;
    let headSha = head;
    if (b === prod) {
      log.step(`PR ${branch} → ${b}`);
      pr = await validatePrDiff(git, ctx, ticket, b, head);
    } else {
      headName = integrationFor(b);
      log.step(`Branch integrasi ${headName} → ${b}`);
      const ip = await planIntegration(git, ctx, ticket, b, headName, iopts);
      log.plain(
        `Status            : ${ip.existed ? `ada (lokal ${ip.local?.slice(0, 7) ?? '-'}, remote ${ip.remote?.slice(0, 7) ?? '-'})` : 'belum dibuat'}`,
      );
      log.plain(`Commit tiket      : ${ip.present.length} sudah ada, ${ip.toPick.length} belum, ${ip.inBase.length} sudah di ${b}`);
      if (ip.existed || ip.problems.length) report(`Branch integrasi ${headName}`, ip.problems);
      if (!ip.existed) {
        if (ticket.problems.length) {
          log.dim(`    Belum ada branch integrasi & branch tiket bermasalah: perkiraan isi PR dilewati.`);
          continue;
        }
        if (iopts.from === 'base') {
          log.dim(`    Belum ada branch integrasi; dengan --no-baseline isinya = ${b} + cherry-pick ${ip.toPick.length} commit tiket.`);
          continue;
        }
        log.dim(`    Belum ada branch integrasi; perbandingan PR di bawah memakai branch tiket sebagai perkiraan.`);
      } else {
        headSha = (ip.local && ip.remote && ip.local !== ip.remote ? ip.local : (ip.local ?? ip.remote)) as string;
      }
      pr = await validatePrDiff(git, ctx, ticket, b, headSha, iopts);
    }
    log.plain(`Commit di PR      : ${pr.ticket.length} tiket, ${pr.baseline.length} baseline ${prod}, ${pr.sync.length} merge sinkronisasi`);
    log.plain(`File berubah      : ${pr.files.length}`);
    for (const f of pr.files.slice(0, 20)) log.dim(`    ${f.status} ${f.path}`);
    if (pr.files.length > 20) log.dim(`    … dan ${pr.files.length - 20} file lain`);
    report(`Isi PR ${headName} → ${b}`, pr.problems);

    if (gh && repo) {
      const existing = await gh.findOpenPr(`${repo.owner}/${repo.repo}`, headName, b);
      if (!existing) {
        log.plain('PR di GitHub      : belum ada');
      } else {
        const d = await gh.prDetails(`${repo.owner}/${repo.repo}`, existing.number);
        log.plain(`PR di GitHub      : #${d.number} ${d.commits.length} commit, ${d.changedFiles} file`);
        const expected = new Set([...pr.ticket, ...pr.baseline, ...pr.sync].map((m) => m.sha));
        const extra = d.commits.filter((c) => !expected.has(c));
        if (extra.length) issues.push(`PR #${d.number}: ${extra.length} commit di GitHub tidak dikenali (${extra.slice(0, 5).map((c) => c.slice(0, 7)).join(', ')})`);
        if (d.headRefOid !== headSha) log.warn(`PR #${d.number}: ujung head di GitHub ${d.headRefOid.slice(0, 7)} ≠ lokal ${headSha.slice(0, 7)} (belum di-push / data basi).`);
      }
      if (b !== prod) {
        const stale = await gh.findOpenPr(`${repo.owner}/${repo.repo}`, branch, b);
        if (stale) issues.push(`PR lama #${stale.number} langsung dari branch tiket ke ${b}; seharusnya dari ${headName}.`);
      }
    }
  }
  return finish();

  function report(title: string, problems: readonly Problem[]): void {
    if (!problems.length) {
      log.ok(`${title}: bersih`);
      return;
    }
    log.fail(`${title}: ${problems.length} masalah`);
    for (const l of describeProblems(problems)) log.fail(`  ${l}`);
    issues.push(`${title}: ${problems.length} masalah`);
  }

  function finish(): AuditResult {
    log.step('Penilaian');
    if (issues.length === 0) {
      log.ok(`AMAN: branch tiket & isi PR hanya berisi commit tiket${iopts.from === 'base' ? '' : ' (plus baseline production)'}.`);
    } else {
      log.fail(`TIDAK AMAN (${issues.length}):`);
      for (const i of issues) log.fail(`  ${i}`);
    }
    return { safe: issues.length === 0, issues };
  }
}
