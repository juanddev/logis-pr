import { CliError } from '../utils/errors.js';
import { httpRequest, type FetchLike } from '../utils/http.js';

export interface TeamsPayload {
  /** Teks polos (format persis). */
  text: string;
  /** HTML siap tempel ke action "Post message in a chat or channel": triggerBody()?['html']. */
  html: string;
  ticket: string;
  desc: string;
  prUrl: string;
  /** Semua link PR (hotfix bisa 2: production & development). */
  prUrls?: string[];
  ticketUrl: string;
  source: 'logis-pr';
}

/** Validasi bentuk URL webhook Workflows tanpa mengirim apa pun. */
export function validateWebhookUrl(url: string): { ok: boolean; reason?: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: 'bukan URL yang valid' };
  }
  const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  // http hanya diizinkan untuk server mock lokal (pengujian).
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocal)) return { ok: false, reason: 'harus https://' };
  if (/\.webhook\.office\.com$/i.test(u.hostname) || /outlook\.office\.com$/i.test(u.hostname)) {
    return {
      ok: false,
      reason: 'ini URL Incoming Webhook (connector lama), tidak bisa ke group chat — pakai URL trigger Workflows',
    };
  }
  return { ok: true };
}

/**
 * Kirim ke flow Teams Workflows / Power Automate dengan trigger
 * "When a Teams webhook request is received". Flow merespons 202 Accepted bila diterima.
 * URL tidak pernah dicetak di error (berisi tanda tangan `sig`).
 */
export async function sendViaWorkflow(url: string, payload: TeamsPayload, fetchImpl: FetchLike = fetch): Promise<void> {
  const check = validateWebhookUrl(url);
  if (!check.ok) throw new CliError(`teamsWebhookUrl tidak valid: ${check.reason}.`, { hint: 'Jalankan: logis-pr init' });

  const res = await httpRequest(
    url,
    {
      service: 'Teams Workflows',
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: 30_000,
    },
    fetchImpl,
  );
  if (res.ok) return;

  const flowError = (res.data as { error?: { code?: string; message?: string } } | undefined)?.error;
  const code = flowError?.code ? ` (${flowError.code})` : '';
  switch (res.status) {
    case 400:
      throw new CliError(`Flow Teams menolak payload (400)${code}.`, {
        hint: 'Cek "Request Body JSON Schema" di trigger flow; kosongkan atau samakan dengan payload logis-pr.',
      });
    case 401:
    case 403:
      throw new CliError(`Flow Teams menolak request (${res.status})${code}.`, {
        hint: 'Di trigger flow, set "Who can trigger the flow?" = Anyone, atau URL sudah di-regenerate.',
      });
    case 404:
      throw new CliError(`URL flow Teams tidak ditemukan (404)${code}.`, {
        hint: 'Flow dihapus/dinonaktifkan atau URL berubah. Salin ulang HTTP URL dari trigger lalu: logis-pr init',
      });
    case 429:
      throw new CliError('Flow Teams kena throttling (429). Coba lagi sebentar lagi.');
    default:
      throw new CliError(`Flow Teams mengembalikan HTTP ${res.status}${code}.`, {
        hint: 'Buka riwayat run flow di Power Automate untuk melihat detail error.',
      });
  }
}
