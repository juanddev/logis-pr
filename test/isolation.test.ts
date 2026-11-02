/** Unit test isolasi branch (analyzeTicket / planIntegration / validatePrDiff) & method Git baru, di repo temp. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Git } from '../src/git/index.js';
import {
  analyzeTicket,
  cherryPickSources,
  integrationBranchName,
  planIntegration,
  validatePrDiff,
  type IsolationContext,
} from '../src/git/isolation.js';
import { runCommand } from '../src/utils/exec.js';
import { makeFixture, type Fixture } from './gitfixture.js';

vi.setConfig({ testTimeout: 60_000 });

const fixtures: Fixture[] = [];
afterEach(() => {
  while (fixtures.length) fixtures.pop()?.cleanup();
});

const ctx: IsolationContext = {
  remote: 'origin',
  prod: 'production',
  envs: ['staging', 'development'],
  ticketKey: 'LOGIS-3938',
  ownBranches: ['LOGIS-3938', 'LOGIS-3938-dev'],
};

function setup(from = 'production') {
  const fx = makeFixture();
  fixtures.push(fx);
  fx.g('switch', '-q', '-c', 'LOGIS-3938', `origin/${from}`);
  fx.commit('LOGIS-3938: satu', { 'a1.ts': '1\n' });
  fx.commit('LOGIS-3938: dua', { 'a2.ts': '2\n' });
  return { fx, git: new Git(runCommand, fx.work) };
}

describe('helper murni', () => {
  it('cherryPickSources membaca trailer -x', () => {
    expect(cherryPickSources('x\n\n(cherry picked from commit abc1234def)\n(cherry picked from commit 99aa00bb11)')).toEqual([
      'abc1234def',
      '99aa00bb11',
    ]);
    expect(cherryPickSources('tanpa trailer')).toEqual([]);
  });

  it('integrationBranchName', () => {
    expect(integrationBranchName('{TICKET}-dev', 'LOGIS-3938', 'feature/LOGIS-3938-x', 'development', 'development')).toBe('LOGIS-3938-dev');
    expect(integrationBranchName('{TICKET}-dev', 'LOGIS-3938', 'feature/LOGIS-3938-x', 'staging', 'development')).toBe('LOGIS-3938-staging');
  });
});

describe('analyzeTicket', () => {
  it('branch dari production: 2 commit tiket, tanpa masalah, fork point = ujung production', async () => {
    const { fx, git } = setup();
    const t = await analyzeTicket(git, ctx, fx.g('rev-parse', 'HEAD'));
    expect(t.problems).toEqual([]);
    expect(t.commits.map((c) => c.subject)).toEqual(['LOGIS-3938: satu', 'LOGIS-3938: dua']);
    expect(t.forkPoint).toBe(fx.g('rev-parse', 'origin/production'));
  });

  it('branch dari development: 3 commit development ditandai env-commit', async () => {
    const { fx, git } = setup('development');
    const t = await analyzeTicket(git, ctx, fx.g('rev-parse', 'HEAD'));
    expect(t.problems.filter((p) => p.kind === 'env-commit')).toHaveLength(3);
  });

  it('commit dari branch tiket lain ditandai foreign-branch', async () => {
    const { fx, git } = setup();
    fx.g('merge', '-q', '--no-edit', 'origin/LOGIS-3920');
    const t = await analyzeTicket(git, ctx, fx.g('rev-parse', 'HEAD'));
    const kinds = t.problems.map((p) => p.kind);
    expect(kinds).toContain('foreign-branch');
    expect(kinds).toContain('merge');
  });

  it('merge origin/production = merge sinkronisasi (bukan masalah)', async () => {
    const { fx, git } = setup();
    fx.commit('hotfix prod', { 'p.ts': 'p\n' }, 'seed');
    fx.s('push', '-q', 'origin', 'production');
    fx.g('fetch', '-q', 'origin');
    fx.g('merge', '-q', '--no-edit', 'origin/production');
    const t = await analyzeTicket(git, ctx, fx.g('rev-parse', 'HEAD'));
    expect(t.problems).toEqual([]);
    expect(t.syncMerges).toHaveLength(1);
    expect(t.commits).toHaveLength(2);
  });
});

describe('planIntegration & validatePrDiff', () => {
  it('rencana -dev baru: start di fork point, 2 pick, PR ke development bersih setelah replay', async () => {
    const { fx, git } = setup();
    const head = fx.g('rev-parse', 'HEAD');
    const t = await analyzeTicket(git, ctx, head);
    const plan = await planIntegration(git, ctx, t, 'development', 'LOGIS-3938-dev');
    expect(plan.existed).toBe(false);
    expect(plan.start).toBe(t.forkPoint);
    expect(plan.steps.map((s) => s.kind)).toEqual(['pick', 'pick']);
    const r = await git.replayDetached(plan.start, plan.steps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const report = await validatePrDiff(git, ctx, t, 'development', r.sha);
    expect(report.problems).toEqual([]);
    expect(report.ticket).toHaveLength(2);
    expect(report.files.map((f) => f.path).sort()).toEqual(['a1.ts', 'a2.ts']);
    // replay tidak membuat ref/worktree apa pun
    expect(fx.g('for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/LOGIS-3938');
    expect(fx.g('worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('validatePrDiff langsung dari branch tercemar ke development menandai commit asing', async () => {
    const { fx, git } = setup();
    fx.g('merge', '-q', '--no-edit', 'origin/staging');
    const head = fx.g('rev-parse', 'HEAD');
    const t = await analyzeTicket(git, ctx, head);
    expect(t.problems.length).toBeGreaterThan(0);
    const report = await validatePrDiff(git, ctx, t, 'development', head);
    expect(report.problems.map((p) => p.kind)).toContain('pr-unexpected-commit');
  });
});

describe('method Git baru', () => {
  it('createBranchAt menolak menimpa; fastForwardBranch menolak non-fast-forward', async () => {
    const { fx, git } = setup();
    const head = fx.g('rev-parse', 'HEAD');
    const prod = fx.g('rev-parse', 'origin/production');
    await git.createBranchAt('X', prod);
    await expect(git.createBranchAt('X', head)).rejects.toThrow();
    await git.fastForwardBranch('X', head, prod);
    expect(fx.g('rev-parse', 'X')).toBe(head);
    await expect(git.fastForwardBranch('X', prod, head)).rejects.toThrow();
    expect(fx.g('rev-parse', 'X')).toBe(head);
  });

  it('inProgressOperations, remotes, isValidBranchName, lsRemote', async () => {
    const { fx, git } = setup();
    expect(await git.inProgressOperations()).toEqual([]);
    fx.g('merge', '--no-commit', '--no-ff', 'origin/LOGIS-3920');
    expect(await git.inProgressOperations()).toEqual(['merge']);
    fx.g('merge', '--abort');
    expect(await git.remotes()).toEqual(['origin']);
    expect(await git.isValidBranchName('LOGIS-3938-dev')).toBe(true);
    expect(await git.isValidBranchName('bad..name')).toBe(false);
    const live = await git.lsRemote('origin', ['production', 'tidak-ada']);
    expect(live.get('production')).toBe(fx.g('rev-parse', 'origin/production'));
    expect(live.has('tidak-ada')).toBe(false);
  });
});
