import { CliError } from '../utils/errors.js';
import { lines, runCommand, type ExecResult, type Runner } from '../utils/exec.js';

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

  async isDirty(): Promise<boolean> {
    const out = await this.execOk(['status', '--porcelain', '--untracked-files=all'], 'git status');
    return lines(out).length > 0;
  }

  async changedFiles(): Promise<string[]> {
    const out = await this.execOk(['status', '--porcelain', '--untracked-files=all'], 'git status');
    return lines(out);
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

  /** Stage semua perubahan lalu commit. Pesan dikirim lewat stdin (`-F -`), bukan argumen shell. */
  async commitAll(message: string): Promise<void> {
    await this.execOk(['add', '--all'], 'git add');
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
