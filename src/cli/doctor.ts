import {
  graphTokenPath,
  hasJiraCredentials,
  loadConfig,
  missingFields,
  SECRET_KEYS,
  type ConfigKey,
} from '../config/index.js';
import { Git, parseRemoteUrl } from '../git/index.js';
import { GitHub } from '../github/index.js';
import { JiraClient } from '../jira/index.js';
import { extractTicketKey, serviceFromRepo } from '../message/index.js';
import { getChat, getGraphToken } from '../teams/graph.js';
import { sendViaWorkflow, validateWebhookUrl } from '../teams/workflow.js';
import { CliError, errorMessage } from '../utils/errors.js';
import { runCommand } from '../utils/exec.js';
import { maskSecret, redactUrl } from '../utils/secret.js';
import { isUnicodeSupported, type Logger } from '../utils/term.js';
import { TEAMS_CHAT_NAME } from './run.js';

type Status = 'ok' | 'warn' | 'fail';

/** Pemeriksaan lingkungan: git, gh, config, Jira, Teams. Exit code 1 bila ada yang gagal. */
export async function runDoctor(log: Logger, opts: { testTeams?: boolean } = {}): Promise<number> {
  let failures = 0;
  const report = (status: Status, label: string, detail = '', hint?: string) => {
    const line = detail ? `${label}: ${detail}` : label;
    if (status === 'ok') log.ok(line);
    else if (status === 'warn') log.warn(line);
    else {
      failures++;
      log.fail(line);
    }
    if (hint && status !== 'ok') log.dim(`    Saran: ${hint}`);
  };
  const check = async (label: string, fn: () => Promise<[Status, string, string?]>) => {
    try {
      const [s, d, h] = await fn();
      report(s, label, d, h);
    } catch (err) {
      report('fail', label, errorMessage(err), err instanceof CliError ? err.hint : undefined);
    }
  };

  log.step('Sistem');
  const major = Number(process.versions.node.split('.')[0]);
  report(major >= 20 ? 'ok' : 'fail', 'Node.js', process.versions.node, 'Butuh Node.js 20 atau lebih baru.');
  report('ok', 'Platform', `${process.platform} ${process.arch}`);
  report(
    'ok',
    'Simbol terminal',
    isUnicodeSupported() ? 'Unicode (✔ ⚠ ✖)' : 'ASCII fallback (set LOGIS_PR_ASCII=0 untuk paksa Unicode)',
  );

  const git = new Git(runCommand);
  const gh = new GitHub(runCommand);
  await check('git', async () => ['ok', await git.version()]);
  await check('gh', async () => ['ok', await gh.version()]);
  await check('gh login', async () => {
    const a = await gh.authStatus();
    return a.ok ? ['ok', a.detail || 'sudah login'] : ['fail', 'belum login', 'Jalankan: gh auth login'];
  });

  log.step('Config');
  const loaded = await loadConfig();
  const cfg = loaded.config;
  report(
    loaded.fileExists ? 'ok' : 'warn',
    'File config',
    loaded.fileExists ? loaded.path : `${loaded.path} (belum ada)`,
    'Jalankan: logis-pr init',
  );
  const show = (k: ConfigKey) => {
    const v = cfg[k];
    const shown = !v ? '(kosong)' : k === 'teamsWebhookUrl' ? redactUrl(v) : SECRET_KEYS.has(k) ? maskSecret(v) : v;
    log.dim(`    ${k.padEnd(17)} ${shown}  [${loaded.sources[k]}]`);
  };
  (Object.keys(cfg) as ConfigKey[]).forEach(show);
  const missing = missingFields(cfg, { jira: true, teams: true });
  report(
    missing.length ? 'fail' : 'ok',
    'Kelengkapan config',
    missing.length ? `kosong: ${missing.join(', ')}` : 'lengkap',
    'Jalankan: logis-pr init',
  );

  log.step('Jira');
  if (!hasJiraCredentials(cfg)) {
    report('fail', 'Akses Jira', 'kredensial belum diisi', 'Jalankan: logis-pr init');
  } else {
    await check('Akses Jira', async () => {
      const me = await new JiraClient({ baseUrl: cfg.jiraBaseUrl, email: cfg.jiraEmail, apiToken: cfg.jiraApiToken }).myself();
      return ['ok', `login sebagai ${me.displayName}`];
    });
  }

  log.step(`Teams (${cfg.teamsMode === 'graph' ? 'Microsoft Graph' : 'Workflows'})`);
  if (cfg.teamsMode === 'workflow') {
    if (!cfg.teamsWebhookUrl) {
      report('fail', 'URL Workflows', 'belum diisi', 'Jalankan: logis-pr init');
    } else {
      const v = validateWebhookUrl(cfg.teamsWebhookUrl);
      report(v.ok ? 'ok' : 'fail', 'URL Workflows', v.ok ? redactUrl(cfg.teamsWebhookUrl) : v.reason, 'Jalankan: logis-pr init');
      if (v.ok && opts.testTeams) {
        await check('Kirim pesan uji', async () => {
          const text = 'Tes koneksi logis-pr (abaikan pesan ini).';
          await sendViaWorkflow(cfg.teamsWebhookUrl, {
            text,
            html: text,
            ticket: '',
            desc: '',
            prUrl: '',
            ticketUrl: '',
            source: 'logis-pr',
          });
          return ['ok', `terkirim — cek grup "${TEAMS_CHAT_NAME}"`];
        });
      } else if (v.ok) {
        log.dim('    URL tidak diuji kirim. Pakai: logis-pr doctor --test-teams (mengirim pesan uji ke grup).');
      }
    }
  } else {
    await check('Login Microsoft Graph', async () => {
      const token = await getGraphToken(
        { tenantId: cfg.graphTenantId, clientId: cfg.graphClientId, cachePath: graphTokenPath() },
        { interactive: false },
      );
      if (!cfg.graphChatId) return ['fail', 'token OK, tetapi graphChatId kosong', 'Jalankan: logis-pr graph-chats'];
      const chat = await getChat(token, cfg.graphChatId);
      return ['ok', `chat "${chat.topic ?? '(tanpa nama)'}" dapat diakses`];
    });
  }

  log.step('Repo saat ini');
  if (!(await git.isRepo().catch(() => false))) {
    log.dim('    Bukan di dalam repo git (lewati).');
  } else {
    await check('Branch & tiket', async () => {
      const branch = await git.currentBranch();
      if (!branch) return ['warn', 'detached HEAD'];
      const key = extractTicketKey(branch, cfg.jiraProjectKey);
      return key ? ['ok', `${branch} → ${key}`] : ['warn', `${branch} (key tiket tidak ditemukan)`, 'Pakai -t LOGIS-1234'];
    });
    await check('Remote origin', async () => {
      const r = parseRemoteUrl(await git.remoteUrl());
      if (!r) return ['fail', 'bukan URL GitHub'];
      return ['ok', `${r.owner}/${r.repo} · Service = ${serviceFromRepo(r.repo, cfg.repoPrefix)}`];
    });
  }

  log.step('Hasil');
  if (failures === 0) log.ok('Semua pemeriksaan lulus.');
  else log.fail(`${failures} pemeriksaan gagal.`);
  return failures === 0 ? 0 : 1;
}
