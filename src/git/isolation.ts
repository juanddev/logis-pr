/**
 * Isolasi branch & keamanan PR (lihat docs/adr/0001-production-based-ticket-branching.md).
 *
 * Model:
 *   production ── <branch tiket>            commit tiket (allowlist = commit non-merge di luar production)
 *   production ── <TIKET>-dev               cherry-pick -x commit tiket → head PR ke development
 *
 * Semua fungsi di sini READ-ONLY terhadap repo developer (hanya membaca ref/commit). Mutasi
 * (membuat/memajukan branch, push) dilakukan orkestrator SETELAH validasi di sini lolos.
 */
import type { CommitMeta, Git, ReplayStep } from './index.js';

export type GitReader = Pick<
  Git,
  | 'revList'
  | 'commitMeta'
  | 'isAncestor'
  | 'patchIds'
  | 'patchIdsOf'
  | 'remoteBranchesContaining'
  | 'filesOfCommit'
  | 'prDiffFiles'
  | 'resolve'
>;

export interface IsolationContext {
  remote: string;
  /** Branch produksi (baseline semua branch kerja). */
  prod: string;
  /** Branch environment lain yang ADA di remote (mis. staging, development). Commit eksklusifnya terlarang di branch tiket. */
  envs: string[];
  ticketKey: string;
  /** Nama branch remote (tanpa prefix remote) yang boleh memuat commit tiket: branch tiket & branch integrasinya. */
  ownBranches: string[];
}

export type Problem =
  | { kind: 'merge'; commit: CommitMeta; source: string }
  | { kind: 'env-commit'; commit: CommitMeta; env: string }
  | { kind: 'env-patch'; commit: CommitMeta; env: string; envCommit: string }
  | { kind: 'foreign-branch'; commit: CommitMeta; branches: string[] }
  | { kind: 'integration-foreign'; commit: CommitMeta; branch: string }
  | { kind: 'integration-diverged'; branch: string; local: string; remote: string }
  | { kind: 'pr-unexpected-commit'; commit: CommitMeta; base: string }
  | { kind: 'pr-unexpected-file'; file: string; status: string; base: string }
  | { kind: 'dependent-no-ticket'; commit: CommitMeta; ticketKey: string }
  | { kind: 'dependent-merge'; commit: CommitMeta; base: string };

export interface TicketAnalysis {
  head: string;
  /** Titik awal branch tiket di production (parent pertama commit tiket tertua). */
  forkPoint: string;
  /** Semua commit tiket (termasuk merge sinkronisasi) dalam urutan topologis lama → baru. */
  order: CommitMeta[];
  /** Commit tiket (non-merge, di luar production), urut lama → baru. Ini allowlist cherry-pick. */
  commits: CommitMeta[];
  /** Merge yang hanya membawa isi production (sinkronisasi baseline) — diizinkan, tidak di-cherry-pick. */
  syncMerges: CommitMeta[];
  problems: Problem[];
  warnings: string[];
}

const CHERRY_RE = /\(cherry picked from commit ([0-9a-f]{7,40})\)/g;

/** SHA sumber yang dicatat `git cherry-pick -x` di pesan commit. */
export function cherryPickSources(body: string): string[] {
  return [...body.matchAll(CHERRY_RE)].map((m) => m[1] ?? '').filter(Boolean);
}

function refOf(ctx: IsolationContext, branch: string): string {
  return `${ctx.remote}/${branch}`;
}

function invert(map: Map<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [sha, pid] of map) out.set(pid, [...(out.get(pid) ?? []), sha]);
  return out;
}

/**
 * Analisis branch tiket di `head` (boleh commit bayangan): commit mana yang milik tiket, dan apakah
 * ada commit asing — merge yang membawa history non-production, commit milik branch environment lain
 * (per SHA maupun per patch-id), atau commit yang juga ada di branch remote tiket lain.
 */
export async function analyzeTicket(git: GitReader, ctx: IsolationContext, head: string): Promise<TicketAnalysis> {
  const prodRef = refOf(ctx, ctx.prod);
  const shas = await git.revList(head, [prodRef]);
  const metas = await git.commitMeta(shas);
  const problems: Problem[] = [];
  const warnings: string[] = [];
  const flagged = new Set<string>();
  const syncMerges: CommitMeta[] = [];

  // 1. Commit milik branch environment lain (SHA sama).
  for (const env of ctx.envs) {
    const envOnly = new Set(await git.revList(refOf(ctx, env), [prodRef]));
    for (const m of metas) {
      if (!flagged.has(m.sha) && envOnly.has(m.sha)) {
        problems.push({ kind: 'env-commit', commit: m, env });
        flagged.add(m.sha);
      }
    }
  }

  // 2. Merge commit: hanya boleh bila semua parent tambahan sudah ada di production.
  for (const m of metas) {
    if (m.parents.length < 2 || flagged.has(m.sha)) continue;
    let bad: string | null = null;
    for (const p of m.parents.slice(1)) {
      if (await git.isAncestor(p, prodRef)) continue;
      bad = 'branch lain';
      for (const env of ctx.envs) if (await git.isAncestor(p, refOf(ctx, env))) bad = env;
      break;
    }
    if (bad) {
      problems.push({ kind: 'merge', commit: m, source: bad });
      flagged.add(m.sha);
    } else {
      syncMerges.push(m);
    }
  }

  const candidates = metas.filter((m) => m.parents.length < 2 && !flagged.has(m.sha));

  // 3. Salinan (cherry-pick) commit environment lain: patch-id sama, SHA beda.
  if (candidates.length) {
    const own = await git.patchIdsOf(candidates.map((c) => c.sha));
    const ownShas = new Set(candidates.map((c) => c.sha));
    for (const env of ctx.envs) {
      const envPids = invert(await git.patchIds(refOf(ctx, env), [prodRef]));
      const hits: Array<{ c: CommitMeta; envSha: string }> = [];
      for (const c of candidates) {
        const pid = own.get(c.sha);
        const envShas = pid ? (envPids.get(pid) ?? []) : [];
        if (!flagged.has(c.sha) && envShas.length) hits.push({ c, envSha: envShas[0] as string });
      }
      if (!hits.length) continue;
      const envMeta = new Map((await git.commitMeta(hits.map((h) => h.envSha))).map((m) => [m.sha, m]));
      for (const h of hits) {
        // Dikecualikan: commit di environment yang merupakan cherry-pick -x DARI commit tiket ini
        // (mis. branch <TIKET>-dev yang sudah di-merge ke development).
        const sources = cherryPickSources(envMeta.get(h.envSha)?.body ?? '');
        if (sources.some((s) => [...ownShas].some((o) => o.startsWith(s)))) continue;
        problems.push({ kind: 'env-patch', commit: h.c, env, envCommit: h.envSha });
        flagged.add(h.c.sha);
      }
    }
  }

  // 4. Commit yang juga dimuat branch remote lain (tiket lain) — kepemilikan tidak bisa dipastikan.
  const allowed = new Set([
    `${ctx.remote}/HEAD`,
    prodRef,
    ...ctx.envs.map((e) => refOf(ctx, e)),
    ...ctx.ownBranches.map((b) => refOf(ctx, b)),
  ]);
  for (const c of candidates) {
    if (flagged.has(c.sha)) continue;
    const others = (await git.remoteBranchesContaining(c.sha, ctx.remote)).filter((b) => !allowed.has(b));
    if (others.length) {
      problems.push({ kind: 'foreign-branch', commit: c, branches: others });
      flagged.add(c.sha);
    }
  }

  // Sinyal lemah (bukan bukti): pesan commit menyebut tiket lain.
  const keyRe = new RegExp(`\\b${ctx.ticketKey.split('-')[0]}-\\d+\\b`, 'gi');
  for (const c of candidates) {
    if (flagged.has(c.sha)) continue;
    const keys = [...new Set((c.subject.match(keyRe) ?? []).map((k) => k.toUpperCase()))].filter((k) => k !== ctx.ticketKey);
    if (keys.length) warnings.push(`${c.short} "${c.subject}" menyebut ${keys.join(', ')} (bukan ${ctx.ticketKey}) — pastikan memang milik tiket ini.`);
  }

  const forkPoint = metas[0]?.parents[0] ?? head;
  return {
    head,
    forkPoint,
    order: metas.filter((m) => !flagged.has(m.sha)),
    commits: candidates.filter((c) => !flagged.has(c.sha)),
    syncMerges,
    problems,
    warnings,
  };
}

export interface IntegrationPlan {
  name: string;
  base: string;
  /** Commit awal untuk cherry-pick: ujung branch integrasi yang ada, atau ujung production. */
  start: string;
  local: string | null;
  remote: string | null;
  existed: boolean;
  /** Commit tiket yang perlu di-cherry-pick (belum ada di branch integrasi maupun di base). */
  toPick: CommitMeta[];
  /** Langkah replay (cherry-pick & merge sinkronisasi production) untuk worktree sementara. */
  steps: ReplayStep[];
  /** Commit tiket yang sudah ada di branch integrasi. */
  present: CommitMeta[];
  /** Commit tiket yang sudah ada di base (mis. PR -dev sebelumnya sudah di-merge). */
  inBase: CommitMeta[];
  problems: Problem[];
}

/**
 * Klasifikasi commit di branch integrasi (di luar production & base). Yang boleh hanya:
 *  - cherry-pick commit tiket (dikenali dari trailer `-x` atau patch-id), dan
 *  - merge yang hanya membawa isi base/production (penyelesaian konflik eksplisit oleh developer).
 */
async function classifyIntegration(
  git: GitReader,
  ctx: IsolationContext,
  tip: string,
  base: string,
  branch: string,
  ticket: TicketAnalysis,
): Promise<{ represented: Set<string>; problems: Problem[] }> {
  const prodRef = refOf(ctx, ctx.prod);
  const baseRef = refOf(ctx, base);
  const metas = await git.commitMeta(await git.revList(tip, [prodRef, baseRef]));
  const ticketShas = ticket.commits.map((c) => c.sha);
  const ticketPids = invert(await git.patchIdsOf(ticketShas));
  const nonMerge = metas.filter((m) => m.parents.length < 2);
  const pids = await git.patchIdsOf(nonMerge.map((m) => m.sha));
  const represented = new Set<string>();
  const problems: Problem[] = [];
  for (const m of metas) {
    if (m.parents.length >= 2) {
      let ok = true;
      for (const p of m.parents.slice(1)) {
        if (!(await git.isAncestor(p, baseRef)) && !(await git.isAncestor(p, prodRef))) ok = false;
      }
      if (!ok) problems.push({ kind: 'integration-foreign', commit: m, branch });
      continue;
    }
    const bySource = cherryPickSources(m.body)
      .map((s) => ticketShas.find((t) => t.startsWith(s)))
      .filter((x): x is string => Boolean(x));
    const pid = pids.get(m.sha);
    const byPatch = pid ? (ticketPids.get(pid) ?? []) : [];
    const sources = [...bySource, ...byPatch];
    if (sources.length === 0) {
      problems.push({ kind: 'integration-foreign', commit: m, branch });
      continue;
    }
    for (const s of sources) represented.add(s);
  }
  return { represented, problems };
}

/** Rencanakan isi branch integrasi `name` (dari production) untuk PR ke `base`. Tidak mengubah apa pun. */
export async function planIntegration(
  git: GitReader,
  ctx: IsolationContext,
  ticket: TicketAnalysis,
  base: string,
  name: string,
): Promise<IntegrationPlan> {
  const prodRef = refOf(ctx, ctx.prod);
  const baseRef = refOf(ctx, base);
  const problems: Problem[] = [];

  // Commit tiket yang sudah ada di base (SHA atau patch-id).
  const basePids = new Set((await git.patchIds(baseRef, [prodRef])).values());
  const ownPids = await git.patchIdsOf(ticket.commits.map((c) => c.sha));
  const inBase: CommitMeta[] = [];
  for (const c of ticket.commits) {
    const pid = ownPids.get(c.sha);
    if ((await git.isAncestor(c.sha, baseRef)) || (pid && basePids.has(pid))) inBase.push(c);
  }

  const local = await git.resolve(`refs/heads/${name}`);
  const remote = await git.resolve(refOf(ctx, name));
  let tip: string | null = null;
  if (local && remote) {
    if (local === remote || (await git.isAncestor(remote, local))) tip = local;
    else if (await git.isAncestor(local, remote)) tip = remote;
    else problems.push({ kind: 'integration-diverged', branch: name, local, remote });
  } else {
    tip = local ?? remote;
  }

  let represented = new Set<string>();
  if (tip) {
    const cls = await classifyIntegration(git, ctx, tip, base, name, ticket);
    represented = cls.represented;
    problems.push(...cls.problems);
  }

  // Branch tiket yang pernah disinkronkan dengan production diputar ulang utuh (resolusi konfliknya ikut),
  // jadi commit yang sudah ada di base tidak dilewati agar isi tiap langkah identik dengan branch tiket.
  const faithful = !tip && ticket.syncMerges.length > 0;
  const inBaseSet = new Set(faithful ? [] : inBase.map((c) => c.sha));
  const present = ticket.commits.filter((c) => represented.has(c.sha));
  const toPick = ticket.commits.filter((c) => !represented.has(c.sha) && !inBaseSet.has(c.sha));
  const pickSet = new Set(toPick.map((c) => c.sha));
  const syncSet = new Set(ticket.syncMerges.map((m) => m.sha));
  const steps: ReplayStep[] = [];
  for (const m of ticket.order) {
    if (pickSet.has(m.sha)) {
      steps.push({ kind: 'pick', sha: m.sha });
    } else if (syncSet.has(m.sha)) {
      const extra = m.parents.slice(1);
      let needed = true;
      if (tip) {
        needed = false;
        for (const p of extra) if (!(await git.isAncestor(p, tip))) needed = true;
      }
      if (needed) {
        steps.push({ kind: 'merge', sha: m.sha, subject: m.subject, parents: extra, copyTree: !tip });
      }
    }
  }
  if (!steps.some((s) => s.kind === 'pick')) steps.length = 0;
  // Branch integrasi baru dimulai dari titik awal branch tiket di production (bukan ujung production
  // terbaru), sehingga cherry-pick diterapkan di atas isi yang sama seperti saat commit dibuat.
  const start = tip ?? ticket.forkPoint;
  return { name, base, start, local, remote, existed: Boolean(tip), toPick, steps, present, inBase, problems };
}

/** Validasi ulang ujung branch integrasi hasil cherry-pick (post-condition sebelum ref diperbarui). */
export async function validateIntegrationTip(
  git: GitReader,
  ctx: IsolationContext,
  ticket: TicketAnalysis,
  base: string,
  name: string,
  tip: string,
): Promise<Problem[]> {
  return (await classifyIntegration(git, ctx, tip, base, name, ticket)).problems;
}

export interface PrDiffReport {
  base: string;
  head: string;
  ticket: CommitMeta[];
  baseline: CommitMeta[];
  sync: CommitMeta[];
  files: Array<{ status: string; path: string }>;
  problems: Problem[];
}

/**
 * Validasi isi PR seperti yang akan dihitung GitHub: commit `base..head` dan file `base...head`.
 * Setiap commit harus: commit tiket (atau cherry-pick-nya), baseline production yang belum ada di base,
 * atau merge sinkronisasi. Setiap file harus berasal dari commit-commit tersebut.
 */
export async function validatePrDiff(
  git: GitReader,
  ctx: IsolationContext,
  ticket: TicketAnalysis,
  base: string,
  head: string,
): Promise<PrDiffReport> {
  const prodRef = refOf(ctx, ctx.prod);
  const baseRef = refOf(ctx, base);
  const metas = await git.commitMeta(await git.revList(head, [baseRef]));
  const ticketShas = ticket.commits.map((c) => c.sha);
  const ticketSet = new Set(ticketShas);
  const ticketPids = new Set((await git.patchIdsOf(ticketShas)).values());
  const nonMerge = metas.filter((m) => m.parents.length < 2 && !ticketSet.has(m.sha));
  const pids = await git.patchIdsOf(nonMerge.map((m) => m.sha));

  const report: PrDiffReport = { base, head, ticket: [], baseline: [], sync: [], files: [], problems: [] };
  const syncShas = new Set(ticket.syncMerges.map((m) => m.sha));
  for (const m of metas) {
    if (m.parents.length >= 2) {
      let ok = true;
      for (const p of m.parents.slice(1)) {
        if (!(await git.isAncestor(p, baseRef)) && !(await git.isAncestor(p, prodRef))) ok = false;
      }
      if (ok || syncShas.has(m.sha)) report.sync.push(m);
      else report.problems.push({ kind: 'pr-unexpected-commit', commit: m, base });
      continue;
    }
    if (ticketSet.has(m.sha)) {
      report.ticket.push(m);
      continue;
    }
    const fromTicket = cherryPickSources(m.body).some((s) => ticketShas.some((t) => t.startsWith(s)));
    const pid = pids.get(m.sha);
    if (fromTicket || (pid && ticketPids.has(pid))) {
      report.ticket.push(m);
    } else if (await git.isAncestor(m.sha, prodRef)) {
      report.baseline.push(m);
    } else {
      report.problems.push({ kind: 'pr-unexpected-commit', commit: m, base });
    }
  }

  report.files = await git.prDiffFiles(baseRef, head);
  if (report.problems.length === 0) {
    const expected = new Set<string>();
    for (const m of [...report.ticket, ...report.baseline, ...report.sync]) {
      for (const f of await git.filesOfCommit(m.sha)) expected.add(f);
    }
    for (const f of report.files) {
      if (!expected.has(f.path)) report.problems.push({ kind: 'pr-unexpected-file', file: f.path, status: f.status, base });
    }
  }
  return report;
}

/** Baris teks untuk menampilkan masalah ke developer (dikelompokkan). */
export function describeProblems(problems: readonly Problem[], max = 8): string[] {
  const out: string[] = [];
  const groups = new Map<string, string[]>();
  const add = (title: string, line: string) => groups.set(title, [...(groups.get(title) ?? []), line]);
  for (const p of problems) {
    switch (p.kind) {
      case 'env-commit':
        add(`Commit milik '${p.env}' (belum ada di production):`, `${p.commit.short} ${p.commit.subject}`);
        break;
      case 'env-patch':
        add(`Salinan (cherry-pick) commit '${p.env}':`, `${p.commit.short} ${p.commit.subject}  (sama dengan ${p.envCommit.slice(0, 7)})`);
        break;
      case 'merge':
        add('Merge commit yang membawa history non-production:', `${p.commit.short} ${p.commit.subject}  (dari ${p.source})`);
        break;
      case 'foreign-branch':
        add('Commit yang juga ada di branch tiket lain:', `${p.commit.short} ${p.commit.subject}  (${p.branches.slice(0, 3).join(', ')})`);
        break;
      case 'integration-foreign':
        add(`Commit di '${p.branch}' yang bukan cherry-pick commit tiket:`, `${p.commit.short} ${p.commit.subject}`);
        break;
      case 'integration-diverged':
        add('Branch integrasi lokal & remote bercabang:', `${p.branch}: lokal ${p.local.slice(0, 7)} vs remote ${p.remote.slice(0, 7)}`);
        break;
      case 'pr-unexpected-commit':
        add(`Commit asing di PR ke '${p.base}':`, `${p.commit.short} ${p.commit.subject}`);
        break;
      case 'pr-unexpected-file':
        add(`File asing di PR ke '${p.base}':`, `${p.status} ${p.file}`);
        break;
      case 'dependent-no-ticket':
        add(`Commit tanpa key ${p.ticketKey} di pesannya:`, `${p.commit.short} ${p.commit.subject}`);
        break;
      case 'dependent-merge':
        add(`Merge commit yang membawa history selain '${p.base}':`, `${p.commit.short} ${p.commit.subject}`);
        break;
    }
  }
  for (const [title, lines] of groups) {
    out.push(`${title} (${lines.length})`);
    out.push(...lines.slice(0, max).map((l) => `  ${l}`));
    if (lines.length > max) out.push(`  … dan ${lines.length - max} lainnya`);
  }
  return out;
}

/** Nama branch integrasi untuk base tertentu. Default `{TICKET}-dev` untuk development, `{TICKET}-{BASE}` lainnya. */
export function integrationBranchName(pattern: string, ticketKey: string, branch: string, base: string, devBranch: string): string {
  const p = base === devBranch ? pattern : '{TICKET}-{BASE}';
  return p.replaceAll('{TICKET}', ticketKey).replaceAll('{BRANCH}', branch).replaceAll('{BASE}', base);
}
