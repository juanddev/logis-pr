import { chmod, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliError, errorMessage } from '../utils/errors.js';

export type TeamsMode = 'workflow' | 'graph';

export interface Config {
  jiraBaseUrl: string;
  jiraEmail: string;
  jiraApiToken: string;
  jiraReviewStatus: string;
  /** Status perantara (dipisah koma, urut sesuai workflow) yang dilewati menuju jiraReviewStatus. */
  jiraTransitionPath: string;
  jiraProjectKey: string;
  teamsMode: TeamsMode;
  teamsWebhookUrl: string;
  graphTenantId: string;
  graphClientId: string;
  graphChatId: string;
  baseBranch: string;
  /** Branch produksi: asal semua branch kerja & target PR hotfix. */
  productionBranch: string;
  /** Prefix branch hotfix (dipisah koma) — boleh di-PR ke production dan development. */
  hotfixPrefixes: string;
  /** Username GitHub reviewer PR (dipisah koma). Kosong = tidak meminta review. */
  prReviewers: string;
  repoPrefix: string;
}

export type ConfigKey = keyof Config;
export type ConfigSource = 'default' | 'file' | 'env';

export const DEFAULT_CONFIG: Config = {
  jiraBaseUrl: 'https://serasiautoraya.atlassian.net',
  jiraEmail: '',
  jiraApiToken: '',
  jiraReviewStatus: 'Code Review',
  jiraTransitionPath: 'Ready For Development, In Progress',
  jiraProjectKey: 'LOGIS',
  teamsMode: 'workflow',
  teamsWebhookUrl: '',
  graphTenantId: '',
  graphClientId: '',
  graphChatId: '',
  baseBranch: 'development',
  productionBranch: 'production',
  hotfixPrefixes: 'hotfix/',
  prReviewers: 'firdausnp',
  repoPrefix: 'SELOG_LOGIS_',
};

/** Environment variable yang meng-override field config. */
export const ENV_VARS: Record<ConfigKey, string> = {
  jiraBaseUrl: 'LOGIS_PR_JIRA_BASE_URL',
  jiraEmail: 'LOGIS_PR_JIRA_EMAIL',
  jiraApiToken: 'LOGIS_PR_JIRA_API_TOKEN',
  jiraReviewStatus: 'LOGIS_PR_JIRA_REVIEW_STATUS',
  jiraTransitionPath: 'LOGIS_PR_JIRA_TRANSITION_PATH',
  jiraProjectKey: 'LOGIS_PR_JIRA_PROJECT_KEY',
  teamsMode: 'LOGIS_PR_TEAMS_MODE',
  teamsWebhookUrl: 'LOGIS_PR_TEAMS_WEBHOOK_URL',
  graphTenantId: 'LOGIS_PR_GRAPH_TENANT_ID',
  graphClientId: 'LOGIS_PR_GRAPH_CLIENT_ID',
  graphChatId: 'LOGIS_PR_GRAPH_CHAT_ID',
  baseBranch: 'LOGIS_PR_BASE_BRANCH',
  productionBranch: 'LOGIS_PR_PRODUCTION_BRANCH',
  hotfixPrefixes: 'LOGIS_PR_HOTFIX_PREFIXES',
  prReviewers: 'LOGIS_PR_REVIEWERS',
  repoPrefix: 'LOGIS_PR_REPO_PREFIX',
};

export const SECRET_KEYS: ReadonlySet<ConfigKey> = new Set<ConfigKey>(['jiraApiToken', 'teamsWebhookUrl']);

const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as ConfigKey[];

export interface LoadedConfig {
  config: Config;
  path: string;
  fileExists: boolean;
  sources: Record<ConfigKey, ConfigSource>;
}

export interface ConfigContext {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/** ~/.logis-pr.json (Windows: %USERPROFILE%\.logis-pr.json). Override: LOGIS_PR_CONFIG. */
export function configPath(ctx: ConfigContext = {}): string {
  const env = ctx.env ?? process.env;
  if (env.LOGIS_PR_CONFIG) return path.resolve(env.LOGIS_PR_CONFIG);
  return path.join(ctx.homeDir ?? os.homedir(), '.logis-pr.json');
}

/** Lokasi cache token Microsoft Graph (mode fallback). */
export function graphTokenPath(ctx: ConfigContext = {}): string {
  const env = ctx.env ?? process.env;
  if (env.LOGIS_PR_GRAPH_TOKEN_CACHE) return path.resolve(env.LOGIS_PR_GRAPH_TOKEN_CACHE);
  return path.join(ctx.homeDir ?? os.homedir(), '.logis-pr-graph-token.json');
}

function normalizeConfig(cfg: Config): Config {
  const teamsMode: TeamsMode = cfg.teamsMode === 'graph' ? 'graph' : 'workflow';
  return {
    ...cfg,
    jiraBaseUrl: cfg.jiraBaseUrl.trim().replace(/\/+$/, ''),
    jiraEmail: cfg.jiraEmail.trim(),
    jiraApiToken: cfg.jiraApiToken.trim(),
    jiraReviewStatus: cfg.jiraReviewStatus.trim(),
    jiraTransitionPath: cfg.jiraTransitionPath.trim(),
    jiraProjectKey: cfg.jiraProjectKey.trim().toUpperCase(),
    teamsWebhookUrl: cfg.teamsWebhookUrl.trim(),
    graphTenantId: cfg.graphTenantId.trim(),
    graphClientId: cfg.graphClientId.trim(),
    graphChatId: cfg.graphChatId.trim(),
    baseBranch: cfg.baseBranch.trim(),
    productionBranch: cfg.productionBranch.trim(),
    hotfixPrefixes: cfg.hotfixPrefixes.trim(),
    prReviewers: cfg.prReviewers.trim(),
    repoPrefix: cfg.repoPrefix.trim(),
    teamsMode,
  };
}

/** Parse isi file config. BOM dibuang (Notepad Windows sering menambahkannya). */
export function parseConfigFile(text: string, filePath: string): Partial<Config> {
  const clean = text.replace(/^\uFEFF/, '').trim();
  if (!clean) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(clean);
  } catch (err) {
    throw new CliError(`File config ${filePath} bukan JSON yang valid: ${errorMessage(err)}`, {
      hint: 'Perbaiki file tersebut atau jalankan ulang: logis-pr init',
    });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError(`File config ${filePath} harus berupa objek JSON.`, { hint: 'Jalankan: logis-pr init' });
  }
  const out: Partial<Config> = {};
  for (const key of CONFIG_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string') (out as Record<string, string>)[key] = value;
  }
  return out;
}

export async function loadConfig(ctx: ConfigContext = {}): Promise<LoadedConfig> {
  const env = ctx.env ?? process.env;
  const file = configPath(ctx);
  const sources = Object.fromEntries(CONFIG_KEYS.map((k) => [k, 'default'])) as Record<ConfigKey, ConfigSource>;
  const merged: Config = { ...DEFAULT_CONFIG };

  let fileExists = false;
  let text: string | undefined;
  try {
    text = await readFile(file, 'utf8');
    fileExists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new CliError(`Tidak bisa membaca config ${file}: ${errorMessage(err)}`);
    }
  }

  if (text !== undefined) {
    const fromFile = parseConfigFile(text, file);
    for (const key of CONFIG_KEYS) {
      const v = fromFile[key];
      if (v !== undefined && v !== '') {
        (merged as unknown as Record<string, string>)[key] = v;
        sources[key] = 'file';
      }
    }
  }

  for (const key of CONFIG_KEYS) {
    const v = env[ENV_VARS[key]];
    if (v !== undefined && v.trim() !== '') {
      (merged as unknown as Record<string, string>)[key] = v;
      sources[key] = 'env';
    }
  }

  return { config: normalizeConfig(merged), path: file, fileExists, sources };
}

export async function saveConfig(config: Config, filePath: string): Promise<void> {
  const body = `${JSON.stringify(normalizeConfig(config), null, 2)}\n`;
  await writeFile(filePath, body, { encoding: 'utf8', mode: 0o600 });
  // writeFile tidak mengubah mode file yang sudah ada; paksa 600 (diabaikan di Windows).
  await chmod(filePath, 0o600).catch(() => undefined);
}

export interface Requirements {
  jira: boolean;
  teams: boolean;
}

/** Daftar field wajib yang masih kosong untuk kebutuhan run saat ini. */
export function missingFields(cfg: Config, req: Requirements): ConfigKey[] {
  const required: ConfigKey[] = ['baseBranch', 'productionBranch', 'repoPrefix', 'jiraProjectKey'];
  if (req.jira) required.push('jiraBaseUrl', 'jiraEmail', 'jiraApiToken', 'jiraReviewStatus');
  if (req.teams) {
    if (cfg.teamsMode === 'graph') required.push('graphTenantId', 'graphClientId', 'graphChatId');
    else required.push('teamsWebhookUrl');
  }
  return required.filter((k) => !cfg[k]);
}

export function hasJiraCredentials(cfg: Config): boolean {
  return Boolean(cfg.jiraBaseUrl && cfg.jiraEmail && cfg.jiraApiToken);
}

/** Pecah daftar dipisah koma/spasi, buang kosong & duplikat (case-insensitive). */
export function splitList(value: string): string[] {
  const out: string[] = [];
  for (const raw of value.split(/[,\n]/)) {
    const v = raw.trim();
    if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

/**
 * Username GitHub: buang '@' di depan, sisanya divalidasi longgar. Nilai `none` atau `-` = tanpa reviewer
 * (string kosong di file config dianggap "pakai default", jadi butuh penanda eksplisit).
 */
export function parseReviewers(value: string): string[] {
  if (/^\s*(none|-)\s*$/i.test(value)) return [];
  const valid = splitList(value.replace(/\s+/g, ','))
    .map((r) => r.replace(/^@/, ''))
    .filter((r) => /^[A-Za-z0-9-]+(\/[A-Za-z0-9._-]+)?$/.test(r));
  return splitList(valid.join(','));
}
