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
  async findOpenPr(repo: string, branch: string, base?: string): Promise<PullRequest | null> {
    const owner = repo.split('/')[0]?.toLowerCase();
    const res = await this.exec([
      'pr',
      'list',
      '--repo',
      repo,
      '--head',
      branch,
      ...(base ? ['--base', base] : []),
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
        (!base || pr.baseRefName === undefined || pr.baseRefName === base) &&
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
        const existing = await this.findOpenPr(input.repo, input.head, input.base);
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

  /** Detail PR seperti dihitung GitHub (dipakai untuk verifikasi setelah PR dibuat/dipakai ulang). */
  async prDetails(repo: string, number: number): Promise<PrDetails> {
    const res = await this.exec([
      'pr',
      'view',
      String(number),
      '--repo',
      repo,
      '--json',
      'number,url,headRefName,baseRefName,headRefOid,changedFiles,commits,state',
    ]);
    if (res.code !== 0) throw new CliError(`Gagal membaca PR #${number}:\n${res.stderr.trim()}`);
    try {
      const d = JSON.parse(res.stdout) as {
        number: number;
        url: string;
        headRefName: string;
        baseRefName: string;
        headRefOid: string;
        changedFiles: number;
        state?: string;
        commits?: Array<{ oid: string }>;
      };
      return { ...d, commits: (d.commits ?? []).map((c) => c.oid) };
    } catch {
      throw new CliError(`Output gh pr view #${number} tidak bisa dibaca.`);
    }
  }

  /**
   * Minta review dari `reviewers` untuk PR. Idempoten: reviewer yang sudah diminta atau sudah
   * memberi review dilewati (tidak ada notifikasi ulang), dan penulis PR tidak bisa me-review PR-nya
   * sendiri. Memakai REST API lewat `gh api` (lebih stabil dibanding `gh pr edit`).
   */
  async ensureReviewers(repo: string, prNumber: number, reviewers: readonly string[]): Promise<ReviewerResult> {
    const result: ReviewerResult = { requested: [], alreadyRequested: [], alreadyReviewed: [], skippedAuthor: [] };
    if (reviewers.length === 0) return result;
    const base = `repos/${repo}/pulls/${prNumber}`;

    const pr = await this.apiJson<{ user?: { login?: string }; requested_reviewers?: Array<{ login?: string }> }>(
      [base],
      'membaca PR',
    );
    const reviews = await this.apiJson<Array<{ user?: { login?: string } }>>([`${base}/reviews?per_page=100`], 'membaca review PR');
    const lc = (s: string | undefined) => (s ?? '').toLowerCase();
    const author = lc(pr.user?.login);
    const requested = new Set((pr.requested_reviewers ?? []).map((r) => lc(r.login)));
    const reviewed = new Set(reviews.map((r) => lc(r.user?.login)));

    const toAdd: string[] = [];
    for (const r of reviewers) {
      const k = lc(r);
      if (k === author) result.skippedAuthor.push(r);
      else if (requested.has(k)) result.alreadyRequested.push(r);
      else if (reviewed.has(k)) result.alreadyReviewed.push(r);
      else toAdd.push(r);
    }
    if (toAdd.length === 0) return result;

    const args = ['api', '-X', 'POST', `${base}/requested_reviewers`];
    for (const r of toAdd) args.push('-f', `reviewers[]=${r}`);
    const res = await this.exec(args);
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim();
      let hint: string | undefined;
      if (/collaborator/i.test(detail)) {
        hint = `Pastikan ${toAdd.join(', ')} punya akses ke repo ${repo} (collaborator / anggota tim org).`;
      } else if (/HTTP 404|Not Found/i.test(detail)) {
        hint = 'Username reviewer tidak ditemukan, atau akun gh Anda tidak punya izin meminta review di repo ini.';
      }
      throw new CliError(`Gagal meminta review dari ${toAdd.join(', ')}:\n${detail}`, { hint });
    }
    result.requested = toAdd;
    return result;
  }

  private async apiJson<T>(args: string[], what: string): Promise<T> {
    const res = await this.exec(['api', ...args]);
    if (res.code !== 0) throw new CliError(`Gagal ${what}:\n${(res.stderr || res.stdout).trim()}`);
    try {
      return JSON.parse(res.stdout) as T;
    } catch {
      throw new CliError(`Output gh api tidak bisa dibaca saat ${what}.`);
    }
  }
}

export interface PrDetails {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  changedFiles: number;
  state?: string;
  commits: string[];
}

export interface ReviewerResult {
  requested: string[];
  alreadyRequested: string[];
  alreadyReviewed: string[];
  skippedAuthor: string[];
}

/** Nomor PR dari URL `https://github.com/o/r/pull/123`. */
export function prNumberFromUrl(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)/);
  return m?.[1] ? Number(m[1]) : null;
}
