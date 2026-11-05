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
import { runAudit } from './audit.js';
import { runInit } from './init.js';
import { choosePrompt, confirmPrompt, isInteractive, isPromptAbort } from './prompt.js';
import { runPr, type RunOptions } from './run.js';

const symbols = getSymbols();
const log = createLogger(symbols);
const printStdout = (line: string) => process.stdout.write(`${line}\n`);

const EXAMPLES = `
Contoh:
  logis-pr -m "tambah enrichment shipment & driver"   commit + push + PR + Jira + Teams
  logis-pr                                            working tree bersih: langsung push & lanjut
  logis-pr -a -m "tambah modul baru"                  ikutkan file baru (untracked) tanpa ditanya
  logis-pr -m "wip" -d --no-teams                     PR draft, tanpa pesan Teams
  logis-pr -t LOGIS-3938 -b staging -y                override tiket & base, kirim tanpa konfirmasi
  logis-pr -m "fix null driver"   (di hotfix/...)     PR ke production & development (bisa dipilih)
  logis-pr --dry-run -m "coba"                        simulasi lengkap tanpa mengubah branch/index/file
  logis-pr --audit                                    periksa branch & isi PR, hanya membaca
  logis-pr --dependent -m "lanjutan"                  tiket bergantung pada kode development: PR langsung ke development
  logis-pr --dependent --depends-on LOGIS-3931        tentukan dependensi sendiri ('none' = tanpa dependensi)
  logis-pr init                                       buat/ubah ~/.logis-pr.json
  logis-pr doctor                                     cek git, gh, config, Jira, Teams
`;

interface CliOptions {
  audit?: boolean;
  message?: string;
  ticket?: string;
  base?: string;
  draft?: boolean;
  yes?: boolean;
  all?: boolean;
  reviewers?: string;
  jira: boolean;
  teams: boolean;
  dryRun?: boolean;
  pushTicket?: boolean;
  dependent?: boolean;
  dependsOn?: string;
}

async function commandRun(opts: CliOptions): Promise<void> {
  const { config } = await loadConfig();
  if (opts.audit) {
    if (opts.message || opts.dryRun || opts.dependsOn !== undefined) {
      throw new CliError('--audit tidak bisa digabung dengan -m, --dry-run, atau --depends-on.', { hint: 'Jalankan: logis-pr --audit' });
    }
    const gh = new GitHub(runCommand);
    const auth = await gh.authStatus().catch(() => ({ ok: false, detail: '' }));
    if (!auth.ok) log.warn('gh belum login: pemeriksaan PR di GitHub dilewati.');
    const res = await runAudit({ ticket: opts.ticket, base: opts.base }, { config, git: new Git(runCommand), gh: auth.ok ? gh : null, log });
    process.exitCode = res.safe ? 0 : 1;
    return;
  }
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
    choose: choosePrompt,
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
    .option('-b, --base <branches>', 'target PR, dipisah koma (default: development; hotfix: ditanya)')
    .option('-a, --all', 'ikutkan file baru (untracked) ke commit tanpa ditanya')
    .option('-r, --reviewers <users>', "reviewer PR, dipisah koma (override config prReviewers; 'none' = tanpa reviewer)")
    .option('-d, --draft', 'buat PR sebagai draft')
    .option('-y, --yes', 'lewati konfirmasi: Teams langsung dikirim, file baru tidak ikut (pakai -a)')
    .option('--no-jira', 'jangan pindahkan status tiket di Jira')
    .option('--no-teams', 'jangan kirim pesan ke Teams')
    .option('--push-ticket', 'push juga branch tiket walau PR-nya hanya lewat LOGIS-XXXX-dev (backup di remote)')
    .option('--dependent', 'tiket bergantung pada kode development: branch berbasis development, PR langsung ke development (tanpa branch integrasi)')
    .option('--depends-on <keys>', "tiket dependensi, dipisah koma, menimpa hasil deteksi ('none' = tanpa dependensi); hanya dengan --dependent")
    .option('--dry-run', 'simulasi lengkap tanpa commit/branch/push/PR/transisi/pesan (hanya git fetch)')
    .option('--audit', 'periksa branch tiket, branch integrasi, dan isi PR — hanya membaca, tanpa fetch')
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
    if (err.hint) log.dim(`  Saran: ${err.hint.split('\n').map((l, i) => (i === 0 || l.startsWith('  ') ? l : `  ${l}`)).join('\n')}`);
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
