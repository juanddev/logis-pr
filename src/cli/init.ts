import { confirm, input, password, select } from '@inquirer/prompts';
import { loadConfig, saveConfig, type Config, type TeamsMode } from '../config/index.js';
import { JiraClient } from '../jira/index.js';
import { validateWebhookUrl } from '../teams/workflow.js';
import { CliError, errorMessage } from '../utils/errors.js';
import { maskSecret, redactUrl } from '../utils/secret.js';
import type { Logger } from '../utils/term.js';
import { isInteractive, promptContext } from './prompt.js';

const required = (label: string) => (v: string) => (v.trim() ? true : `${label} wajib diisi`);

/** Wizard interaktif pembuatan ~/.logis-pr.json. Secret tidak pernah ditampilkan ulang. */
export async function runInit(log: Logger): Promise<void> {
  if (!isInteractive()) {
    throw new CliError('logis-pr init membutuhkan terminal interaktif.', {
      hint: 'Atau tulis file config manual / pakai environment variable (lihat README).',
    });
  }
  const loaded = await loadConfig();
  const cur = loaded.config;
  log.info(`${loaded.fileExists ? 'Memperbarui' : 'Membuat'} config: ${loaded.path}`);
  log.dim('  Tekan Enter untuk memakai nilai di dalam kurung. Secret yang sudah ada tidak ditampilkan.');

  const ask = (message: string, def: string, validate?: (v: string) => true | string) =>
    input({ message, default: def || undefined, validate }, promptContext);
  const askSecret = async (message: string, existing: string): Promise<string> => {
    const v = await password(
      {
        message: existing ? `${message} (Enter = tetap pakai ${maskSecret(existing)})` : message,
        mask: '*',
        validate: (s) => (s.trim() || existing ? true : `${message} wajib diisi`),
      },
      promptContext,
    );
    return v.trim() || existing;
  };

  const next: Config = { ...cur };
  next.jiraBaseUrl = await ask('Jira base URL', cur.jiraBaseUrl, (v) =>
    /^https:\/\/[^/]+/.test(v.trim()) ? true : 'Harus diawali https://',
  );
  next.jiraEmail = await ask('Email akun Jira (Atlassian)', cur.jiraEmail, (v) =>
    /.+@.+\..+/.test(v.trim()) ? true : 'Email tidak valid',
  );
  next.jiraApiToken = await askSecret('Jira API token', cur.jiraApiToken);
  next.jiraReviewStatus = await ask('Nama status review di board Jira', cur.jiraReviewStatus, required('Status'));
  next.jiraTransitionPath = await ask(
    'Status perantara menuju status review, urut sesuai workflow (dipisah koma)',
    cur.jiraTransitionPath,
  );
  next.baseBranch = await ask('Base branch default untuk PR', cur.baseBranch, required('Base branch'));
  next.repoPrefix = await ask('Prefix nama repo (dibuang untuk nama Service)', cur.repoPrefix, required('Prefix'));
  next.prReviewers = await ask("Reviewer PR (username GitHub, dipisah koma; 'none' = tanpa reviewer)", cur.prReviewers, (v) =>
    v.trim() ? true : "Isi username, atau 'none' bila tidak perlu reviewer",
  );

  next.teamsMode = await select<TeamsMode>(
    {
      message: 'Cara mengirim pesan ke grup Teams "Oknum LOGis"',
      default: cur.teamsMode,
      choices: [
        { name: 'Teams Workflows / Power Automate (disarankan)', value: 'workflow' },
        { name: 'Microsoft Graph API (fallback bila Workflows diblokir)', value: 'graph' },
      ],
    },
    promptContext,
  );

  if (next.teamsMode === 'workflow') {
    next.teamsWebhookUrl = await password(
      {
        message: cur.teamsWebhookUrl
          ? `URL trigger Workflows (Enter = tetap pakai ${redactUrl(cur.teamsWebhookUrl)})`
          : 'URL trigger Workflows (HTTP URL dari "When a Teams webhook request is received")',
        mask: '*',
        validate: (v) => {
          if (!v.trim()) return cur.teamsWebhookUrl ? true : 'URL wajib diisi';
          const c = validateWebhookUrl(v.trim());
          return c.ok ? true : `URL tidak valid: ${c.reason}`;
        },
      },
      promptContext,
    ).then((v) => v.trim() || cur.teamsWebhookUrl);
  } else {
    next.graphTenantId = await ask('Directory (tenant) ID App registration', cur.graphTenantId, required('Tenant ID'));
    next.graphClientId = await ask('Application (client) ID', cur.graphClientId, required('Client ID'));
    next.graphChatId = await ask(
      'Chat ID grup "Oknum LOGis" (boleh dikosongkan, cari nanti dengan: logis-pr graph-chats)',
      cur.graphChatId,
    );
  }

  await saveConfig(next, loaded.path);
  log.ok(`Config tersimpan di ${loaded.path}`);

  const test = await confirm({ message: 'Uji koneksi Jira sekarang?', default: true }, promptContext);
  if (test) {
    try {
      const me = await new JiraClient({
        baseUrl: next.jiraBaseUrl,
        email: next.jiraEmail,
        apiToken: next.jiraApiToken,
      }).myself();
      log.ok(`Jira OK — login sebagai ${me.displayName}`);
    } catch (err) {
      log.warn(`Jira belum bisa diakses: ${errorMessage(err)}`);
      if (err instanceof CliError && err.hint) log.dim(`    Saran: ${err.hint}`);
    }
  }
  if (next.teamsMode === 'graph') log.info('Langkah berikutnya: logis-pr graph-login, lalu logis-pr graph-chats');
  log.info('Cek semuanya dengan: logis-pr doctor');
}
