import { CliError } from '../utils/errors.js';
import { lines, runCommand, type ExecResult, type Runner } from '../utils/exec.js';

export interface PullRequest {
  number: number;
  url: string;
  title: string;
  isDraft: boolean;
  baseRefName: string;
}

export interface CreatePrInput {
  repo: string; // owner/repo
  base: string;
  head: string;
  title: string;
  body: string;
  draft?: boolean;
}

interface GhPrListItem extends PullRequest {
  headRefName?: string;
  headRepositoryOwner?: { login?: string };
}

/** Wrapper GitHub CLI (`gh`). Semua argumen dikirim sebagai array, body PR lewat stdin. */
export class GitHub {
  constructor(
    private readonly runner: Runner = runCommand,
    private readonly cwd: string = process.cwd(),
  ) {}

  private exec(args: string[], input?: string): Promise<ExecResult> {
    return this.runner('gh', args, { cwd: this.cwd, input });
  }

  async version(): Promise<string> {
    const res = await this.exec(['--version']);
    if (res.code !== 0) throw new CliError('gh --version gagal.');
    return lines(res.stdout)[0] ?? res.stdout.trim();
  }

  /** gh sudah login ke host? `gh auth status` keluar dengan kode non-zero bila belum. */
  /**
   * Apakah gh bisa dipakai untuk host ini?
   *
   * `gh auth status` keluar dengan kode non-zero bila SALAH SATU akun bermasalah — mis. akun lain
   * di keyring yang tokennya kedaluwarsa, atau env GH_TOKEN/GITHUB_TOKEN yang tidak valid — walau
   * akun aktif baik-baik saja. Karena itu: cek akun aktif saja (`--active`), lalu bila masih gagal,
   * verifikasi langsung dengan memanggil API (`gh api user`). Lolos API = token benar-benar berfungsi.
   */
  async authStatus(host = 'github.com'): Promise<{ ok: boolean; detail: string }> {
    const res = await this.exec(['auth', 'status', '--active', '--hostname', host]);
    const detail = lines(`${res.stdout}\n${res.stderr}`)
      .map((l) => l.trim())
      .filter((l) => /logged in|account|not logged|token invalid|failed|GH_TOKEN|GITHUB_TOKEN/i.test(l))
      .filter((l) => !/token:/i.test(l)) // jangan pernah cetak token
      .join(' | ');
    if (res.code === 0) return { ok: true, detail };

    const api = await this.exec(['api', 'user', '--hostname', host, '--jq', '.login']);
    const login = api.stdout.trim();
    if (api.code === 0 && login) return { ok: true, detail: `login sebagai ${login}` };

    const apiErr = lines(api.stderr)
      .map((l) => l.trim())
      .filter((l) => !/token:/i.test(l))
      .slice(0, 2)
      .join(' | ');
    return { ok: false, detail: detail || apiErr };
  }

  /** PR open untuk branch ini (milik owner repo yang sama), bila ada. */
  async findOpenPr(repo: string, branch: string): Promise<PullRequest | null> {
    const owner = repo.split('/')[0]?.toLowerCase();
    const res = await this.exec([
      'pr',
      'list',
      '--repo',
      repo,
      '--head',
      branch,
      '--state',
      'open',
      '--limit',
      '10',
      '--json',
      'number,url,title,isDraft,baseRefName,headRefName,headRepositoryOwner',
    ]);
    if (res.code !== 0) {
      throw new CliError(`Gagal mengecek PR yang sudah ada:\n${res.stderr.trim()}`, {
        hint: 'Pastikan akun gh punya akses ke repo ini (gh auth status).',
      });
    }
    let items: GhPrListItem[];
    try {
      items = JSON.parse(res.stdout || '[]') as GhPrListItem[];
    } catch {
      throw new CliError('Output gh pr list tidak bisa dibaca (bukan JSON).');
    }
    const match = items.find(
      (pr) =>
        (pr.headRefName === undefined || pr.headRefName === branch) &&
        (!pr.headRepositoryOwner?.login || pr.headRepositoryOwner.login.toLowerCase() === owner),
    );
    if (!match) return null;
    return {
      number: match.number,
      url: match.url,
      title: match.title,
      isDraft: match.isDraft,
      baseRefName: match.baseRefName,
    };
  }

  /** Buat PR, kembalikan URL-nya. */
  async createPr(input: CreatePrInput): Promise<string> {
    const args = [
      'pr',
      'create',
      '--repo',
      input.repo,
      '--base',
      input.base,
      '--head',
      input.head,
      '--title',
      input.title,
      '--body-file',
      '-',
    ];
    if (input.draft) args.push('--draft');
    const res = await this.exec(args, input.body);
    if (res.code !== 0) {
      const detail = res.stderr.trim() || res.stdout.trim();
      if (/already exists/i.test(detail)) {
        const existing = await this.findOpenPr(input.repo, input.head);
        if (existing) return existing.url;
      }
      let hint: string | undefined;
      if (/No commits between/i.test(detail)) {
        hint = `Branch '${input.head}' belum punya commit yang berbeda dari '${input.base}'.`;
      } else if (/base.*(invalid|not found)|Base ref/i.test(detail)) {
        hint = `Base branch '${input.base}' tidak ada di remote. Gunakan -b <branch>.`;
      }
      throw new CliError(`Gagal membuat PR:\n${detail}`, { hint });
    }
    const url = lines(res.stdout)
      .reverse()
      .find((l) => /^https?:\/\/\S+\/pull\/\d+/.test(l.trim()));
    if (!url) throw new CliError(`PR mungkin dibuat, tetapi URL tidak terbaca dari output gh:\n${res.stdout}`);
    return url.trim();
  }
}
