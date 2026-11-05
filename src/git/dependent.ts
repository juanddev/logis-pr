/**
 * Mode `--dependent` (lihat docs/adr/0002-dependent-ticket-mode.md): tiket yang bergantung pada tiket lain
 * yang baru ada di development. Branch tiket berbasis development, PR langsung branch tiket → development.
 *
 * Semua fungsi di sini READ-ONLY terhadap repo developer. Isolasi berbasis production (isolation.ts)
 * tidak dipakai di mode ini; penggantinya adalah cek isi `origin/<base>..HEAD` di bawah.
 */
import { splitList } from '../config/index.js';
import { extractTicketKeys, messageHasTicket, normalizeTicketKey, sortTicketKeys } from '../message/index.js';
import { CliError } from '../utils/errors.js';
import type { CommitMeta, Git } from './index.js';
import type { IsolationContext, Problem, TicketAnalysis } from './isolation.js';

export type DependentGit = Pick<Git, 'revList' | 'commitMeta' | 'isAncestor'>;
export type DependencyGit = Pick<Git, 'filesOfCommit' | 'commitsTouching' | 'mergeCommits' | 'mergeSideFiles'>;

export interface DependentRejection {
  message: string;
  hint: string;
}

/** Kombinasi yang tidak masuk akal untuk --dependent. Dipakai bersama oleh alur utama dan --audit. */
export function dependentRejections(input: {
  branch: string;
  hotfix: boolean;
  /** Target dari -b; kosong bila -b tidak diberikan. */
  requestedBases: readonly string[];
  dev: string;
  prod: string;
  pushTicket: boolean;
}): DependentRejection[] {
  const out: DependentRejection[] = [];
  if (input.hotfix) {
    out.push({
      message: `Branch hotfix '${input.branch}' tidak bisa memakai --dependent.`,
      hint: `Hotfix menuju ${input.prod} harus berbasis ${input.prod}. Jalankan logis-pr tanpa --dependent.`,
    });
  }
  if (input.requestedBases.includes(input.prod)) {
    out.push({
      message: `--dependent tidak bisa dipakai untuk PR ke '${input.prod}'.`,
      hint: `Branch ini memuat kode ${input.dev} yang belum rilis. PR ke ${input.prod} baru bisa setelah dependensinya rilis.`,
    });
  }
  const others = input.requestedBases.filter((b) => b !== input.prod && b !== input.dev);
  if (others.length) {
    out.push({
      message: `--dependent hanya untuk PR ke '${input.dev}', bukan ke ${others.map((b) => `'${b}'`).join(', ')}.`,
      hint: `Hapus opsi -b, atau gunakan -b ${input.dev}.`,
    });
  }
  if (input.pushTicket) {
    out.push({
      message: '--push-ticket tidak relevan dengan --dependent.',
      hint: 'Di mode ini PR berasal dari branch tiket, jadi branch tiket selalu di-push. Hapus opsi --push-ticket.',
    });
  }
  return out;
}

/**
 * Nilai --depends-on → key tiket yang unik & terurut. `none` atau `-` = tanpa dependensi (penanda eksplisit,
 * sama seperti -r none). String kosong ditolak agar variabel shell kosong tidak diam-diam menghapus dependensi.
 */
export function parseDependsOnOption(value: string, projectKey: string, ticketKey: string): string[] {
  if (/^\s*(none|-)\s*$/i.test(value)) return [];
  const raw = splitList(value);
  if (raw.length === 0) {
    throw new CliError('Nilai --depends-on kosong.', {
      hint: `Beri key tiket (mis. --depends-on ${projectKey}-1234,${projectKey}-5678), atau --depends-on none bila tidak ada dependensi.`,
    });
  }
  const keys = sortTicketKeys([...new Set(raw.map((k) => normalizeTicketKey(k, projectKey)))]);
  if (keys.includes(ticketKey)) {
    throw new CliError(`--depends-on memuat tiket ini sendiri (${ticketKey}).`, { hint: `Hapus ${ticketKey} dari daftar.` });
  }
  return keys;
}

/**
 * Analisis branch tiket di `head` (boleh commit bayangan) terhadap `origin/<base>`: setiap commit non-merge
 * harus memuat key tiket di pesannya, dan merge hanya boleh membawa isi `origin/<base>` (sinkronisasi).
 */
export async function analyzeDependentTicket(git: DependentGit, ctx: IsolationContext, base: string, head: string): Promise<TicketAnalysis> {
  const baseRef = `${ctx.remote}/${base}`;
  const metas = await git.commitMeta(await git.revList(head, [baseRef]));
  const problems: Problem[] = [];
  const warnings: string[] = [];
  const commits: CommitMeta[] = [];
  const syncMerges: CommitMeta[] = [];
  const projectKey = ctx.ticketKey.split('-')[0] ?? '';

  for (const m of metas) {
    if (m.parents.length >= 2) {
      let sync = true;
      for (const p of m.parents.slice(1)) {
        if (!(await git.isAncestor(p, baseRef))) sync = false;
      }
      if (sync) syncMerges.push(m);
      else problems.push({ kind: 'dependent-merge', commit: m, base });
      continue;
    }
    if (!messageHasTicket(m.body, ctx.ticketKey)) {
      problems.push({ kind: 'dependent-no-ticket', commit: m, ticketKey: ctx.ticketKey });
      continue;
    }
    commits.push(m);
    const others = extractTicketKeys(m.subject, projectKey).filter((k) => k !== ctx.ticketKey);
    if (others.length) warnings.push(`${m.short} "${m.subject}" juga menyebut ${others.join(', ')} — pastikan memang milik ${ctx.ticketKey}.`);
  }

  const bad = new Set(problems.map((p) => ('commit' in p ? p.commit.sha : '')));
  return {
    head,
    forkPoint: metas[0]?.parents[0] ?? head,
    order: metas.filter((m) => !bad.has(m.sha)),
    commits,
    syncMerges,
    problems,
    warnings,
  };
}

const PR_MERGE_RE = /^Merge pull request #\d+ from (\S+)/;

/** Nama branch di subject merge GitHub: `Merge pull request #12 from org/feature/LOGIS-1-x` → `feature/LOGIS-1-x`. */
export function prMergeBranch(subject: string): string | null {
  const from = subject.match(PR_MERGE_RE)?.[1];
  if (!from) return null;
  const slash = from.indexOf('/');
  return slash >= 0 ? from.slice(slash + 1) : from;
}

export interface DependencyScope {
  remote: string;
  prod: string;
  base: string;
  projectKey: string;
  ticketKey: string;
}

/** File yang tidak menandakan ketergantungan kode: `documentation/**` (dari root repo) dan `*.md` di mana pun. */
export function isDependencyIgnoredPath(file: string): boolean {
  return /^documentation\/|\.md$/i.test(file);
}

/**
 * Tiket lain yang menyentuh file yang sama dengan commit tiket dan belum ada di production. Sumbernya dua:
 * pesan commit non-merge di `origin/<prod>..origin/<base>`, dan nama branch di merge PR GitHub.
 *
 * Merge diperiksa tersendiri karena `git log -- <path>` tidak menampilkan merge yang TREESAME ke salah satu
 * parent, padahal merge PR biasanya begitu. Ini heuristik berbasis file, bukan bukti ketergantungan.
 */
export async function detectDependencies(git: DependencyGit, scope: DependencyScope, commits: readonly CommitMeta[]): Promise<string[]> {
  const files = new Set<string>();
  for (const c of commits) {
    for (const f of await git.filesOfCommit(c.sha)) {
      if (!isDependencyIgnoredPath(f)) files.add(f);
    }
  }
  if (files.size === 0) return [];

  const include = `${scope.remote}/${scope.base}`;
  const exclude = [`${scope.remote}/${scope.prod}`];
  const found = new Set<string>();
  for (const c of await git.commitsTouching(include, exclude, [...files])) {
    for (const k of extractTicketKeys(c.message, scope.projectKey)) found.add(k);
  }
  for (const m of await git.mergeCommits(include, exclude)) {
    const branch = prMergeBranch(m.subject);
    if (!branch) continue;
    const keys = extractTicketKeys(branch, scope.projectKey).filter((k) => k !== scope.ticketKey && !found.has(k));
    if (keys.length === 0) continue; // key sudah ditemukan: lewati diff agar hemat perintah git
    const side = await git.mergeSideFiles(m.sha);
    if (side.some((f) => files.has(f))) for (const k of keys) found.add(k);
  }
  found.delete(scope.ticketKey);
  return sortTicketKeys([...found]);
}
