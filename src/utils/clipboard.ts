import { runCommand, type Runner } from './exec.js';

/**
 * Salin teks ke clipboard memakai utilitas bawaan OS (tanpa dependensi native yang rusak
 * saat dibundel):
 *  - Windows: clip.exe (selalu ada), fallback PowerShell Set-Clipboard
 *  - macOS:   pbcopy
 *  - Linux:   wl-copy / xclip / xsel
 * Mengembalikan true bila berhasil. Tidak pernah melempar error (langkah non-kritis).
 */
export async function copyToClipboard(
  text: string,
  runner: Runner = runCommand,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const candidates: Array<[string, string[]]> =
    platform === 'win32'
      ? [
          ['clip', []],
          ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$input | Set-Clipboard']],
        ]
      : platform === 'darwin'
        ? [['pbcopy', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];

  for (const [cmd, args] of candidates) {
    try {
      const res = await runner(cmd, args, { input: text });
      if (res.code === 0) return true;
    } catch {
      // coba kandidat berikutnya
    }
  }
  return false;
}
