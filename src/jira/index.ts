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

/** Satu langkah perpindahan status yang sudah/akan dijalankan. */
export interface TransitionStep {
  from: string;
  to: string;
  transition: JiraTransition;
}

export type TransitionOutcome =
  /** Sudah di status target sejak awal — tidak ada transisi. */
  | { kind: 'already'; status: string }
  /** Berhasil sampai target lewat satu atau beberapa langkah. */
  | { kind: 'moved'; steps: TransitionStep[] }
  /** Dry-run: langkah pertama yang akan dijalankan + status berikutnya yang akan dicoba. */
  | { kind: 'planned'; steps: TransitionStep[]; next: string[] }
  /** Berhenti sebelum target: tidak ada transisi ke status di jalur. `steps` = langkah yang sempat dijalankan. */
  | { kind: 'unavailable'; status: string; available: string[]; steps: TransitionStep[] };

/**
 * Susun jalur status: status perantara (urut sesuai workflow) lalu target di akhir.
 * Duplikat & kosong dibuang; target selalu terakhir.
 */
export function buildStatusPath(via: readonly string[], target: string): string[] {
  const out: string[] = [];
  for (const s of [...via, target]) {
    const v = s.trim();
    if (v && !out.some((x) => norm(x) === norm(v)) && norm(v) !== norm(target)) out.push(v);
  }
  out.push(target.trim());
  return out;
}

/**
 * Pilih transisi berikutnya di sepanjang jalur: coba status TERJAUH dulu (target), mundur ke
 * status perantara. Hanya status yang posisinya SETELAH status sekarang di jalur yang boleh dipilih,
 * sehingga tiket tidak pernah dimundurkan. Status di luar jalur (Done, Invalid, dll.) tidak pernah dipilih.
 */
export function chooseNextTransition(
  transitions: readonly JiraTransition[],
  path: readonly string[],
  currentStatus: string,
): { transition: JiraTransition; to: string } | undefined {
  const idx = path.findIndex((p) => norm(p) === norm(currentStatus));
  for (let i = path.length - 1; i > idx; i--) {
    const status = path[i];
    if (!status) continue;
    const t = pickTransition(transitions, status);
    if (t) return { transition: t, to: t.to?.name ?? status };
  }
  return undefined;
}

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
   * Pindahkan tiket ke status target, BERTAHAP mengikuti `via` bila target tidak bisa dicapai langsung
   * (mis. To Do → In Progress → Code Review). Idempoten: sudah di target → tidak ada POST.
   * Setiap langkah membaca ulang status asli dari Jira. Tidak pernah melempar karena transisi tidak
   * tersedia — kembalikan `unavailable` beserta daftar transisi yang ada.
   */
  async moveToStatus(
    key: string,
    target: string,
    opts: { currentStatus?: string; dryRun?: boolean; via?: readonly string[] } = {},
  ): Promise<TransitionOutcome> {
    const path = buildStatusPath(opts.via ?? [], target);
    let current = opts.currentStatus ?? (await this.getIssue(key)).status;
    if (isSameStatus(current, target)) return { kind: 'already', status: current };

    const steps: TransitionStep[] = [];
    const seen = new Set([norm(current)]);
    for (let n = 0; n <= path.length; n++) {
      const transitions = await this.getTransitions(key);
      const next = chooseNextTransition(transitions, path, current);
      if (!next || seen.has(norm(next.to))) {
        return { kind: 'unavailable', status: current, available: describeTransitions(transitions), steps };
      }
      const step = { from: current, to: next.to, transition: next.transition };
      if (opts.dryRun) {
        const at = path.findIndex((p) => norm(p) === norm(next.to));
        return { kind: 'planned', steps: [step], next: at >= 0 ? path.slice(at + 1) : [target] };
      }
      try {
        await this.doTransition(key, next.transition.id);
      } catch (err) {
        if (steps.length === 0 || !(err instanceof CliError)) throw err;
        const done = steps.map((st) => `${st.from} → ${st.to}`).join(', ');
        throw new CliError(`${err.message} Tiket sudah dipindah (${done}) dan berhenti di status '${current}'.`, {
          hint: err.hint ?? 'Transisi ini mungkin mewajibkan field tertentu; lanjutkan manual di Jira.',
        });
      }
      steps.push(step);
      current = (await this.getIssue(key)).status || next.to;
      if (isSameStatus(current, target)) return { kind: 'moved', steps };
      seen.add(norm(current));
    }
    return { kind: 'unavailable', status: current, available: [], steps };
  }
}
