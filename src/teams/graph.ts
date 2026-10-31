import { chmod, readFile, writeFile } from 'node:fs/promises';
import { CliError } from '../utils/errors.js';
import { httpRequest, type FetchLike, type HttpResponse } from '../utils/http.js';

/** Izin delegated minimum: kirim pesan ke chat & membaca daftar chat (untuk mencari chat id). */
export const GRAPH_SCOPES = 'https://graph.microsoft.com/ChatMessage.Send https://graph.microsoft.com/Chat.ReadBasic offline_access';
const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface GraphSettings {
  tenantId: string;
  clientId: string;
  cachePath: string;
}

interface TokenCache {
  tenantId: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
  message?: string;
}

export interface GraphDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Dipanggil saat pengguna harus membuka URL & memasukkan kode. */
  onDeviceCode?: (info: { verificationUri: string; userCode: string; message?: string }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function form(body: Record<string, string>): string {
  return new URLSearchParams(body).toString();
}

function authority(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0`;
}

async function readCache(settings: GraphSettings): Promise<TokenCache | null> {
  try {
    const raw = JSON.parse((await readFile(settings.cachePath, 'utf8')).replace(/^\uFEFF/, '')) as TokenCache;
    if (raw.tenantId !== settings.tenantId || raw.clientId !== settings.clientId) return null;
    return raw;
  } catch {
    return null;
  }
}

async function writeCache(settings: GraphSettings, cache: TokenCache): Promise<void> {
  await writeFile(settings.cachePath, JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 });
  await chmod(settings.cachePath, 0o600).catch(() => undefined);
}

function toCache(settings: GraphSettings, t: TokenResponse, now: number, prevRefresh?: string): TokenCache {
  return {
    tenantId: settings.tenantId,
    clientId: settings.clientId,
    accessToken: t.access_token ?? '',
    refreshToken: t.refresh_token ?? prevRefresh,
    expiresAt: now + (t.expires_in ?? 3600) * 1000,
  };
}

async function refresh(settings: GraphSettings, refreshToken: string, deps: GraphDeps): Promise<TokenCache | null> {
  const res = await httpRequest<TokenResponse>(
    `${authority(settings.tenantId)}/token`,
    {
      service: 'Microsoft login',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        client_id: settings.clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: GRAPH_SCOPES,
      }),
    },
    deps.fetchImpl,
  );
  if (!res.ok || !res.data?.access_token) return null;
  const cache = toCache(settings, res.data, (deps.now ?? Date.now)(), refreshToken);
  await writeCache(settings, cache);
  return cache;
}

/** Login interaktif via device code flow (tidak butuh browser di mesin ini). */
export async function deviceCodeLogin(settings: GraphSettings, deps: GraphDeps = {}): Promise<TokenCache> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const start = await httpRequest<DeviceCodeResponse & TokenResponse>(
    `${authority(settings.tenantId)}/devicecode`,
    {
      service: 'Microsoft login',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: settings.clientId, scope: GRAPH_SCOPES }),
    },
    deps.fetchImpl,
  );
  if (!start.ok || !start.data?.device_code) {
    throw new CliError(`Gagal memulai login Microsoft: ${start.data?.error_description ?? `HTTP ${start.status}`}`, {
      hint: 'Cek graphTenantId/graphClientId dan pastikan "Allow public client flows" = Yes di App registration.',
    });
  }
  const dc = start.data;
  deps.onDeviceCode?.({ verificationUri: dc.verification_uri, userCode: dc.user_code, message: dc.message });

  let interval = Math.max(dc.interval ?? 5, 1) * 1000;
  const deadline = now() + dc.expires_in * 1000;
  while (now() < deadline) {
    await sleep(interval);
    const res = await httpRequest<TokenResponse>(
      `${authority(settings.tenantId)}/token`,
      {
        service: 'Microsoft login',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({
          client_id: settings.clientId,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: dc.device_code,
        }),
      },
      deps.fetchImpl,
    );
    if (res.ok && res.data?.access_token) {
      const cache = toCache(settings, res.data, now());
      await writeCache(settings, cache);
      return cache;
    }
    const err = res.data?.error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (err === 'expired_token') break;
    throw new CliError(`Login Microsoft gagal: ${res.data?.error_description ?? err ?? `HTTP ${res.status}`}`, {
      hint:
        err === 'invalid_grant' || /consent/i.test(res.data?.error_description ?? '')
          ? 'Tenant mungkin mewajibkan admin consent untuk ChatMessage.Send/Chat.ReadBasic. Minta admin IT memberi consent.'
          : undefined,
    });
  }
  throw new CliError('Kode login Microsoft kedaluwarsa sebelum diselesaikan.', { hint: 'Jalankan ulang: logis-pr graph-login' });
}

/**
 * Ambil access token Graph: cache yang masih valid → refresh token → (bila `interactive`)
 * device code flow. Token disimpan di file cache dengan mode 600.
 */
export async function getGraphToken(
  settings: GraphSettings,
  opts: { interactive: boolean },
  deps: GraphDeps = {},
): Promise<string> {
  const now = (deps.now ?? Date.now)();
  const cached = await readCache(settings);
  if (cached?.accessToken && cached.expiresAt - 120_000 > now) return cached.accessToken;
  if (cached?.refreshToken) {
    const refreshed = await refresh(settings, cached.refreshToken, deps);
    if (refreshed) return refreshed.accessToken;
  }
  if (!opts.interactive) {
    throw new CliError('Belum login ke Microsoft Graph (atau sesi kedaluwarsa).', { hint: 'Jalankan: logis-pr graph-login' });
  }
  return (await deviceCodeLogin(settings, deps)).accessToken;
}

function graphFail(status: number, body: unknown, context: string): never {
  const msg = (body as { error?: { message?: string } } | undefined)?.error?.message;
  const hint =
    status === 401
      ? 'Token kedaluwarsa/ditolak. Jalankan: logis-pr graph-login'
      : status === 403
        ? 'Izin kurang (ChatMessage.Send) atau Anda bukan anggota chat tersebut.'
        : status === 404
          ? 'graphChatId salah. Cari dengan: logis-pr graph-chats -n "Oknum LOGis"'
          : undefined;
  throw new CliError(`Microsoft Graph HTTP ${status} saat ${context}${msg ? ` — ${msg}` : ''}.`, { hint });
}

export async function sendViaGraph(token: string, chatId: string, html: string, fetchImpl: FetchLike = fetch): Promise<void> {
  const res = await httpRequest(
    `${GRAPH}/chats/${encodeURIComponent(chatId)}/messages`,
    {
      service: 'Microsoft Graph',
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: { contentType: 'html', content: html } }),
    },
    fetchImpl,
  );
  if (!res.ok) graphFail(res.status, res.data, 'mengirim pesan ke chat');
}

export interface GraphChat {
  id: string;
  topic: string | null;
  chatType: string;
}

/** Daftar group chat milik pengguna (mengikuti paging @odata.nextLink). */
export async function listGroupChats(token: string, fetchImpl: FetchLike = fetch, maxPages = 10): Promise<GraphChat[]> {
  type Page = { value?: GraphChat[]; '@odata.nextLink'?: string };
  const out: GraphChat[] = [];
  let url: string | undefined = `${GRAPH}/me/chats?$top=50&$select=id,topic,chatType`;
  for (let page = 0; url && page < maxPages; page++) {
    const res: HttpResponse<Page> = await httpRequest<Page>(
      url,
      { service: 'Microsoft Graph', headers: { Authorization: `Bearer ${token}` } },
      fetchImpl,
    );
    if (!res.ok) graphFail(res.status, res.data, 'membaca daftar chat');
    out.push(...(res.data?.value ?? []).filter((c) => c.chatType === 'group'));
    url = res.data?.['@odata.nextLink'];
  }
  return out;
}

export async function getChat(token: string, chatId: string, fetchImpl: FetchLike = fetch): Promise<GraphChat> {
  const res = await httpRequest<GraphChat>(
    `${GRAPH}/chats/${encodeURIComponent(chatId)}?$select=id,topic,chatType`,
    { service: 'Microsoft Graph', headers: { Authorization: `Bearer ${token}` } },
    fetchImpl,
  );
  if (!res.ok || !res.data) graphFail(res.status, res.data, 'membaca chat');
  return res.data;
}
