import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliError } from '../utils/errors.js';
import { runCommand, type ExecResult, type Runner } from '../utils/exec.js';
import { parseMergeTree, type CommitInfo, type MergeCheck } from './flow.js';
import { parsePorcelainZ, type CommitPlan, type WorkingTreeStatus } from './plan.js';

export * from './flow.js';
export * from './plan.js';

export interface RemoteRepo {
  host: string;
  owner: string;
  repo: string;
}

/**
 * Parse URL remote GitHub:
 *   https://github.com/owner/repo(.git)  ·  https://user@github.com/owner/repo
 *   git@github.com:owner/repo(.git)      ·  ssh://git@github.com/owner/repo.git
 *   git@github-work:owner/repo.git (alias host SSH → dianggap github.com)
 */
export function parseRemoteUrl(url: string): RemoteRepo | null {
  const u = url.trim();
  const patterns = [
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^(?:[^@]+@)?([^:/]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  ];
  for (const re of patterns) {
    const m = u.match(re);
    if (m && m[1] && m[2] && m[3]) {
      const host = m[1].toLowerCase().includes('github') && !m[1].includes('.') ? 'github.com' : m[1].toLowerCase();
      return { host, owner: m[2], repo: m[3] };
    }
  }
  return null;
}

export class Git {
  constructor(
    private readonly runner: Runner = runCommand,
    private readonly cwd: string = process.cwd(),
  ) {}

  private exec(args: string[], opts: { input?: string; inheritStdin?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<ExecResult> {
    // -c core.quotepath=false: nama file non-ASCII tidak di-escape di output.
    return this.runner('git', ['-c', 'core.quotepath=false', ...args], { cwd: this.cwd, ...opts });
  }

  private async execOk(
    args: string[],
    what: string,
    opts: { input?: string; inheritStdin?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  ): Promise<string> {
    const res = await this.exec(args, opts);
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim();
      throw new CliError(`${what} gagal${detail ? `:\n${detail}` : '.'}`);
    }
    return res.stdout.trim();
  }

  async version(): Promise<string> {
    return this.execOk(['--version'], 'git --version');
  }

  async isRepo(): Promise<boolean> {
    const res = await this.exec(['rev-parse', '--is-inside-work-tree']);
    return res.code === 0 && res.stdout.trim() === 'true';
  }

  /** Nama branch aktif, atau null bila detached HEAD. */
  async currentBranch(): Promise<string | null> {
    const res = await this.exec(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (res.code !== 0) return null;
    return res.stdout.trim() || null;
  }

  /** Status working tree: file staged, berubah tapi belum di-stage, dan file baru (untracked). */
  async status(): Promise<WorkingTreeStatus> {
    // -z: dipisah NUL, nama file tidak di-quote — aman untuk spasi/karakter non-ASCII di semua OS.
    const res = await this.exec(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (res.code !== 0) throw new CliError(`git status gagal:\n${(res.stderr || res.stdout).trim()}`);
    return parsePorcelainZ(res.stdout);
  }

  async isDirty(): Promise<boolean> {
    const st = await this.status();
    return st.staged.length + st.unstaged.length + st.untracked.length > 0;
  }

  /**
   * URL remote seperti tertulis di config (tanpa rewrite `insteadOf`), agar identitas repo GitHub
   * tetap terbaca walau git diarahkan ke mirror/alias. Fallback: `git remote get-url`.
   */
  async remoteUrl(remote = 'origin'): Promise<string> {
    const raw = await this.exec(['config', '--get', `remote.${remote}.url`]);
    if (raw.code === 0 && raw.stdout.trim()) return raw.stdout.trim();
    const res = await this.exec(['remote', 'get-url', remote]);
    if (res.code !== 0) {
      throw new CliError(`Remote '${remote}' tidak ditemukan di repo ini.`, {
        hint: `Tambahkan dengan: git remote add ${remote} <url-github>, atau set remote yang benar di config (remote).`,
      });
    }
    return res.stdout.trim();
  }

  async remotes(): Promise<string[]> {
    const out = await this.execOk(['remote'], 'git remote');
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  /** Stage perubahan file yang SUDAH dilacak git (modifikasi & hapus). File baru tidak ikut. */
  async stageTracked(): Promise<void> {
    await this.execOk(['add', '--update'], 'git add --update');
  }

  /** Stage file tertentu (dipakai untuk file baru yang disetujui). Dicicil agar aman dari batas panjang command line Windows. */
  async stagePaths(paths: readonly string[]): Promise<void> {
    for (let i = 0; i < paths.length; i += 50) {
      await this.execOk(['add', '--', ...paths.slice(i, i + 50)], 'git add');
    }
  }

  /** Commit isi staging area. Pesan dikirim lewat stdin (`--file=-`), bukan argumen shell. */
  async commitStaged(message: string): Promise<void> {
    await this.execOk(['commit', '--file=-'], 'git commit', { input: `${message}\n` });
  }

  /** Push branch ke origin dan set upstream. stdin diteruskan agar prompt kredensial tetap bisa muncul. */
  async push(branch: string, remote = 'origin'): Promise<void> {
    await this.execOk(['push', '--set-upstream', remote, branch], 'git push', { inheritStdin: true });
  }

  async lastCommitSubject(): Promise<string | null> {
    const res = await this.exec(['log', '-1', '--pretty=format:%s']);
    if (res.code !== 0) return null;
    return res.stdout.trim() || null;
  }

  async headSha(): Promise<string | null> {
    const res = await this.exec(['rev-parse', 'HEAD']);
    return res.code === 0 ? res.stdout.trim() : null;
  }

  /** Ambil branch terbaru dari remote (memperbarui origin/<branch>, tidak mengubah branch lokal). */
  async fetch(branches: readonly string[], remote = 'origin'): Promise<void> {
    await this.execOk(['fetch', '--quiet', '--no-tags', remote, ...branches], `git fetch ${remote} ${branches.join(' ')}`, {
      inheritStdin: true,
    });
  }

  async refExists(ref: string): Promise<boolean> {
    const res = await this.exec(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return res.code === 0;
  }

  /** Commit yang ada di `include` tetapi tidak di semua `exclude` (seperti `git log A ^B`). */
  async commitsBetween(include: string, exclude: readonly string[]): Promise<CommitInfo[]> {
    const out = await this.execOk(
      ['log', '--format=%H%x09%h %s', include, ...exclude.map((e) => `^${e}`)],
      `git log ${include}`,
    );
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha = '', line = ''] = l.split('\t');
        return { sha, line };
      });
  }

  /**
   * Buat commit "bayangan" berisi perubahan yang AKAN di-commit, tanpa menyentuh branch, index,
   * maupun file kerja. Dipakai untuk cek konflik sebelum commit sungguhan (juga saat --dry-run).
   * Commit ini tidak direferensikan siapa pun dan akan dibersihkan git gc.
   * `message`: pesan yang akan dipakai commit sungguhan, bila pesan itu ikut divalidasi (--dependent).
   */
  async snapshotCommit(plan: CommitPlan, message?: string): Promise<string> {
    const head = (await this.execOk(['rev-parse', 'HEAD'], 'git rev-parse HEAD')).trim();
    if (plan.files.length === 0) return head;
    let tree: string;
    if (plan.mode === 'staged') {
      tree = await this.execOk(['write-tree'], 'git write-tree');
    } else {
      const tmp = path.join(os.tmpdir(), `logis-pr-index-${process.pid}-${randomBytes(4).toString('hex')}`);
      const env = { GIT_INDEX_FILE: tmp };
      try {
        await this.execOk(['read-tree', 'HEAD'], 'git read-tree', { env });
        if (plan.stageTracked) await this.execOk(['add', '--update'], 'git add --update', { env });
        for (let i = 0; i < plan.addUntracked.length; i += 50) {
          await this.execOk(['add', '--', ...plan.addUntracked.slice(i, i + 50)], 'git add', { env });
        }
        tree = await this.execOk(['write-tree'], 'git write-tree', { env });
      } finally {
        await rm(tmp, { force: true }).catch(() => undefined);
      }
    }
    const identity = {
      GIT_AUTHOR_NAME: 'logis-pr',
      GIT_AUTHOR_EMAIL: 'logis-pr@localhost',
      GIT_COMMITTER_NAME: 'logis-pr',
      GIT_COMMITTER_EMAIL: 'logis-pr@localhost',
    };
    return this.execOk(['commit-tree', tree.trim(), '-p', head, '-m', message ?? 'logis-pr conflict check'], 'git commit-tree', {
      env: identity,
    });
  }

  /**
   * Simulasi merge `commit` ke `base` (git ≥ 2.38). Tidak mengubah apa pun di repo kerja.
   * Exit 0 = bersih, 1 + tree id = konflik, lainnya = error.
   */
  async mergeCheck(base: string, commit: string): Promise<MergeCheck> {
    return this.mergeTree(base, commit);
  }

  /**
   * Seperti mergeCheck, tetapi objek hasil merge ditulis ke folder sementara yang langsung dihapus, sehingga
   * tidak ada objek baru di repo (dipakai --audit). Objek repo tetap terbaca lewat alternates.
   */
  async mergeCheckReadOnly(base: string, commit: string): Promise<MergeCheck> {
    const objects = path.resolve(this.cwd, await this.execOk(['rev-parse', '--git-path', 'objects'], 'git rev-parse --git-path'));
    const dir = await mkdtemp(path.join(os.tmpdir(), 'logis-pr-obj-'));
    try {
      return await this.mergeTree(base, commit, { GIT_OBJECT_DIRECTORY: dir, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async mergeTree(base: string, commit: string, env?: NodeJS.ProcessEnv): Promise<MergeCheck> {
    const res = await this.exec(['merge-tree', '--write-tree', '--name-only', '--no-messages', base, commit], { env });
    const parsed = parseMergeTree(res.code, res.stdout);
    if (parsed) return parsed;
    const detail = (res.stderr || res.stdout).trim();
    const old = /usage: git merge-tree|unknown option|write-tree/i.test(detail);
    throw new CliError(`Cek konflik ke '${base}' gagal${detail ? `:\n${detail}` : '.'}`, {
      hint: old
        ? 'Versi git terlalu lama untuk cek konflik (butuh git 2.38+). Update git: brew upgrade git / winget upgrade Git.Git'
        : undefined,
    });
  }

  // ── Inspeksi (read-only) ──────────────────────────────────────────────────────

  /** Operasi git yang sedang berjalan (merge/cherry-pick/revert/rebase/bisect) — commit saat ini berbahaya. */
  async inProgressOperations(): Promise<string[]> {
    const checks: Array<[string, string]> = [
      ['MERGE_HEAD', 'merge'],
      ['CHERRY_PICK_HEAD', 'cherry-pick'],
      ['REVERT_HEAD', 'revert'],
      ['rebase-merge', 'rebase'],
      ['rebase-apply', 'rebase/am'],
      ['BISECT_LOG', 'bisect'],
    ];
    const found: string[] = [];
    for (const [name, label] of checks) {
      const res = await this.exec(['rev-parse', '--git-path', name]);
      if (res.code !== 0) continue;
      const p = path.resolve(this.cwd, res.stdout.trim());
      if (await exists(p)) found.push(label);
    }
    return [...new Set(found)];
  }

  async resolve(ref: string): Promise<string | null> {
    const res = await this.exec(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return res.code === 0 ? res.stdout.trim() : null;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const res = await this.exec(['merge-base', '--is-ancestor', ancestor, descendant]);
    if (res.code === 0) return true;
    if (res.code === 1) return false;
    throw new CliError(`git merge-base gagal:\n${res.stderr.trim()}`);
  }

  /** `git rev-list include ^exclude...` urut lama → baru (topologis). */
  async revList(include: string, exclude: readonly string[] = []): Promise<string[]> {
    const out = await this.execOk(
      ['rev-list', '--reverse', '--topo-order', include, ...exclude.map((e) => `^${e}`), '--'],
      `git rev-list ${include}`,
    );
    return out.split('\n').filter(Boolean);
  }

  /** Metadata commit (parent, subject, body) — dicicil per 100 sha. */
  async commitMeta(shas: readonly string[]): Promise<CommitMeta[]> {
    const out: CommitMeta[] = [];
    for (let i = 0; i < shas.length; i += 100) {
      const chunk = shas.slice(i, i + 100);
      const raw = await this.execOk(
        ['show', '-s', '--no-color', '--format=%H%x1f%h%x1f%P%x1f%s%x1f%B%x1e', ...chunk],
        'git show',
      );
      for (const rec of raw.split('\x1e')) {
        const r = rec.replace(/^\n+/, '');
        if (!r.trim()) continue;
        const [sha = '', short = '', parents = '', subject = '', body = ''] = r.split('\x1f');
        out.push({ sha, short, parents: parents.split(' ').filter(Boolean), subject, body });
      }
    }
    return out;
  }

  /** patch-id stabil per commit non-merge (sama walau SHA beda, mis. hasil cherry-pick). */
  async patchIds(include: string, exclude: readonly string[] = []): Promise<Map<string, string>> {
    const diff = await this.execOk(
      ['log', '-p', '--no-merges', '--no-color', '--no-ext-diff', '--format=commit %H', include, ...exclude.map((e) => `^${e}`), '--'],
      'git log -p',
    );
    return this.toPatchIds(diff);
  }

  async patchIdsOf(shas: readonly string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (let i = 0; i < shas.length; i += 100) {
      const chunk = shas.slice(i, i + 100);
      if (!chunk.length) continue;
      const diff = await this.execOk(['show', '-p', '--no-color', '--no-ext-diff', '--format=commit %H', ...chunk, '--'], 'git show -p');
      for (const [k, v] of await this.toPatchIds(diff)) map.set(k, v);
    }
    return map;
  }

  private async toPatchIds(diff: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!diff.trim()) return map;
    const out = await this.execOk(['patch-id', '--stable'], 'git patch-id', { input: `${diff}\n` });
    for (const line of out.split('\n')) {
      const [pid, sha] = line.trim().split(/\s+/);
      if (pid && sha) map.set(sha, pid);
    }
    return map;
  }

  /** Branch remote yang memuat commit ini (mis. `origin/LOGIS-3920`). */
  async remoteBranchesContaining(sha: string, remote: string): Promise<string[]> {
    const out = await this.execOk(
      ['for-each-ref', '--format=%(refname:short)', '--contains', sha, `refs/remotes/${remote}/`],
      'git for-each-ref --contains',
    );
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  /** File yang berubah di commit. */
  async filesOfCommit(sha: string): Promise<string[]> {
    // --cc: untuk merge commit, hanya file yang hasil merge-nya berbeda dari semua parent (resolusi konflik).
    const out = await this.execOk(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', '--cc', sha], 'git diff-tree');
    return out.split('\0').filter(Boolean);
  }

  /** Diff ala PR GitHub (three-dot): perubahan `head` sejak merge-base dengan `base`. */
  async prDiffFiles(base: string, head: string): Promise<Array<{ status: string; path: string }>> {
    const out = await this.execOk(['diff', '--name-status', '-z', '--no-renames', `${base}...${head}`, '--'], 'git diff --name-status');
    const parts = out.split('\0').filter((x) => x !== '');
    const files: Array<{ status: string; path: string }> = [];
    for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i] ?? '', path: parts[i + 1] ?? '' });
    return files;
  }

  /**
   * Commit non-merge di `include ^exclude...` yang menyentuh salah satu `files`, dicicil per 50 path.
   * --full-history wajib: tanpanya git membuang sisi merge yang hasilnya TREESAME ke parent lain.
   * Path dibaca harfiah (GIT_LITERAL_PATHSPECS), jadi nama seperti `[id].ts` tidak dianggap glob.
   */
  async commitsTouching(include: string, exclude: readonly string[], files: readonly string[]): Promise<Array<{ sha: string; message: string }>> {
    const found = new Map<string, string>();
    for (let i = 0; i < files.length; i += 50) {
      const raw = await this.execOk(
        ['log', '--no-merges', '--full-history', '--format=%H%x1f%B%x1e', include, ...exclude.map((e) => `^${e}`), '--', ...files.slice(i, i + 50)],
        'git log -- <file>',
        { env: { GIT_LITERAL_PATHSPECS: '1' } },
      );
      for (const rec of raw.split('\x1e')) {
        const [sha = '', message = ''] = rec.replace(/^\n+/, '').split('\x1f');
        if (sha.trim()) found.set(sha.trim(), message);
      }
    }
    return [...found].map(([sha, message]) => ({ sha, message }));
  }

  /** Merge commit di `include ^exclude...`. */
  async mergeCommits(include: string, exclude: readonly string[]): Promise<CommitMeta[]> {
    const out = await this.execOk(['rev-list', '--merges', include, ...exclude.map((e) => `^${e}`), '--'], `git rev-list --merges ${include}`);
    return this.commitMeta(out.split('\n').filter(Boolean));
  }

  /** File yang berubah di sisi yang di-merge (`M^1...M^2`): perubahan bersih PR, sejak merge-base-nya. */
  async mergeSideFiles(sha: string): Promise<string[]> {
    const out = await this.execOk(['diff', '--name-only', '-z', '--no-renames', `${sha}^1...${sha}^2`, '--'], 'git diff --name-only');
    return out.split('\0').filter(Boolean);
  }

  /** SHA branch di remote tanpa fetch (read-only, lewat jaringan). */
  async lsRemote(remote: string, branches: readonly string[]): Promise<Map<string, string>> {
    const res = await this.exec(['ls-remote', '--heads', remote, ...branches.map((b) => `refs/heads/${b}`)], { timeoutMs: 60_000 });
    const map = new Map<string, string>();
    if (res.code !== 0) return map;
    for (const line of res.stdout.split('\n')) {
      const [sha, ref] = line.trim().split(/\s+/);
      if (sha && ref) map.set(ref.replace(/^refs\/heads\//, ''), sha);
    }
    return map;
  }

  async isValidBranchName(name: string): Promise<boolean> {
    const res = await this.exec(['check-ref-format', '--branch', name]);
    return res.code === 0;
  }

  /** Fetch satu branch; branch yang tidak ada di remote → false (bukan error). */
  async fetchOptional(branch: string, remote: string): Promise<boolean> {
    const res = await this.exec(['fetch', '--quiet', '--no-tags', remote, branch], { inheritStdin: true });
    return res.code === 0;
  }

  // ── Mutasi (hanya dipanggil setelah semua validasi lolos) ─────────────────────

  /** Buat branch lokal baru di `sha` tanpa checkout. Gagal bila branch sudah ada (tidak pernah menimpa). */
  async createBranchAt(name: string, sha: string): Promise<void> {
    await this.execOk(['branch', '--no-track', name, sha], `git branch ${name}`);
  }

  /** Majukan branch lokal secara fast-forward saja, atomik (gagal bila branch berubah sejak dibaca). */
  async fastForwardBranch(name: string, newSha: string, oldSha: string): Promise<void> {
    if (!(await this.isAncestor(oldSha, newSha))) {
      throw new CliError(`Menolak memperbarui '${name}': bukan fast-forward.`);
    }
    await this.execOk(['update-ref', '-m', 'logis-pr: fast-forward', `refs/heads/${name}`, newSha, oldSha], `git update-ref ${name}`);
  }

  /** Push branch apa adanya, tanpa --force dan tanpa mengubah upstream. */
  async pushBranch(name: string, remote: string): Promise<void> {
    await this.execOk(['push', remote, `refs/heads/${name}:refs/heads/${name}`], `git push ${remote} ${name}`, {
      inheritStdin: true,
    });
  }

  /**
   * Putar ulang langkah (cherry-pick -x / merge sinkronisasi production) di atas `start` memakai WORKTREE
   * SEMENTARA di folder temp, sehingga branch, index, dan file kerja developer tidak tersentuh.
   * Mengembalikan SHA hasil akhir (belum direferensikan branch mana pun). Konflik → operasi dibatalkan
   * DI WORKTREE SEMENTARA itu saja, lalu worktree dihapus.
   */
  async replayDetached(start: string, steps: readonly ReplayStep[]): Promise<CherryPickResult> {
    if (steps.length === 0) return { ok: true, sha: start };
    const dir = path.join(os.tmpdir(), `logis-pr-wt-${process.pid}-${randomBytes(4).toString('hex')}`);
    await this.execOk(['worktree', 'add', '--detach', '--quiet', dir, start], 'git worktree add');
    const wt = new Git(this.runner, dir);
    const conflictFiles = async () =>
      (await wt.exec(['diff', '--name-only', '--diff-filter=U', '-z'])).stdout.split('\0').filter(Boolean);
    try {
      for (const step of steps) {
        if (step.kind === 'pick') {
          const res = await wt.exec(['cherry-pick', '-x', '--allow-empty', '--keep-redundant-commits', step.sha]);
          if (res.code !== 0) {
            const files = await conflictFiles();
            await wt.exec(['cherry-pick', '--abort']);
            return { ok: false, failedAt: step.sha, files, detail: (res.stderr || res.stdout).trim() };
          }
          continue;
        }
        // Merge sinkronisasi production: gabungkan parent production yang sama seperti di branch tiket.
        const msg = `${step.subject}\n\n(replayed from ${step.sha} by logis-pr)`;
        const merge = await wt.exec(['merge', '--no-ff', '--no-commit', '--no-verify', ...step.parents]);
        if (step.copyTree) {
          // Isi worktree identik dengan branch tiket → pakai hasil (dan resolusi konflik) merge aslinya.
          await wt.execOk(['read-tree', '--reset', '-u', step.sha], 'git read-tree');
        } else if (merge.code !== 0) {
          const files = await conflictFiles();
          await wt.exec(['merge', '--abort']);
          return { ok: false, failedAt: step.sha, files, detail: (merge.stderr || merge.stdout).trim() };
        }
        const inMerge = await wt.exec(['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
        if (inMerge.code === 0) {
          await wt.execOk(['commit', '--no-verify', '--allow-empty', '--file=-'], 'git commit (replay merge)', { input: `${msg}\n` });
        }
      }
      const tip = (await wt.execOk(['rev-parse', 'HEAD'], 'git rev-parse')).trim();
      return { ok: true, sha: tip };
    } finally {
      await this.exec(['worktree', 'remove', '--force', dir]);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      await this.exec(['worktree', 'prune']);
    }
  }
}

export type ReplayStep =
  | { kind: 'pick'; sha: string }
  | { kind: 'merge'; sha: string; subject: string; parents: string[]; copyTree: boolean };

export interface CommitMeta {
  sha: string;
  short: string;
  parents: string[];
  subject: string;
  body: string;
}

export type CherryPickResult =
  | { ok: true; sha: string }
  | { ok: false; failedAt: string; files: string[]; detail: string };

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
