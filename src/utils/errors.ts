/**
 * Error yang ditujukan ke pengguna: pesannya sudah dalam Bahasa Indonesia dan aman
 * ditampilkan (tidak berisi secret). `hint` berisi saran langkah perbaikan.
 */
export class CliError extends Error {
  readonly hint?: string;
  readonly exitCode: number;

  constructor(message: string, options: { hint?: string; exitCode?: number; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CliError';
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 1;
  }
}

/** Perintah eksternal (git/gh/dll.) tidak ditemukan di PATH. */
export class CommandNotFoundError extends CliError {
  readonly command: string;

  constructor(command: string) {
    super(`Perintah '${command}' tidak ditemukan di PATH.`, { hint: commandHint(command) });
    this.name = 'CommandNotFoundError';
    this.command = command;
  }
}

function commandHint(command: string): string {
  const win = process.platform === 'win32';
  switch (command) {
    case 'gh':
      return win
        ? 'Pasang GitHub CLI: winget install --id GitHub.cli, lalu TUTUP dan buka lagi terminal agar PATH ter-refresh. ' +
            'Cek dengan: where.exe gh'
        : 'Pasang GitHub CLI: brew install gh. Cek dengan: which gh';
    case 'git':
      return win
        ? 'Pasang Git for Windows: winget install --id Git.Git, lalu buka ulang terminal. Cek dengan: where.exe git'
        : 'Pasang Git: xcode-select --install atau brew install git.';
    default:
      return `Pastikan '${command}' terpasang dan ada di PATH.`;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
