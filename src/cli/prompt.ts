import { confirm } from '@inquirer/prompts';

/** Prompt ditulis ke stderr agar stdout tetap bersih (link PR). Jalan di PowerShell, cmd, dan Terminal macOS. */
export const promptContext = { input: process.stdin, output: process.stderr } as const;

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

/** Ctrl+C / Esc saat prompt → dianggap "tidak". */
export function isPromptAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'ExitPromptError' || err.name === 'AbortPromptError');
}

/** Konfirmasi [Y/n] (default Ya) atau [y/N] (default Tidak). */
export async function confirmPrompt(question: string, defaultYes = true): Promise<boolean> {
  try {
    return await confirm({ message: question, default: defaultYes }, promptContext);
  } catch (err) {
    if (isPromptAbort(err)) return false;
    throw err;
  }
}
