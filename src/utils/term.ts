import pc from 'picocolors';

/**
 * Deteksi dukungan simbol Unicode di terminal. Windows Terminal, VS Code, dan terminal modern
 * mendukung; conhost lama (cmd/PowerShell 5 di jendela klasik) sering menampilkan kotak.
 * Override manual: LOGIS_PR_ASCII=1 (paksa ASCII) atau LOGIS_PR_ASCII=0 (paksa Unicode).
 */
export function isUnicodeSupported(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  if (env.LOGIS_PR_ASCII === '1') return false;
  if (env.LOGIS_PR_ASCII === '0') return true;
  if (platform !== 'win32') return env.TERM !== 'linux';
  return (
    Boolean(env.WT_SESSION) || // Windows Terminal
    Boolean(env.TERMINUS_SUBLIME) ||
    env.ConEmuTask === '{cmd::Cmder}' ||
    env.TERM_PROGRAM === 'vscode' ||
    env.TERM === 'xterm-256color' ||
    env.TERM === 'alacritty' ||
    env.TERMINAL_EMULATOR === 'JetBrains-JediTerm'
  );
}

export interface Symbols {
  ok: string;
  warn: string;
  fail: string;
  info: string;
  arrow: string;
  bullet: string;
  line: string;
}

export const UNICODE_SYMBOLS: Symbols = { ok: '✔', warn: '⚠', fail: '✖', info: 'ℹ', arrow: '→', bullet: '•', line: '─' };
export const ASCII_SYMBOLS: Symbols = { ok: '[OK]', warn: '[!]', fail: '[X]', info: '[i]', arrow: '->', bullet: '-', line: '-' };

export function getSymbols(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Symbols {
  return isUnicodeSupported(env, platform) ? UNICODE_SYMBOLS : ASCII_SYMBOLS;
}

export interface Logger {
  /** Judul langkah, mis. "[1/4] Commit & push". */
  step(title: string): void;
  ok(message: string): void;
  warn(message: string): void;
  fail(message: string): void;
  info(message: string): void;
  /** Teks apa adanya (tanpa simbol). */
  plain(message: string): void;
  /** Teks redup untuk detail. */
  dim(message: string): void;
}

export function createLogger(symbols: Symbols = getSymbols()): Logger {
  // Semua log ke stderr, sehingga stdout bersih (hanya link PR di akhir) untuk dipipe.
  const write = (s: string) => process.stderr.write(`${s}\n`);
  return {
    step: (t) => write(`\n${pc.bold(pc.cyan(t))}`),
    ok: (m) => write(`${pc.green(symbols.ok)} ${m}`),
    warn: (m) => write(`${pc.yellow(symbols.warn)} ${pc.yellow(m)}`),
    fail: (m) => write(`${pc.red(symbols.fail)} ${pc.red(m)}`),
    info: (m) => write(`${pc.blue(symbols.info)} ${m}`),
    plain: (m) => write(m),
    dim: (m) => write(pc.dim(m)),
  };
}

/** Logger senyap untuk test. Menyimpan semua baris. */
export function createMemoryLogger(): Logger & { lines: string[] } {
  const store: string[] = [];
  const push = (kind: string) => (m: string) => {
    store.push(`${kind}: ${m}`);
  };
  return {
    lines: store,
    step: push('step'),
    ok: push('ok'),
    warn: push('warn'),
    fail: push('fail'),
    info: push('info'),
    plain: push('plain'),
    dim: push('dim'),
  };
}

/** Kotak sederhana untuk preview pesan; aman untuk ASCII. */
export function boxed(text: string, symbols: Symbols = getSymbols()): string {
  const rule = symbols.line.repeat(60);
  return [rule, text, rule].join('\n');
}
