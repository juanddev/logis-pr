import spawn from 'cross-spawn';
import { CliError, CommandNotFoundError } from './errors.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  /** Data yang dikirim ke stdin (UTF-8). Dipakai untuk pesan commit & body PR. */
  input?: string;
  /** Teruskan stdin terminal ke proses anak (mis. agar git push bisa minta kredensial). */
  inheritStdin?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Batas waktu (ms). Default 5 menit untuk perintah non-interaktif; perintah dengan stdin terminal tidak dibatasi. */
  timeoutMs?: number;
}

/** Abstraksi pemanggilan proses — di test diganti dengan mock. */
export type Runner = (command: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

/** Ubah CRLF / CR menjadi LF agar parsing output identik di Windows & macOS. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Pecah output menjadi baris tanpa baris kosong di akhir. */
export function lines(text: string): string[] {
  return normalizeEol(text)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
}

/**
 * Jalankan perintah eksternal TANPA shell. Argumen dikirim sebagai array sehingga tidak ada
 * masalah quoting di PowerShell/cmd/zsh. `cross-spawn` menangani resolusi .exe/.cmd di Windows
 * (PATHEXT) dan menormalkan error ENOENT.
 */
export const runCommand: Runner = (command, args, options = {}) =>
  new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        // gh & git: jangan pernah membuka prompt interaktif/pager yang bisa menggantung.
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        ...options.env,
      },
      shell: false,
      windowsHide: true,
      stdio: [options.inheritStdin ? 'inherit' : 'pipe', 'pipe', 'pipe'],
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    // Proses yang keluar lebih dulu bisa memicu EPIPE saat kita menulis stdin; abaikan.
    child.stdin?.on('error', () => undefined);

    const limit = options.timeoutMs ?? (options.inheritStdin ? 0 : 5 * 60_000);
    let timedOut = false;
    const timer =
      limit > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, limit)
        : undefined;

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      if (error.code === 'ENOENT') reject(new CommandNotFoundError(command));
      else reject(error);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new CliError(`Perintah '${command} ${args.slice(0, 3).join(' ')}…' melebihi batas waktu ${Math.round(limit / 1000)} detik.`));
        return;
      }
      resolve({
        code: code ?? 1,
        stdout: normalizeEol(Buffer.concat(out).toString('utf8')),
        stderr: normalizeEol(Buffer.concat(err).toString('utf8')),
      });
    });

    if (!options.inheritStdin && child.stdin) {
      if (options.input !== undefined) child.stdin.end(options.input, 'utf8');
      else child.stdin.end();
    }
  });
