import { describe, expect, it } from 'vitest';
import {
  buildStatusPath,
  chooseNextTransition,
  describeTransitions,
  isSameStatus,
  JiraClient,
  pickTransition,
  type JiraTransition,
} from '../src/jira/index.js';
import { CliError } from '../src/utils/errors.js';
import { fakeFetch, fakeJiraWorkflow } from './helpers.js';

const transitions: JiraTransition[] = [
  { id: '11', name: 'Start Progress', to: { name: 'In Progress' } },
  { id: '21', name: 'Ready for review', to: { name: 'Code Review' } },
  { id: '31', name: 'Done', to: { name: 'Done' } },
];

describe('pickTransition', () => {
  it('memilih berdasarkan status tujuan (to.name), case-insensitive', () => {
    expect(pickTransition(transitions, 'code review')?.id).toBe('21');
    expect(pickTransition(transitions, '  CODE REVIEW ')?.id).toBe('21');
  });

  it('fallback ke nama transisi bila status tujuan tidak cocok', () => {
    const t: JiraTransition[] = [{ id: '5', name: 'Code Review', to: { name: 'Review' } }];
    expect(pickTransition(t, 'code review')?.id).toBe('5');
  });

  it('mengutamakan to.name di atas nama transisi', () => {
    const t: JiraTransition[] = [
      { id: '1', name: 'Code Review', to: { name: 'Something else' } },
      { id: '2', name: 'Send', to: { name: 'Code Review' } },
    ];
    expect(pickTransition(t, 'Code Review')?.id).toBe('2');
  });

  it('undefined bila tidak ada yang cocok atau target kosong', () => {
    expect(pickTransition(transitions, 'QA')).toBeUndefined();
    expect(pickTransition(transitions, '')).toBeUndefined();
    expect(pickTransition([], 'Code Review')).toBeUndefined();
  });

  it('transisi tanpa field to tetap aman', () => {
    expect(pickTransition([{ id: '9', name: 'code review' }], 'Code Review')?.id).toBe('9');
  });
});

describe('helper status', () => {
  it('isSameStatus case-insensitive', () => {
    expect(isSameStatus('Code Review', 'code review ')).toBe(true);
    expect(isSameStatus('In Progress', 'Code Review')).toBe(false);
  });
  it('describeTransitions menampilkan tujuan bila beda nama', () => {
    expect(describeTransitions(transitions)).toEqual([
      'Start Progress → In Progress',
      'Ready for review → Code Review',
      'Done',
    ]);
  });
});

const BASE = 'https://serasiautoraya.atlassian.net';
const creds = { baseUrl: `${BASE}/`, email: 'dev@example.com', apiToken: 'super-secret-token-123' };

describe('JiraClient (HTTP di-mock)', () => {
  it('getIssue: memakai Basic auth & membaca summary/status', async () => {
    const { fetchImpl, requests } = fakeFetch([
      {
        match: (u) => u.startsWith(`${BASE}/rest/api/3/issue/LOGIS-3938?`),
        body: { key: 'LOGIS-3938', fields: { summary: 'Hello', status: { name: 'In Progress' } } },
      },
    ]);
    const issue = await new JiraClient(creds, fetchImpl).getIssue('LOGIS-3938');
    expect(issue).toEqual({ key: 'LOGIS-3938', summary: 'Hello', status: 'In Progress' });
    const expected = `Basic ${Buffer.from('dev@example.com:super-secret-token-123').toString('base64')}`;
    expect(requests[0]?.headers.Authorization).toBe(expected);
    expect(requests[0]?.url).toBe(`${BASE}/rest/api/3/issue/LOGIS-3938?fields=summary,status`);
  });

  it('401 → CliError berbahasa Indonesia tanpa membocorkan token', async () => {
    const { fetchImpl } = fakeFetch([{ match: () => true, status: 401, body: { errorMessages: ['bad super-secret-token-123'] } }]);
    const err = await new JiraClient(creds, fetchImpl).getIssue('LOGIS-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/401/);
    expect((err as CliError).hint).toMatch(/api-tokens/);
    expect(JSON.stringify({ m: (err as CliError).message, h: (err as CliError).hint })).not.toContain('super-secret');
  });

  it('404 → pesan tiket tidak ditemukan', async () => {
    const { fetchImpl } = fakeFetch([{ match: () => true, status: 404, body: { errorMessages: ['Issue does not exist'] } }]);
    await expect(new JiraClient(creds, fetchImpl).getIssue('LOGIS-9')).rejects.toThrow(/LOGIS-9 tidak ditemukan/);
  });

  it('moveToStatus: sudah di Code Review → tidak ada request transisi', async () => {
    const { fetchImpl, requests } = fakeFetch([]);
    const out = await new JiraClient(creds, fetchImpl).moveToStatus('LOGIS-1', 'Code Review', { currentStatus: 'code review' });
    expect(out).toEqual({ kind: 'already', status: 'code review' });
    expect(requests).toHaveLength(0);
  });

  it('moveToStatus: GET transitions → POST id yang cocok → baca ulang status', async () => {
    const { fetchImpl, requests, state } = fakeJiraWorkflow('In Progress');
    const out = await new JiraClient(creds, fetchImpl).moveToStatus('LOGIS-1', 'Code Review', { currentStatus: 'In Progress' });
    expect(out.kind).toBe('moved');
    expect(state.history).toEqual(['In Progress → Code Review']);
    const post = requests.find((r) => r.method === 'POST');
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ transition: { id: '100' } });
  });

  it('moveToStatus: dry-run tidak POST', async () => {
    const { fetchImpl, requests } = fakeFetch([{ match: (u) => u.endsWith('/transitions'), body: { transitions } }]);
    const out = await new JiraClient(creds, fetchImpl).moveToStatus('LOGIS-1', 'Code Review', {
      currentStatus: 'In Progress',
      dryRun: true,
    });
    expect(out.kind).toBe('planned');
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('moveToStatus: transisi tidak tersedia → daftar transisi, tanpa throw', async () => {
    const { fetchImpl } = fakeFetch([
      { match: (u) => u.endsWith('/transitions'), body: { transitions: [{ id: '31', name: 'Done', to: { name: 'Done' } }] } },
    ]);
    const out = await new JiraClient(creds, fetchImpl).moveToStatus('LOGIS-1', 'Code Review', { currentStatus: 'To Do' });
    expect(out).toEqual({ kind: 'unavailable', status: 'To Do', available: ['Done'], steps: [] });
  });

  it('moveToStatus: tanpa currentStatus membaca issue dulu', async () => {
    const { fetchImpl, requests } = fakeFetch([
      { match: (u) => u.includes('/issue/LOGIS-1?'), body: { key: 'LOGIS-1', fields: { summary: 's', status: { name: 'Code Review' } } } },
    ]);
    const out = await new JiraClient(creds, fetchImpl).moveToStatus('LOGIS-1', 'Code Review');
    expect(out.kind).toBe('already');
    expect(requests).toHaveLength(1);
  });
});

describe('transisi bertahap (workflow LOGIS)', () => {
  const VIA = ['Ready For Development', 'In Progress'];
  const move = (initial: string, extra: { failPostTo?: string; dryRun?: boolean; via?: string[] } = {}) => {
    const fake = fakeJiraWorkflow(initial, { failPostTo: extra.failPostTo });
    const client = new JiraClient(creds, fake.fetchImpl);
    return { fake, run: () => client.moveToStatus('LOGIS-1', 'Code Review', { via: extra.via ?? VIA, dryRun: extra.dryRun }) };
  };

  it('buildStatusPath: target selalu terakhir, tanpa duplikat', () => {
    expect(buildStatusPath([' Ready For Development ', 'in progress', 'In Progress', '', 'code review'], 'Code Review')).toEqual([
      'Ready For Development',
      'in progress',
      'Code Review',
    ]);
  });

  it('chooseNextTransition: pilih status terjauh yang tersedia, tidak pernah mundur', () => {
    const path = ['Ready For Development', 'In Progress', 'Code Review'];
    const t = (to: string): JiraTransition => ({ id: to, name: `Go ${to}`, to: { name: to } });
    expect(chooseNextTransition([t('Ready For Development'), t('In Progress')], path, 'To Do')?.to).toBe('In Progress');
    expect(chooseNextTransition([t('Ready For Development')], path, 'In Progress')).toBeUndefined();
    expect(chooseNextTransition([t('Done'), t('Invalid')], path, 'To Do')).toBeUndefined();
  });

  it.each([
    ['To Do', ['To Do → In Progress', 'In Progress → Code Review']],
    ['Need Bussiness Requirement', ['Need Bussiness Requirement → Ready For Development', 'Ready For Development → In Progress', 'In Progress → Code Review']],
    ['Ready For Development', ['Ready For Development → In Progress', 'In Progress → Code Review']],
    ['Hold', ['Hold → Ready For Development', 'Ready For Development → In Progress', 'In Progress → Code Review']],
    ['In Progress', ['In Progress → Code Review']],
    ['In Fixing', ['In Fixing → Code Review']],
  ])('dari %s sampai Code Review', async (initial, history) => {
    const { fake, run } = move(initial);
    const out = await run();
    expect(out.kind).toBe('moved');
    expect(fake.state.history).toEqual(history);
    expect(fake.state.status).toBe('Code Review');
  });

  it('sudah di Code Review → tidak ada POST', async () => {
    const { fake, run } = move('Code Review');
    expect((await run()).kind).toBe('already');
    expect(fake.state.posts).toBe(0);
  });

  it('Defect Bugs (tidak ada jalur) → berhenti dengan daftar transisi, tidak ke Done/Invalid', async () => {
    const { fake, run } = move('Defect Bugs');
    const out = await run();
    expect(out.kind).toBe('unavailable');
    if (out.kind === 'unavailable') expect(out.available).toContain('Go In Fixing → In Fixing');
    expect(fake.state.posts).toBe(0);
  });

  it('Defect Bugs + In Fixing di jalur → Defect Bugs → In Fixing → Code Review', async () => {
    const { fake, run } = move('Defect Bugs', { via: [...VIA, 'In Fixing'] });
    expect((await run()).kind).toBe('moved');
    expect(fake.state.history).toEqual(['Defect Bugs → In Fixing', 'In Fixing → Code Review']);
  });

  it('In Testing (tidak ada transisi maju) → unavailable', async () => {
    const { fake, run } = move('In Testing');
    expect((await run()).kind).toBe('unavailable');
    expect(fake.state.posts).toBe(0);
  });

  it('dry-run: hanya langkah pertama direncanakan, tanpa POST', async () => {
    const { fake, run } = move('To Do', { dryRun: true });
    const out = await run();
    expect(out).toMatchObject({ kind: 'planned', next: ['Code Review'] });
    if (out.kind === 'planned') expect(out.steps[0]).toMatchObject({ from: 'To Do', to: 'In Progress' });
    expect(fake.state.posts).toBe(0);
  });

  it('langkah tengah gagal (field wajib) → error dilempar setelah langkah pertama', async () => {
    const { fake, run } = move('To Do', { failPostTo: 'Code Review' });
    await expect(run()).rejects.toThrow(/HTTP 400.*berhenti di status 'In Progress'/s);
    expect(fake.state.status).toBe('In Progress');
  });
});
