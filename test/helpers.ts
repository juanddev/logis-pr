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

/**
 * Jira palsu dengan workflow LOGIS (Story) — dipakai untuk menguji transisi bertahap.
 * Hanya transisi yang tersedia dari status SAAT INI yang dikembalikan (sama seperti Jira asli).
 */
export const LOGIS_WORKFLOW: Record<string, string[]> = {
  'To Do': ['Need Bussiness Requirement', 'Ready For Development', 'In Progress', 'In Testing'],
  'Need Bussiness Requirement': ['Ready For Development'],
  'Ready For Development': ['In Progress', 'Hold'],
  Hold: ['Ready For Development'],
  'In Progress': ['Code Review'],
  'Code Review': ['Ready For Test', 'In Fixing'],
  'Defect Bugs': ['In Fixing'],
  'In Fixing': ['Code Review'],
  'In Testing': [],
};
const ANY = ['To Do', 'Done', 'Invalid'];

export function fakeJiraWorkflow(initial: string, opts: { workflow?: Record<string, string[]>; failPostTo?: string } = {}) {
  const workflow = opts.workflow ?? LOGIS_WORKFLOW;
  const state = { status: initial, history: [] as string[], posts: 0 };
  const list = () => {
    const targets = [...(workflow[state.status] ?? []), ...ANY.filter((a) => a !== state.status)];
    return targets.map((to, i) => ({ id: String(100 + i), name: `Go ${to}`, to: { name: to } }));
  };
  let current = list();
  const { fetchImpl, requests } = fakeFetch([
    {
      match: (u) => /\/issue\/[A-Z]+-\d+\?/.test(u),
      get body() {
        return { key: 'LOGIS-1', fields: { summary: 'S', status: { name: state.status } } };
      },
    },
    {
      match: (u) => u.endsWith('/transitions'),
      get body() {
        current = list();
        return { transitions: current };
      },
    },
  ]);
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? 'GET').toUpperCase() === 'POST' && String(input).endsWith('/transitions')) {
      const id = (JSON.parse(String(init?.body)) as { transition: { id: string } }).transition.id;
      const t = current.find((x) => x.id === id);
      requests.push({ url: String(input), method: 'POST', headers: {}, body: String(init?.body) });
      if (!t) return new Response(JSON.stringify({ errorMessages: ['invalid transition'] }), { status: 400 });
      if (opts.failPostTo && t.to.name === opts.failPostTo) {
        return new Response(JSON.stringify({ errors: { customfield_1: 'Story Points is required' } }), { status: 400 });
      }
      state.posts++;
      state.history.push(`${state.status} → ${t.to.name}`);
      state.status = t.to.name;
      return new Response(null, { status: 204 });
    }
    return fetchImpl(input, init);
  }) as FetchLike;
  return { fetchImpl: wrapped, requests, state };
}
