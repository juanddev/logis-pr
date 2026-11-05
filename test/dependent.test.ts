/** Mode --dependent: analisis isi branch & deteksi dependensi, di repo git sungguhan (folder temp). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeDependentTicket, dependentRejections, detectDependencies, prMergeBranch } from '../src/git/dependent.js';
import { Git } from '../src/git/index.js';
import { describeProblems, type IsolationContext } from '../src/git/isolation.js';
import { runCommand } from '../src/utils/exec.js';
import { makeFixture, type Fixture } from './gitfixture.js';

vi.setConfig({ testTimeout: 60_000 });

const KEY = 'LOGIS-3945';
const BRANCH = 'feature/LOGIS-3945-x';
const ctx: IsolationContext = { remote: 'origin', prod: 'production', envs: ['staging', 'development'], ticketKey: KEY, ownBranches: [BRANCH] };
const scope = { remote: 'origin', prod: 'production', base: 'development', projectKey: 'LOGIS', ticketKey: KEY };

const fixtures: Fixture[] = [];
afterEach(() => {
  while (fixtures.length) fixtures.pop()?.cleanup();
});

function setup(prepare?: (fx: Fixture) => void) {
  const fx = makeFixture();
  fixtures.push(fx);
  prepare?.(fx);
  fx.g('fetch', '-q', 'origin');
  fx.g('switch', '-q', '-c', BRANCH, 'origin/development');
  return { fx, git: new Git(runCommand, fx.work) };
}

/** Merge PR ala GitHub di development: isi PR ada di commit tanpa key, key hanya di nama branch. */
function mergePr(fx: Fixture, branch: string, files: Record<string, string>, n = 12) {
  fx.s('switch', '-q', '-c', branch, 'development');
  fx.commit('perbaikan tanpa key', files, 'seed');
  fx.s('switch', '-q', 'development');
  fx.s('merge', '-q', '--no-ff', '-m', `Merge pull request #${n} from developerserasiautoraya/${branch}`, branch);
  fx.s('push', '-q', 'origin', 'development');
}

describe('dependentRejections', () => {
  const base = { branch: BRANCH, hotfix: false, requestedBases: [], dev: 'development', prod: 'production', pushTicket: false };

  it('kombinasi sah → tidak ada penolakan', () => {
    expect(dependentRejections(base)).toEqual([]);
    expect(dependentRejections({ ...base, requestedBases: ['development'] })).toEqual([]);
  });

  it.each([
    [{ hotfix: true }, /hotfix/i],
    [{ requestedBases: ['production'] }, /'production'/],
    [{ requestedBases: ['development', 'production'] }, /'production'/],
    [{ requestedBases: ['staging'] }, /'staging'/],
    [{ pushTicket: true }, /--push-ticket/],
  ])('%j ditolak', (over, re) => {
    const out = dependentRejections({ ...base, ...over });
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toMatch(re);
    expect(out[0]?.hint).toBeTruthy();
  });
});

describe('analyzeDependentTicket', () => {
  it('hanya commit tiket di atas development → bersih, commit development tidak ikut dihitung', async () => {
    const { fx, git } = setup();
    fx.commit('LOGIS-3945: satu', { 'a.ts': '1\n' });
    fx.commit('ver:1.0.0 tkt:LOGIS-3945 msg:dua', { 'b.ts': '2\n' });
    fx.commit('judul tanpa key\n\nRef: LOGIS-3945', { 'c.ts': '3\n' });
    const t = await analyzeDependentTicket(git, ctx, 'development', fx.g('rev-parse', 'HEAD'));
    expect(t.problems).toEqual([]);
    expect(t.commits.map((c) => c.subject)).toEqual(['LOGIS-3945: satu', 'ver:1.0.0 tkt:LOGIS-3945 msg:dua', 'judul tanpa key']);
  });

  it('commit tanpa key tiket, atau key yang hanya mirip → masalah', async () => {
    const { fx, git } = setup();
    fx.commit('LOGIS-3944: tiket lain', { 'a.ts': '1\n' });
    fx.commit('LOGIS-39450: key lebih panjang', { 'b.ts': '2\n' });
    const t = await analyzeDependentTicket(git, ctx, 'development', fx.g('rev-parse', 'HEAD'));
    expect(t.problems.map((p) => p.kind)).toEqual(['dependent-no-ticket', 'dependent-no-ticket']);
    expect(t.commits).toEqual([]);
    expect(describeProblems(t.problems).join('\n')).toMatch(/LOGIS-3944: tiket lain/);
  });

  it('merge dari origin/development = sinkronisasi', async () => {
    const { fx, git } = setup();
    fx.commit('LOGIS-3945: satu', { 'a.ts': '1\n' });
    fx.s('switch', '-q', 'development');
    fx.commit('LOGIS-3800: lanjutan dev', { 'd.ts': 'd\n' }, 'seed');
    fx.s('push', '-q', 'origin', 'development');
    fx.g('fetch', '-q', 'origin');
    fx.g('merge', '-q', '--no-edit', 'origin/development');
    const t = await analyzeDependentTicket(git, ctx, 'development', fx.g('rev-parse', 'HEAD'));
    expect(t.problems).toEqual([]);
    expect(t.syncMerges).toHaveLength(1);
    expect(t.commits).toHaveLength(1);
  });

  it('merge dari production atau branch lain → masalah', async () => {
    const { fx, git } = setup((f) => {
      f.commit('hotfix prod', { 'p.ts': 'p\n' }, 'seed');
      f.s('push', '-q', 'origin', 'production');
    });
    fx.commit('LOGIS-3945: satu', { 'a.ts': '1\n' });
    fx.g('merge', '-q', '--no-edit', 'origin/production');
    const t = await analyzeDependentTicket(git, ctx, 'development', fx.g('rev-parse', 'HEAD'));
    expect(t.problems.map((p) => p.kind)).toContain('dependent-merge');
    expect(describeProblems(t.problems).join('\n')).toMatch(/selain 'development'/);
  });

  it('subject yang juga menyebut tiket lain → peringatan saja', async () => {
    const { fx, git } = setup();
    fx.commit('LOGIS-3945: lanjutan LOGIS-3931', { 'a.ts': '1\n' });
    const t = await analyzeDependentTicket(git, ctx, 'development', fx.g('rev-parse', 'HEAD'));
    expect(t.problems).toEqual([]);
    expect(t.warnings.join('\n')).toMatch(/LOGIS-3931/);
  });
});

describe('prMergeBranch', () => {
  it.each([
    ['Merge pull request #12 from org/feature/LOGIS-1-x', 'feature/LOGIS-1-x'],
    ['Merge pull request #12 from org/LOGIS-1-dev', 'LOGIS-1-dev'],
    ['Merge branch development into LOGIS-1', null],
    ['LOGIS-1: Merge pull request #12 from org/x', null],
  ])('%s', (subject, branch) => {
    expect(prMergeBranch(subject)).toBe(branch);
  });
});

describe('detectDependencies', () => {
  const detect = async (git: Git, fx: Fixture) => {
    const t = await analyzeDependentTicket(git, ctx, 'development', fx.g('rev-parse', 'HEAD'));
    return detectDependencies(git, scope, t.commits);
  };

  it('dari pesan commit: hanya commit yang menyentuh file yang sama; urut numerik & unik', async () => {
    const { fx, git } = setup((f) => {
      f.s('switch', '-q', 'development');
      f.commit('LOGIS-999: file sama', { 'dev1.ts': 'dev 1 lagi\n' }, 'seed');
      f.commit('fix tkt:LOGIS-3931 msg:file sama', { 'dev1.ts': 'dev 1 lagi lagi\n' }, 'seed');
      f.s('push', '-q', 'origin', 'development');
    });
    fx.commit('LOGIS-3945: ubah dev1', { 'dev1.ts': 'punya tiket\n' });
    // dev2.ts/dev3.ts (LOGIS-372, LOGIS-373) tidak disentuh tiket.
    expect(await detect(git, fx)).toEqual(['LOGIS-371', 'LOGIS-999', 'LOGIS-3931']);
  });

  it('dari nama branch merge PR, walau commit di dalamnya tanpa key', async () => {
    const { fx, git } = setup((f) => mergePr(f, 'feature/LOGIS-3944-abc', { 'shared.ts': 'x\n' }));
    fx.commit('LOGIS-3945: ubah shared', { 'shared.ts': 'y\n' });
    expect(await detect(git, fx)).toEqual(['LOGIS-3944']);
  });

  it('merge PR yang tidak menyentuh file tiket → tidak dihitung', async () => {
    const { fx, git } = setup((f) => mergePr(f, 'feature/LOGIS-3944-abc', { 'lain.ts': 'x\n' }));
    fx.commit('LOGIS-3945: ubah shared', { 'shared.ts': 'y\n' });
    expect(await detect(git, fx)).toEqual([]);
  });

  it('commit di sisi merge tetap terbaca walau hasil merge TREESAME ke parent pertama (--full-history)', async () => {
    const { fx, git } = setup((f) => {
      f.s('switch', '-q', 'development');
      f.commit('LOGIS-3800: dev ubah shared', { 'shared.ts': 'x\n' }, 'seed');
      f.s('switch', '-q', '-c', 'side', 'development~1');
      f.commit('LOGIS-3801: sisi ubah shared', { 'shared.ts': 'x\n' }, 'seed');
      f.s('switch', '-q', 'development');
      f.s('merge', '-q', '--no-edit', 'side');
      f.s('push', '-q', 'origin', 'development');
    });
    fx.commit('LOGIS-3945: ubah shared', { 'shared.ts': 'y\n' });
    expect(await detect(git, fx)).toEqual(['LOGIS-3800', 'LOGIS-3801']);
  });

  it('commit yang sudah ada di production tidak dihitung; key tiket sendiri dibuang', async () => {
    const { fx, git } = setup((f) => {
      f.commit('LOGIS-3700: sudah rilis', { 'shared.ts': 'p\n' }, 'seed');
      f.s('push', '-q', 'origin', 'production');
      f.s('switch', '-q', 'development');
      f.s('merge', '-q', '--no-edit', 'production');
      f.commit('LOGIS-3945: commit sendiri lewat -dev lama', { 'shared.ts': 'q\n' }, 'seed');
      f.s('push', '-q', 'origin', 'development');
    });
    fx.commit('LOGIS-3945: ubah shared', { 'shared.ts': 'r\n' });
    expect(await detect(git, fx)).toEqual([]);
  });

  it('nama file berisi karakter glob dibaca harfiah', async () => {
    const { fx, git } = setup((f) => {
      f.s('switch', '-q', 'development');
      f.commit('LOGIS-3800: huruf a', { 'a.ts': 'x\n' }, 'seed');
      f.commit('LOGIS-3801: literal', { '[ab].ts': 'x\n' }, 'seed');
      f.s('push', '-q', 'origin', 'development');
    });
    fx.commit('LOGIS-3945: ubah literal', { '[ab].ts': 'y\n' });
    expect(await detect(git, fx)).toEqual(['LOGIS-3801']);
  });

  it('tanpa commit tiket → kosong, tanpa memanggil git log', async () => {
    const { git } = setup();
    expect(await detectDependencies(git, scope, [])).toEqual([]);
  });
});

describe('Git: mergeCheckReadOnly', () => {
  it('mendeteksi bersih & konflik tanpa menambah objek di repo', async () => {
    const { fx, git } = setup((f) => {
      f.s('switch', '-q', 'development');
      f.commit('LOGIS-3800: ubah app', { 'app.ts': 'a\nDEV\nc\n' }, 'seed');
      f.s('push', '-q', 'origin', 'development');
    });
    fx.g('switch', '-q', '-c', 'konflik', 'origin/production');
    fx.commit('LOGIS-3945: ubah app', { 'app.ts': 'a\nTIKET\nc\n' });
    fx.g('switch', '-q', '-c', 'bersih', 'origin/production');
    fx.commit('LOGIS-3945: file lain', { 'lain.ts': 'x\n' });
    const objects = fx.g('count-objects', '-v');
    expect(await git.mergeCheckReadOnly('origin/development', 'konflik')).toEqual({ clean: false, conflicts: ['app.ts'] });
    expect(await git.mergeCheckReadOnly('origin/development', 'bersih')).toEqual({ clean: true, conflicts: [] });
    expect(fx.g('count-objects', '-v')).toBe(objects);
  });
});
