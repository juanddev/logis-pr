import { CliError } from '../utils/errors.js';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Ambil key tiket dari nama branch, mis. `feature/LOGIS-3938-bulk-last-route` → `LOGIS-3938`.
 * Tidak peka huruf besar/kecil; key harus berdiri sendiri (bukan bagian dari kata lain).
 */
export function extractTicketKey(branch: string, projectKey = 'LOGIS'): string | null {
  const re = new RegExp(`(?:^|[^A-Za-z0-9])(${escapeRegExp(projectKey)}-\\d+)(?![0-9])`, 'i');
  const m = branch.match(re);
  return m?.[1] ? m[1].toUpperCase() : null;
}

/** Validasi & normalkan key yang diberikan lewat -t/--ticket. Menerima "3938" atau "logis-3938". */
export function normalizeTicketKey(input: string, projectKey = 'LOGIS'): string {
  const raw = input.trim();
  if (/^\d+$/.test(raw)) return `${projectKey.toUpperCase()}-${raw}`;
  const re = new RegExp(`^${escapeRegExp(projectKey)}-\\d+$`, 'i');
  if (!re.test(raw)) {
    throw new CliError(`Key tiket '${input}' tidak valid.`, { hint: `Gunakan format ${projectKey}-1234.` });
  }
  return raw.toUpperCase();
}

/** Nama service dari repo: `SELOG_LOGIS_ServiceOrder` → `ServiceOrder`. */
export function serviceFromRepo(repoName: string, prefix = 'SELOG_LOGIS_'): string {
  if (prefix && repoName.toLowerCase().startsWith(prefix.toLowerCase()) && repoName.length > prefix.length) {
    return repoName.slice(prefix.length);
  }
  return repoName;
}

/**
 * Desc = summary Jira. Bila belum diakhiri ` in [<Service>]` (case-insensitive),
 * tambahkan suffix tersebut.
 */
export function buildDesc(summary: string, service: string): string {
  const s = summary.trim();
  const suffix = ` in [${service}]`;
  if (s.toLowerCase().endsWith(suffix.toLowerCase())) return s;
  return `${s}${suffix}`;
}

/**
 * Tambahkan prefix `LOGIS-XXXX: ` ke pesan commit bila belum diawali key tiket
 * (`LOGIS-3938: ...`, `LOGIS-3938 ...`, atau `[LOGIS-3938] ...`).
 */
export function ensureCommitPrefix(message: string, ticketKey: string): string {
  const msg = message.trim();
  if (!msg) throw new CliError('Pesan commit tidak boleh kosong.', { hint: 'Contoh: logis-pr -m "tambah validasi"' });
  const re = new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegExp(ticketKey)}(?![0-9])`, 'i');
  return re.test(msg) ? msg : `${ticketKey}: ${msg}`;
}

/** Hapus prefix key tiket dari awal teks (untuk fallback Desc). */
export function stripTicketPrefix(text: string, ticketKey: string): string {
  const re = new RegExp(`^\\[?${escapeRegExp(ticketKey)}\\]?\\s*:?\\s*`, 'i');
  return text.replace(re, '').trim();
}

export function ticketUrl(jiraBaseUrl: string, ticketKey: string): string {
  return `${jiraBaseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(ticketKey)}`;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Hanya izinkan http(s) di href agar tidak ada `javascript:` dsb. */
export function safeHref(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(`URL tidak valid untuk pesan Teams: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new CliError(`URL dengan protokol ${parsed.protocol} tidak diizinkan di pesan Teams.`);
  }
  return escapeHtml(url);
}

export interface TeamsMessageInput {
  ticketKey: string;
  desc: string;
  prUrl: string;
  ticketUrl: string;
}

export interface TeamsMessage {
  /** Teks polos — format PERSIS yang disepakati tim. */
  text: string;
  /** HTML untuk Teams: <br> sebagai baris baru, link <a href> yang bisa diklik. */
  html: string;
}

export function buildTeamsMessage(input: TeamsMessageInput): TeamsMessage {
  const text = [
    `Task: Review PR ${input.ticketKey}`,
    `Desc: ${input.desc}`,
    '',
    `PR: ${input.prUrl}`,
    `Tiket: ${input.ticketUrl}`,
  ].join('\n');

  const link = (url: string) => `<a href="${safeHref(url)}">${escapeHtml(url)}</a>`;
  const html = [
    `Task: Review PR ${escapeHtml(input.ticketKey)}`,
    `Desc: ${escapeHtml(input.desc)}`,
    '',
    `PR: ${link(input.prUrl)}`,
    `Tiket: ${link(input.ticketUrl)}`,
  ].join('<br>');

  return { text, html };
}

export function buildPrBody(input: { ticketKey: string; ticketUrl: string; summary?: string }): string {
  const parts = [`Tiket: [${input.ticketKey}](${input.ticketUrl})`];
  if (input.summary) parts.push('', input.summary);
  parts.push('', '_Dibuat otomatis oleh logis-pr._');
  return `${parts.join('\n')}\n`;
}
