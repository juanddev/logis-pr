import { CliError, errorMessage } from './errors.js';

export type FetchLike = typeof fetch;

export interface HttpResponse<T = unknown> {
  status: number;
  ok: boolean;
  /** Body ter-parse sebagai JSON bila memungkinkan. */
  data: T | undefined;
  text: string;
}

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Nama layanan untuk pesan error, mis. "Jira". */
  service: string;
}

/**
 * Wrapper tipis di atas `fetch` bawaan Node: timeout, parsing JSON, dan pesan error jaringan
 * yang jelas. URL tidak pernah dimasukkan ke pesan error (bisa berisi secret).
 */
export async function httpRequest<T = unknown>(
  url: string,
  req: HttpRequest,
  fetchImpl: FetchLike = fetch,
): Promise<HttpResponse<T>> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: req.method ?? 'GET',
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(req.timeoutMs ?? 20_000),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new CliError(`${req.service}: permintaan timeout.`, { hint: 'Periksa koneksi internet / VPN kantor.' });
    }
    const cause = err instanceof Error && err.cause ? errorMessage(err.cause) : errorMessage(err);
    throw new CliError(`${req.service}: tidak bisa terhubung (${cause}).`, {
      hint: 'Periksa koneksi internet, proxy, atau VPN kantor.',
    });
  }

  const text = await res.text();
  let data: T | undefined;
  if (text) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = undefined;
    }
  }
  return { status: res.status, ok: res.ok, data, text };
}
