import { graphTokenPath, loadConfig, missingFields } from '../config/index.js';
import { deviceCodeLogin, getGraphToken, listGroupChats } from '../teams/graph.js';
import { CliError } from '../utils/errors.js';
import type { Logger } from '../utils/term.js';
import { TEAMS_CHAT_NAME } from './run.js';

async function graphSettings() {
  const { config } = await loadConfig();
  const missing = missingFields({ ...config, graphChatId: config.graphChatId || '-' }, { jira: false, teams: true }).filter(
    (k) => k === 'graphTenantId' || k === 'graphClientId',
  );
  if (config.teamsMode !== 'graph' || missing.length) {
    throw new CliError('Mode Graph belum dikonfigurasi (teamsMode=graph, graphTenantId, graphClientId).', {
      hint: 'Jalankan: logis-pr init → pilih "Microsoft Graph API"',
    });
  }
  return { tenantId: config.graphTenantId, clientId: config.graphClientId, cachePath: graphTokenPath() };
}

export async function runGraphLogin(log: Logger): Promise<void> {
  const settings = await graphSettings();
  await deviceCodeLogin(settings, {
    onDeviceCode: ({ verificationUri, userCode }) => {
      log.info(`Buka ${verificationUri} di browser, lalu masukkan kode: ${userCode}`);
      log.dim('    Menunggu login selesai…');
    },
  });
  log.ok(`Login Microsoft Graph berhasil. Token disimpan di ${settings.cachePath}`);
}

export async function runGraphChats(log: Logger, name: string, print: (line: string) => void): Promise<void> {
  const settings = await graphSettings();
  const token = await getGraphToken(settings, { interactive: true }, {
    onDeviceCode: ({ verificationUri, userCode }) =>
      log.info(`Buka ${verificationUri} di browser, lalu masukkan kode: ${userCode}`),
  });
  const chats = await listGroupChats(token);
  const needle = name.trim().toLowerCase();
  const matches = needle ? chats.filter((c) => (c.topic ?? '').toLowerCase().includes(needle)) : chats;
  if (!matches.length) {
    log.warn(`Tidak ada group chat yang cocok dengan "${name}" (dari ${chats.length} group chat).`);
    log.dim('    Pastikan Anda anggota grup tersebut. Coba: logis-pr graph-chats -n ""');
    return;
  }
  for (const c of matches) print(`${c.id}\t${c.topic ?? '(tanpa nama)'}`);
  log.info(`Salin ID chat "${TEAMS_CHAT_NAME}" ke field graphChatId (logis-pr init) atau env LOGIS_PR_GRAPH_CHAT_ID.`);
}
