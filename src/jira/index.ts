import { CliError } from '../utils/errors.js';
import { httpRequest, type FetchLike, type HttpResponse } from '../utils/http.js';
import { scrub } from '../utils/secret.js';

export interface JiraTransition {
  id: string;
  name: string;
  to?: { name?: string; id?: string };
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
}

export interface JiraCredentials {
  baseUrl: string;
  email: string;
  apiToken: string;
}

function norm(s: string | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * Pilih transisi menuju status target (case-insensitive).
 * Prioritas: status TUJUAN (`to.name`) cocok → baru nama transisi cocok.
 */
export function pickTransition(transitions: readonly JiraTransition[], target: string): JiraTransition | undefined {
  const t = norm(target);
  if (!t) return undefined;
  return transitions.find((x) => norm(x.to?.name) === t) ?? transitions.find((x) => norm(x.name) === t);
}

export function isSameStatus(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

export function describeTransitions(transitions: readonly JiraTransition[]): string[] {
  return transitions.map((t) => (t.to?.name && norm(t.to.name) !== norm(t.name) ? `${t.name} → ${t.to.name}` : t.name));
}

export type TransitionOutcome =
  | { kind: 'already'; status: string }
  | { kind: 'moved'; transition: JiraTransition }
  | { kind: 'planned'; transition: JiraTransition }
  | { kind: 'unavailable'; available: string[] };

/** Klien Jira Cloud REST API v3 (Basic auth: email + API token). */
export class JiraClient {
  constructor(
    private readonly creds: JiraCredentials,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private get base(): string {
    return this.creds.baseUrl.replace(/\/+$/, '');
  }

  private headers(json = false): Record<string, string> {
    const token = Buffer.from(`${this.creds.email}:${this.creds.apiToken}`, 'utf8').toString('base64');
    const h: Record<string, string> = {
      Authorization: `Basic ${token}`,
      Accept: 'application/json',
      'User-Agent': 'logis-pr',
    };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  private fail(res: HttpResponse, context: string, ticketKey?: string): never {
    const body = res.data as { errorMessages?: string[]; errors?: Record<string, string> } | undefined;
    const serverMsg = scrub(
      [...(body?.errorMessages ?? []), ...Object.values(body?.errors ?? {})].join('; '),
      [this.creds.apiToken],
    );
    const suffix = serverMsg ? ` — ${serverMsg}` : '';
    switch (res.status) {
      case 401:
        throw new CliError(`Jira menolak kredensial (401) saat ${context}.`, {
          hint:
            'Periksa jiraEmail & jiraApiToken (token bisa kedaluwarsa atau dicabut). Buat token baru di ' +
            'https://id.atlassian.com/manage-profile/security/api-tokens lalu jalankan: logis-pr init',
        });
      case 403:
        throw new CliError(`Akses Jira ditolak (403) saat ${context}${suffix}.`, {
          hint: 'Akun Anda tidak punya izin untuk aksi ini di project Jira tersebut.',
        });
      case 404:
        throw new CliError(
          ticketKey
            ? `Tiket ${ticketKey} tidak ditemukan atau Anda tidak punya akses (404).`
            : `Endpoint Jira tidak ditemukan (404) saat ${context}.`,
          { hint: ticketKey ? 'Cek key tiket (pakai -t untuk override) dan jiraBaseUrl.' : 'Cek jiraBaseUrl.' },
        );
      case 429:
        throw new CliError('Jira membatasi request (429 rate limit). Coba lagi sebentar lagi.');
      default:
        throw new CliError(`Jira mengembalikan HTTP ${res.status} saat ${context}${suffix}.`);
    }
  }

  async myself(): Promise<{ displayName: string; emailAddress?: string }> {
    const res = await httpRequest<{ displayName: string; emailAddress?: string }>(
      `${this.base}/rest/api/3/myself`,
      { service: 'Jira', headers: this.headers() },
      this.fetchImpl,
    );
    if (!res.ok || !res.data) this.fail(res, 'mengecek akun');
    return res.data;
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const res = await httpRequest<{ key: string; fields?: { summary?: string; status?: { name?: string } } }>(
      `${this.base}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status`,
      { service: 'Jira', headers: this.headers() },
      this.fetchImpl,
    );
    if (!res.ok || !res.data) this.fail(res, `membaca tiket ${key}`, key);
    return {
      key: res.data.key ?? key,
      summary: res.data.fields?.summary ?? '',
      status: res.data.fields?.status?.name ?? '',
    };
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    const res = await httpRequest<{ transitions?: JiraTransition[] }>(
      `${this.base}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      { service: 'Jira', headers: this.headers() },
      this.fetchImpl,
    );
    if (!res.ok || !res.data) this.fail(res, `mengambil transisi ${key}`, key);
    return res.data.transitions ?? [];
  }

  async doTransition(key: string, transitionId: string): Promise<void> {
    const res = await httpRequest(
      `${this.base}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      {
        service: 'Jira',
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ transition: { id: transitionId } }),
      },
      this.fetchImpl,
    );
    if (!res.ok) this.fail(res, `memindahkan status ${key}`, key);
  }

  /**
   * Pindahkan tiket ke status target. Idempoten: bila status sekarang sudah target, tidak ada
   * request POST. Bila transisi tidak tersedia, kembalikan daftar transisi (tidak melempar).
   */
  async moveToStatus(
    key: string,
    target: string,
    opts: { currentStatus?: string; dryRun?: boolean } = {},
  ): Promise<TransitionOutcome> {
    const current = opts.currentStatus ?? (await this.getIssue(key)).status;
    if (isSameStatus(current, target)) return { kind: 'already', status: current };
    const transitions = await this.getTransitions(key);
    const chosen = pickTransition(transitions, target);
    if (!chosen) return { kind: 'unavailable', available: describeTransitions(transitions) };
    if (opts.dryRun) return { kind: 'planned', transition: chosen };
    await this.doTransition(key, chosen.id);
    return { kind: 'moved', transition: chosen };
  }
}
