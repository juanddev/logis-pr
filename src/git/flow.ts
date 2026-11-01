/**
 * Aturan alur branch tim LOGis (logika murni, tanpa I/O):
 *  - Semua branch kerja dibuat dari `production`.
 *  - Branch tidak boleh membawa commit yang hanya ada di `development`
 *    (tanda branch dibuat dari development, atau development di-merge ke branch).
 *  - Branch hotfix (default prefix `hotfix/`) bisa di-PR ke production dan/atau development.
 *  - Sebelum PR dibuat, merge ke setiap base disimulasikan; konflik = berhenti.
 */

export interface CommitInfo {
  sha: string;
  /** `<short-sha> <subject>` */
  line: string;
}

export interface MergeCheck {
  clean: boolean;
  conflicts: string[];
}

export function isHotfixBranch(branch: string, prefixes: readonly string[]): boolean {
  const b = branch.toLowerCase();
  return prefixes.some((p) => p.trim() !== '' && b.startsWith(p.trim().toLowerCase()));
}

/** Commit di branch (di luar production) yang sebenarnya hanya milik development. */
export function leakedDevCommits(branchCommits: readonly CommitInfo[], devOnly: readonly CommitInfo[]): CommitInfo[] {
  const dev = new Set(devOnly.map((c) => c.sha));
  return branchCommits.filter((c) => dev.has(c.sha));
}

/** Parse output `git merge-tree --write-tree --name-only --no-messages`. null = bukan output hasil merge (error). */
export function parseMergeTree(code: number, stdout: string): MergeCheck | null {
  const lines = stdout.split('\n').map((l) => l.trim());
  const first = lines[0] ?? '';
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(first)) return null;
  if (code === 0) return { clean: true, conflicts: [] };
  if (code !== 1) return null;
  const conflicts: string[] = [];
  for (const l of lines.slice(1)) {
    if (!l) break;
    if (!conflicts.includes(l)) conflicts.push(l);
  }
  return { clean: false, conflicts };
}

export type BaseChoice = 'both' | 'production' | 'development';

/** Daftar base PR sesuai pilihan hotfix. Production selalu didahulukan. */
export function basesForChoice(choice: BaseChoice, productionBranch: string, developmentBranch: string): string[] {
  if (choice === 'production') return [productionBranch];
  if (choice === 'development') return [developmentBranch];
  return [productionBranch, developmentBranch];
}
