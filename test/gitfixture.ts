/**
 * Repo git SUNGGUHAN di folder temp untuk test (tidak pernah menyentuh repo developer).
 *
 *   remote.git (bare)  ← "GitHub"
 *     production : init
 *     staging    : production + "LOGIS-3800: fitur staging"
 *     development: production + 3 commit LOGIS-37x (file dev*.ts)
 *     LOGIS-3920 : production + "LOGIS-3920: tiket lain"
 *   work/              ← clone developer; URL remote = github.com/…, diarahkan ke remote.git lewat insteadOf
 *   seed/              ← clone "orang lain" untuk mendorong perubahan ke remote
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PullRequest, PrDetails, ReviewerResult } from '../src/github/index.js';
import type { GitHubLike } from '../src/cli/run.js';

export const REPO = 'developerserasiautoraya/SELOG_LOGIS_ServiceOrder';
export const URL = `https://github.com/${REPO}.git`;

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'Dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

export interface Fixture {
  root: string;
  bare: string;
  work: string;
  seed: string;
  /** git di folder kerja developer */
  g: (...args: string[]) => string;
  /** git di clone "orang lain" */
  s: (...args: string[]) => string;
  /** git langsung di repo bare (= isi GitHub) */
  b: (...args: string[]) => string;
  write: (rel: string, content: string, dir?: string) => void;
  commit: (msg: string, files: Record<string, string>, dir?: 'work' | 'seed') => string;
  remoteRefs: () => string;
  cleanup: () => void;
}

function run(cwd: string, args: string[], allowFail = false): string {
  try {
    return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFail) return '';
    const e = err as { stderr?: string; stdout?: string };
    throw new Error(`git ${args.join(' ')} gagal di ${cwd}:\n${e.stderr ?? ''}${e.stdout ?? ''}`, { cause: err });
  }
}

export function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'logis-pr-fx-'));
  const bare = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const work = path.join(root, 'work');
  const bareUrl = bare.replace(/\\/g, '/');
  run(root, ['init', '-q', '--bare', bare]);
  run(root, ['init', '-q', '-b', 'production', seed]);
  const s = (...a: string[]) => run(seed, a);
  const write = (rel: string, content: string, dir = work) => writeFileSync(path.join(dir, rel), content);
  const commitIn = (dir: string, msg: string, files: Record<string, string>) => {
    for (const [f, c] of Object.entries(files)) write(f, c, dir);
    run(dir, ['add', '--', ...Object.keys(files)]);
    run(dir, ['commit', '-q', '-m', msg]);
    return run(dir, ['rev-parse', 'HEAD']);
  };
  s('config', 'user.email', 'dev@example.com');
  s('config', 'user.name', 'Dev');
  s('remote', 'add', 'origin', bareUrl);
  commitIn(seed, 'init', { 'app.ts': 'a\nb\nc\n', 'README.md': '# svc\n' });
  s('push', '-q', 'origin', 'production');
  s('switch', '-q', '-c', 'staging');
  commitIn(seed, 'LOGIS-3800: fitur staging', { 'stg.ts': 'stg\n' });
  s('push', '-q', 'origin', 'staging');
  s('switch', '-q', '-c', 'development', 'production');
  for (let i = 1; i <= 3; i++) commitIn(seed, `LOGIS-37${i}: fitur dev ${i}`, { [`dev${i}.ts`]: `dev ${i}\n` });
  s('push', '-q', 'origin', 'development');
  s('switch', '-q', '-c', 'LOGIS-3920', 'production');
  commitIn(seed, 'LOGIS-3920: tiket lain', { 'other.ts': 'other\n' });
  s('push', '-q', 'origin', 'LOGIS-3920');
  s('switch', '-q', 'production');

  run(root, ['clone', '-q', bareUrl, work]);
  const g = (...a: string[]) => run(work, a);
  g('config', 'user.email', 'dev@example.com');
  g('config', 'user.name', 'Dev');
  g('config', 'remote.origin.url', URL);
  g('config', `url.${bareUrl}.insteadOf`, URL);
  g('fetch', '-q', 'origin');

  return {
    root,
    bare,
    work,
    seed,
    g,
    s,
    b: (...a: string[]) => run(bare, a),
    write: (rel, content, dir) => write(rel, content, dir ?? work),
    commit: (msg, files, dir = 'work') => commitIn(dir === 'work' ? work : seed, msg, files),
    remoteRefs: () => run(bare, ['for-each-ref', '--format=%(refname) %(objectname)']),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Snapshot keadaan repo developer yang TIDAK boleh berubah oleh --dry-run / --audit. */
export function localState(fx: Fixture): string {
  const refs = run(fx.work, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags']);
  const head = run(fx.work, ['symbolic-ref', '-q', 'HEAD'], true) + run(fx.work, ['rev-parse', 'HEAD']);
  const index = run(fx.work, ['ls-files', '-s']);
  const status = run(fx.work, ['status', '--porcelain=v1', '--untracked-files=all']);
  const worktrees = run(fx.work, ['worktree', 'list', '--porcelain']);
  const ops = ['MERGE_HEAD', 'CHERRY_PICK_HEAD'].filter((f) => existsSync(path.join(fx.work, '.git', f))).join(',');
  return [refs, head, index, status, worktrees, ops].join('\n---\n');
}

/** GitHub tiruan: PR disimpan di memori, isi PR dihitung dari repo bare seperti GitHub. */
export function fakeGitHub(fx: Fixture, opts: { tamperExtraCommit?: string } = {}) {
  const prs: Array<PullRequest & { headRefName: string }> = [];
  const reviewers = new Map<number, string[]>();
  let n = 900;
  const gh: GitHubLike = {
    version: async () => 'gh version 2.80.0 (fake)',
    authStatus: async () => ({ ok: true, detail: 'Logged in' }),
    findOpenPr: async (_repo, head, base) => {
      const pr = prs.find((p) => p.headRefName === head && (!base || p.baseRefName === base));
      return pr ? { number: pr.number, url: pr.url, title: pr.title, isDraft: pr.isDraft, baseRefName: pr.baseRefName } : null;
    },
    createPr: async (input) => {
      if (!run(fx.bare, ['rev-parse', '-q', '--verify', `refs/heads/${input.head}`], true)) {
        throw new Error(`head ${input.head} belum di-push`);
      }
      const number = ++n;
      prs.push({
        number,
        url: `https://github.com/${input.repo}/pull/${number}`,
        title: input.title,
        isDraft: Boolean(input.draft),
        baseRefName: input.base,
        headRefName: input.head,
      });
      return `https://github.com/${input.repo}/pull/${number}`;
    },
    prDetails: async (_repo, number): Promise<PrDetails> => {
      const pr = prs.find((p) => p.number === number);
      if (!pr) throw new Error('PR tidak ada');
      const head = run(fx.bare, ['rev-parse', `refs/heads/${pr.headRefName}`]);
      const base = `refs/heads/${pr.baseRefName}`;
      const commits = run(fx.bare, ['rev-list', head, `^${base}`]).split('\n').filter(Boolean);
      if (opts.tamperExtraCommit) commits.push(opts.tamperExtraCommit);
      const files = run(fx.bare, ['diff', '--name-only', `${base}...${head}`]).split('\n').filter(Boolean).length;
      return { number, url: pr.url, headRefName: pr.headRefName, baseRefName: pr.baseRefName, headRefOid: head, changedFiles: files, commits };
    },
    ensureReviewers: async (_repo, number, list): Promise<ReviewerResult> => {
      const cur = reviewers.get(number) ?? [];
      const add = list.filter((r) => !cur.includes(r));
      reviewers.set(number, [...cur, ...add]);
      return { requested: add, alreadyRequested: list.filter((r) => cur.includes(r)), alreadyReviewed: [], skippedAuthor: [] };
    },
  };
  return { gh, prs, reviewers };
}
