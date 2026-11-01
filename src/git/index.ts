import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
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

  private exec(args: string[], opts: { input?: string; inheritStdin?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<ExecResult> {
    // -c core.quotepath=false: nama file non-ASCII tidak di-escape di output.
    return this.runner('git', ['-c', 'core.quotepath=false', ...args], { cwd: this.cwd, ...opts });
  }

  private async execOk(
    args: string[],
    what: string,
    opts: { input?: string; inheritStdin?: boolean; env?: NodeJS.ProcessEnv } = {},
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

  async remoteUrl(remote = 'origin'): Promise<string> {
    const res = await this.exec(['remote', 'get-url', remote]);
    if (res.code !== 0) {
      throw new CliError(`Remote '${remote}' tidak ditemukan di repo ini.`, {
        hint: 'Tambahkan dengan: git remote add origin <url-github>',
      });
    }
    return res.stdout.trim();
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
   */
  async snapshotCommit(plan: CommitPlan): Promise<string> {
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
    return this.execOk(['commit-tree', tree.trim(), '-p', head, '-m', 'logis-pr conflict check'], 'git commit-tree', {
      env: identity,
    });
  }

  /**
   * Simulasi merge `commit` ke `base` (git ≥ 2.38). Tidak mengubah apa pun di repo kerja.
   * Exit 0 = bersih, 1 + tree id = konflik, lainnya = error.
   */
  async mergeCheck(base: string, commit: string): Promise<MergeCheck> {
    const res = await this.exec(['merge-tree', '--write-tree', '--name-only', '--no-messages', base, commit]);
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
}
