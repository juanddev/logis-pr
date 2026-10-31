#!/usr/bin/env node
import { Command } from 'commander';
import { hasJiraCredentials, loadConfig } from '../config/index.js';
import { createNotifiedStore } from '../config/state.js';
import { Git } from '../git/index.js';
import { GitHub } from '../github/index.js';
import { JiraClient } from '../jira/index.js';
import { createTeamsSender } from '../teams/index.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { CliError } from '../utils/errors.js';
import { runCommand } from '../utils/exec.js';
import { createLogger, getSymbols } from '../utils/term.js';
import { VERSION } from '../version.js';
import { runDoctor } from './doctor.js';
import { runGraphChats, runGraphLogin } from './graph.js';
import { runInit } from './init.js';
import { confirmPrompt, isInteractive, isPromptAbort } from './prompt.js';
import { runPr, type RunOptions } from './run.js';

const symbols = getSymbols();
const log = createLogger(symbols);
const printStdout = (line: string) => process.stdout.write(`${line}\n`);

const EXAMPLES = `
Contoh:
  logis-pr -m "tambah enrichment shipment & driver"   commit + push + PR + Jira + Teams
  logis-pr                                            working tree bersih: langsung push & lanjut
  logis-pr -m "wip" -d --no-teams                     PR draft, tanpa pesan Teams
  logis-pr -t LOGIS-3938 -b staging -y                override tiket & base, kirim tanpa konfirmasi
  logis-pr --dry-run -m "coba"                        lihat rencana tanpa mengubah apa pun
  logis-pr init                                       buat/ubah ~/.logis-pr.json
  logis-pr doctor                                     cek git, gh, config, Jira, Teams
`;

interface CliOptions {
  message?: string;
  ticket?: string;
  base?: string;
  draft?: boolean;
  yes?: boolean;
  jira: boolean;
  teams: boolean;
  dryRun?: boolean;
}

async function commandRun(opts: CliOptions): Promise<void> {
  const { config } = await loadConfig();
  const interactive = isInteractive();
  const runOpts: RunOptions = { ...opts };
  await runPr(runOpts, {
    config,
    git: new Git(runCommand),
    gh: new GitHub(runCommand),
    jira: hasJiraCredentials(config)
      ? new JiraClient({ baseUrl: config.jiraBaseUrl, email: config.jiraEmail, apiToken: config.jiraApiToken })
      : null,
    sendTeams: opts.teams
      ? createTeamsSender(config, {
          interactive,
          graph: {
            onDeviceCode: ({ verificationUri, userCode }) =>
              log.info(`Login Microsoft dibutuhkan: buka ${verificationUri} lalu masukkan kode ${userCode}`),
          },
        })
      : null,
    confirm: confirmPrompt,
    notified: createNotifiedStore(),
    copy: (text) => copyToClipboard(text),
    log,
    symbols,
    interactive,
    printResult: printStdout,
  });
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name('logis-pr')
    .description('Commit + push → Pull Request (gh) → Jira "Code Review" → pesan ke grup Teams "Oknum LOGis".')
    .version(VERSION, '-v, --version', 'tampilkan versi')
    .helpOption('-h, --help', 'tampilkan bantuan')
    .helpCommand(false)
    .option('-m, --message <pesan>', 'pesan commit (prefix LOGIS-XXXX: ditambahkan bila key tiket belum ada)')
    .option('-t, --ticket <key>', 'override key tiket dari nama branch (mis. LOGIS-3938)')
    .option('-b, --base <branch>', 'base branch PR (default dari config: baseBranch)')
    .option('-d, --draft', 'buat PR sebagai draft')
    .option('-y, --yes', 'kirim ke Teams tanpa konfirmasi')
    .option('--no-jira', 'jangan pindahkan status tiket di Jira')
    .option('--no-teams', 'jangan kirim pesan ke Teams')
    .option('--dry-run', 'tampilkan semua yang AKAN dilakukan tanpa commit/push/PR/transisi/pesan')
    .showHelpAfterError('(jalankan "logis-pr --help" untuk bantuan)')
    .addHelpText('after', EXAMPLES)
    .action(async (opts: CliOptions) => {
      await commandRun(opts);
    });

  program
    .command('init')
    .description('wizard interaktif untuk membuat/mengubah ~/.logis-pr.json')
    .action(async () => {
      await runInit(log);
    });

  program
    .command('doctor')
    .description('cek git, gh login, config, akses Jira, dan Teams')
    .option('--test-teams', 'kirim pesan uji ke grup Teams (mode Workflows)')
    .action(async (o: { testTeams?: boolean }) => {
      process.exitCode = await runDoctor(log, { testTeams: o.testTeams });
    });

  program
    .command('graph-login')
    .description('login Microsoft Graph (device code) untuk mode fallback teamsMode=graph')
    .action(async () => {
      await runGraphLogin(log);
    });

  program
    .command('graph-chats')
    .description('cari ID group chat Teams (mode Graph)')
    .option('-n, --name <nama>', 'filter nama chat', 'Oknum LOGis')
    .action(async (o: { name: string }) => {
      await runGraphChats(log, o.name, printStdout);
    });

  return program;
}

function handleError(err: unknown): void {
  if (isPromptAbort(err)) {
    log.warn('Dibatalkan.');
    process.exitCode = 130;
    return;
  }
  if (err instanceof CliError) {
    log.fail(err.message);
    if (err.hint) log.dim(`  Saran: ${err.hint}`);
    process.exitCode = err.exitCode;
    return;
  }
  const e = err instanceof Error ? err : new Error(String(err));
  log.fail(`Error tak terduga: ${e.message}`);
  if (process.env.LOGIS_PR_DEBUG === '1' && e.stack) log.dim(e.stack);
  else log.dim('  Jalankan ulang dengan LOGIS_PR_DEBUG=1 untuk detail.');
  process.exitCode = 1;
}

async function main(argv: string[]): Promise<void> {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    throw new CliError(`logis-pr butuh Node.js 20 atau lebih baru (terpasang: ${process.versions.node}).`);
  }
  await buildProgram().parseAsync(argv);
}

main(process.argv).catch(handleError);
