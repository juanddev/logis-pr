/**
 * Logika murni (tanpa I/O) untuk menentukan file apa saja yang ikut commit.
 *
 * Prinsip keamanan: logis-pr TIDAK PERNAH menjalankan `git add --all`.
 *  1. Bila sudah ada file yang di-stage → hanya itu yang di-commit (pilihan pengguna dihormati).
 *  2. Bila belum ada → hanya perubahan file yang SUDAH dilacak git (`git add --update`).
 *  3. File baru (untracked) hanya ikut bila pengguna menyetujui (prompt / -a).
 *  4. Folder repo git terpisah (embedded repo) tidak pernah ikut.
 */

export interface WorkingTreeStatus {
  /** Sudah di-stage (kolom X porcelain). */
  staged: string[];
  /** File terlacak yang berubah tapi belum di-stage (kolom Y porcelain). */
  unstaged: string[];
  /** File/folder baru yang belum dilacak git (`??`). Folder berakhiran `/` = repo git terpisah. */
  untracked: string[];
}

/** Parse `git status --porcelain=v1 -z`. Rename/copy (`R`/`C`) memakai satu field tambahan (path lama). */
export function parsePorcelainZ(output: string): WorkingTreeStatus {
  const st: WorkingTreeStatus = { staged: [], unstaged: [], untracked: [] };
  const parts = output.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    if (x === '?' && y === '?') {
      st.untracked.push(path);
      continue;
    }
    if (x === '!') continue; // ignored
    if (x !== ' ') st.staged.push(path);
    if (y !== ' ') st.unstaged.push(path);
    if (x === 'R' || x === 'C') i++; // lewati path asal
  }
  return st;
}

/** Git menampilkan repo git bersarang (bukan submodule) sebagai folder berakhiran `/`. */
export function isEmbeddedRepo(path: string): boolean {
  return path.endsWith('/');
}

const SENSITIVE = [
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)\.npmrc$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /(^|\/)(credentials|secrets?)(\.[a-z0-9]+)?$/i,
  /serviceaccount.*\.json$/i,
];

/** Nama file yang kemungkinan berisi rahasia — ditandai saat ditanyakan ke pengguna. */
export function looksSensitive(path: string): boolean {
  return SENSITIVE.some((re) => re.test(path));
}

export type CommitMode = 'staged' | 'tracked';

export interface CommitPlan {
  mode: CommitMode;
  /** Jalankan `git add --update` (hanya mode tracked dan ada perubahan file terlacak). */
  stageTracked: boolean;
  /** File baru yang akan di-`git add`. */
  addUntracked: string[];
  /** Daftar akhir file yang masuk commit. */
  files: string[];
  /** File yang sengaja tidak ikut commit. */
  left: string[];
}

/**
 * Susun rencana commit dari status working tree dan daftar file baru yang disetujui.
 * `approvedUntracked` difilter lagi agar hanya berisi file untracked yang valid (bukan embedded repo).
 */
export function planCommit(st: WorkingTreeStatus, approvedUntracked: readonly string[] = []): CommitPlan {
  if (st.staged.length > 0) {
    const left = [...new Set([...st.unstaged.filter((p) => !st.staged.includes(p)), ...st.untracked])];
    return { mode: 'staged', stageTracked: false, addUntracked: [], files: [...st.staged], left };
  }
  const allowed = new Set(st.untracked.filter((p) => !isEmbeddedRepo(p)));
  const addUntracked = approvedUntracked.filter((p) => allowed.has(p));
  const left = st.untracked.filter((p) => !addUntracked.includes(p));
  return {
    mode: 'tracked',
    stageTracked: st.unstaged.length > 0,
    addUntracked,
    files: [...st.unstaged, ...addUntracked],
    left,
  };
}
