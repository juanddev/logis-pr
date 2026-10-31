import { CliError } from '../utils/errors.js';
import { runCommand, type ExecResult, type Runner } from '../utils/exec.js';
import { parsePorcelainZ, type WorkingTreeStatus } from './plan.js';

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

  private exec(args: string[], opts: { input?: string; inheritStdin?: boolean } = {}): Promise<ExecResult> {
    // -c core.quotepath=false: nama file non-ASCII tidak di-escape di output.
    return this.runner('git', ['-c', 'core.quotepath=false', ...args], { cwd: this.cwd, ...opts });
  }

  private async execOk(args: string[], what: string, opts: { input?: string; inheritStdin?: boolean } = {}): Promise<string> {
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
}
