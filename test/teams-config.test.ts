import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configPath, DEFAULT_CONFIG, loadConfig, missingFields, parseReviewers, saveConfig, splitList } from '../src/config/index.js';
import { getGraphToken, sendViaGraph } from '../src/teams/graph.js';
import { buildPayload } from '../src/teams/index.js';
import { sendViaWorkflow, validateWebhookUrl } from '../src/teams/workflow.js';
import { buildTeamsMessage } from '../src/message/index.js';
import { maskSecret, redactUrl, scrub } from '../src/utils/secret.js';
import { getSymbols, isUnicodeSupported } from '../src/utils/term.js';
import { fakeFetch } from './helpers.js';

const WEBHOOK = 'https://prod-01.southeastasia.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=SECRETSIG123';

const message = buildTeamsMessage({
  ticketKey: 'LOGIS-3938',
  desc: 'Desc <b> & in [ServiceOrder]',
  prUrl: 'https://github.com/o/SELOG_LOGIS_ServiceOrder/pull/1',
  ticketUrl: 'https://serasiautoraya.atlassian.net/browse/LOGIS-3938',
});
const payload = buildPayload(message, {
  ticket: 'LOGIS-3938',
  desc: 'Desc <b> & in [ServiceOrder]',
  prUrl: 'https://github.com/o/SELOG_LOGIS_ServiceOrder/pull/1',
  ticketUrl: 'https://serasiautoraya.atlassian.net/browse/LOGIS-3938',
});

describe('Teams Workflows (HTTP di-mock)', () => {
  it('POST JSON berisi text & html', async () => {
    const { fetchImpl, requests } = fakeFetch([{ method: 'POST', match: (u) => u === WEBHOOK, status: 202, body: '' }]);
    await sendViaWorkflow(WEBHOOK, payload, fetchImpl);
    const sent = JSON.parse(requests[0]?.body ?? '{}');
    expect(sent.text).toBe(message.text);
    expect(sent.html).toBe(message.html);
    expect(sent.html).toContain('Desc &lt;b&gt; &amp; in [ServiceOrder]');
    expect(requests[0]?.headers['Content-Type']).toMatch(/application\/json/);
  });

  it('404 → CliError tanpa membocorkan URL/sig', async () => {
    const { fetchImpl } = fakeFetch([{ method: 'POST', match: () => true, status: 404, body: { error: { code: 'WorkflowNotFound' } } }]);
    const err = await sendViaWorkflow(WEBHOOK, payload, fetchImpl).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/404/);
    expect(err?.message).not.toContain('SECRETSIG');
  });

  it('validateWebhookUrl menolak Incoming Webhook lama & non-https', () => {
    expect(validateWebhookUrl(WEBHOOK).ok).toBe(true);
    expect(validateWebhookUrl('https://serasi.webhook.office.com/webhookb2/xyz').ok).toBe(false);
    expect(validateWebhookUrl('http://example.com').ok).toBe(false);
    expect(validateWebhookUrl('bukan url').ok).toBe(false);
  });
});

describe('Microsoft Graph fallback (HTTP di-mock)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'logis-pr-graph-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('memakai token cache yang masih valid tanpa request', async () => {
    const cachePath = path.join(dir, 'token.json');
    await writeFile(
      cachePath,
      JSON.stringify({ tenantId: 't', clientId: 'c', accessToken: 'AT', refreshToken: 'RT', expiresAt: 10_000_000 }),
    );
    const { fetchImpl, requests } = fakeFetch([]);
    const token = await getGraphToken({ tenantId: 't', clientId: 'c', cachePath }, { interactive: false }, { fetchImpl, now: () => 1000 });
    expect(token).toBe('AT');
    expect(requests).toHaveLength(0);
  });

  it('refresh token saat access token kedaluwarsa', async () => {
    const cachePath = path.join(dir, 'token.json');
    await writeFile(cachePath, JSON.stringify({ tenantId: 't', clientId: 'c', accessToken: 'OLD', refreshToken: 'RT', expiresAt: 0 }));
    const { fetchImpl, requests } = fakeFetch([
      { method: 'POST', match: (u) => u.endsWith('/t/oauth2/v2.0/token'), body: { access_token: 'NEW', expires_in: 3600 } },
    ]);
    const token = await getGraphToken({ tenantId: 't', clientId: 'c', cachePath }, { interactive: false }, { fetchImpl, now: () => 5000 });
    expect(token).toBe('NEW');
    expect(requests[0]?.body).toContain('grant_type=refresh_token');
    const saved = JSON.parse(await readFile(cachePath, 'utf8'));
    expect(saved.refreshToken).toBe('RT');
  });

  it('device code flow: pending lalu sukses', async () => {
    const cachePath = path.join(dir, 'token.json');
    let polls = 0;
    const { fetchImpl } = fakeFetch([
      {
        method: 'POST',
        match: (u) => u.endsWith('/devicecode'),
        body: { device_code: 'DC', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1 },
      },
      {
        method: 'POST',
        match: (u) => u.endsWith('/token') && polls++ === 0,
        status: 400,
        body: { error: 'authorization_pending' },
      },
      { method: 'POST', match: (u) => u.endsWith('/token'), body: { access_token: 'DEV', refresh_token: 'R', expires_in: 3600 } },
    ]);
    const codes: string[] = [];
    const token = await getGraphToken(
      { tenantId: 't', clientId: 'c', cachePath },
      { interactive: true },
      { fetchImpl, sleep: async () => undefined, onDeviceCode: (i) => codes.push(i.userCode) },
    );
    expect(token).toBe('DEV');
    expect(codes).toEqual(['ABCD-EFGH']);
  });

  it('non-interaktif tanpa cache → error dengan saran graph-login', async () => {
    await expect(
      getGraphToken({ tenantId: 't', clientId: 'c', cachePath: path.join(dir, 'none.json') }, { interactive: false }),
    ).rejects.toThrow(/Belum login/);
  });

  it('sendViaGraph mengirim body html ke /chats/{id}/messages', async () => {
    const { fetchImpl, requests } = fakeFetch([
      { method: 'POST', match: (u) => u === 'https://graph.microsoft.com/v1.0/chats/19%3Aabc%40thread.v2/messages', status: 201, body: {} },
    ]);
    await sendViaGraph('AT', '19:abc@thread.v2', message.html, fetchImpl);
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({ body: { contentType: 'html', content: message.html } });
    expect(requests[0]?.headers.Authorization).toBe('Bearer AT');
  });
});

describe('config', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'logis-pr-cfg-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('path default memakai os.homedir (lintas platform)', () => {
    expect(configPath({ env: {}, homeDir: dir })).toBe(path.join(dir, '.logis-pr.json'));
  });

  it('file dengan BOM (Notepad Windows) tetap terbaca; env meng-override file', async () => {
    await writeFile(
      path.join(dir, '.logis-pr.json'),
      `\uFEFF${JSON.stringify({ jiraEmail: 'file@x.com', baseBranch: 'staging', jiraBaseUrl: 'https://x.atlassian.net/' })}`,
    );
    const loaded = await loadConfig({ homeDir: dir, env: { LOGIS_PR_JIRA_EMAIL: 'env@x.com' } });
    expect(loaded.fileExists).toBe(true);
    expect(loaded.config.jiraEmail).toBe('env@x.com');
    expect(loaded.sources.jiraEmail).toBe('env');
    expect(loaded.config.baseBranch).toBe('staging');
    expect(loaded.config.jiraBaseUrl).toBe('https://x.atlassian.net');
    expect(loaded.config.jiraReviewStatus).toBe('Code Review');
  });

  it('JSON rusak → CliError jelas', async () => {
    await writeFile(path.join(dir, '.logis-pr.json'), '{ rusak');
    await expect(loadConfig({ homeDir: dir, env: {} })).rejects.toThrow(/bukan JSON yang valid/);
  });

  it('saveConfig → loadConfig round-trip', async () => {
    const file = path.join(dir, '.logis-pr.json');
    await saveConfig({ ...DEFAULT_CONFIG, jiraEmail: 'a@b.c', jiraApiToken: 'tok' }, file);
    const loaded = await loadConfig({ homeDir: dir, env: {} });
    expect(loaded.config.jiraApiToken).toBe('tok');
  });

  it('missingFields menyesuaikan --no-jira / --no-teams / mode graph', () => {
    expect(missingFields(DEFAULT_CONFIG, { jira: true, teams: true })).toEqual(['jiraEmail', 'jiraApiToken', 'teamsWebhookUrl']);
    expect(missingFields(DEFAULT_CONFIG, { jira: false, teams: false })).toEqual([]);
    expect(missingFields({ ...DEFAULT_CONFIG, teamsMode: 'graph' }, { jira: false, teams: true })).toEqual([
      'graphTenantId',
      'graphClientId',
      'graphChatId',
    ]);
  });
});

describe('config: reviewer & jalur status', () => {
  it('default: reviewer firdausnp, jalur Ready For Development → In Progress', () => {
    expect(parseReviewers(DEFAULT_CONFIG.prReviewers)).toEqual(['firdausnp']);
    expect(splitList(DEFAULT_CONFIG.jiraTransitionPath)).toEqual(['Ready For Development', 'In Progress']);
  });
  it('parseReviewers: koma/spasi, @, duplikat, none', () => {
    expect(parseReviewers('@firdausnp, other  firdausnp')).toEqual(['firdausnp', 'other']);
    expect(parseReviewers('none')).toEqual([]);
    expect(parseReviewers(' - ')).toEqual([]);
    expect(parseReviewers('bad user!, ok-user')).toEqual(['bad', 'ok-user']);
  });
  it('env LOGIS_PR_REVIEWERS meng-override default', async () => {
    const loaded = await loadConfig({ homeDir: os.tmpdir(), env: { LOGIS_PR_CONFIG: '/tidak/ada.json', LOGIS_PR_REVIEWERS: 'a,b' } });
    expect(loaded.config.prReviewers).toBe('a,b');
  });
});

describe('secret & terminal', () => {
  it('maskSecret / redactUrl / scrub tidak menampilkan secret', () => {
    expect(maskSecret('ATATT3xFfGF0abcdef')).toBe('ATAT…(18 karakter)');
    expect(redactUrl(WEBHOOK)).not.toContain('SECRETSIG');
    expect(redactUrl(WEBHOOK)).toMatch(/\?\*\*\*$/);
    expect(scrub('token=abcdef123 ok', ['abcdef123'])).toBe('token=*** ok');
  });

  it('deteksi Unicode: Windows Terminal ya, conhost lama tidak, override env', () => {
    expect(isUnicodeSupported({ WT_SESSION: '1' }, 'win32')).toBe(true);
    expect(isUnicodeSupported({}, 'win32')).toBe(false);
    expect(isUnicodeSupported({}, 'darwin')).toBe(true);
    expect(isUnicodeSupported({ LOGIS_PR_ASCII: '1' }, 'darwin')).toBe(false);
    expect(isUnicodeSupported({ LOGIS_PR_ASCII: '0' }, 'win32')).toBe(true);
    expect(getSymbols({}, 'win32').ok).toBe('[OK]');
    expect(getSymbols({ WT_SESSION: '1' }, 'win32').ok).toBe('✔');
  });
});

describe('notified store (anti kirim ganda)', () => {
  it('mencatat & membaca PR yang sudah diumumkan', async () => {
    const { createNotifiedStore } = await import('../src/config/state.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'logis-pr-state-'));
    try {
      const store = createNotifiedStore(path.join(dir, 'state.json'), () => new Date('2026-10-31T15:40:00Z'));
      expect(await store.sentAt('https://github.com/o/r/pull/1')).toBeNull();
      await store.markSent('https://github.com/o/r/pull/1');
      expect(await store.sentAt('https://github.com/o/r/pull/1')).not.toBeNull();
      expect(await store.sentAt('https://github.com/o/r/pull/2')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
