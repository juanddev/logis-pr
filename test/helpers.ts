import { vi } from 'vitest';
import type { ExecOptions, ExecResult, Runner } from '../src/utils/exec.js';
import type { FetchLike } from '../src/utils/http.js';

export interface RecordedCall {
  command: string;
  args: string[];
  options?: ExecOptions;
}

/** Runner palsu: handler menerima perintah & argumen, mengembalikan hasil. Semua panggilan direkam. */
export function fakeRunner(handler: (command: string, args: string[], options?: ExecOptions) => Partial<ExecResult>) {
  const calls: RecordedCall[] = [];
  const runner: Runner = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const r = handler(command, [...args], options);
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { runner, calls };
}

export interface FakeRoute {
  method?: string;
  match: (url: string) => boolean;
  status?: number;
  body?: unknown;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** fetch palsu berbasis tabel rute. Tidak ada HTTP sungguhan. */
export function fakeFetch(routes: FakeRoute[]) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    requests.push({
      url,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const route = routes.find((r) => (r.method ?? 'GET').toUpperCase() === method && r.match(url));
    if (!route) return new Response(JSON.stringify({ error: 'no route' }), { status: 599 });
    const status = route.status ?? 200;
    const body =
      route.body === undefined || status === 204 ? null : typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as FetchLike;
  return { fetchImpl, requests };
}
