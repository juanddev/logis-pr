import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NotifiedStore } from '../cli/run.js';

interface StateFile {
  notified: Record<string, string>; // prUrl → ISO timestamp
}

const MAX_ENTRIES = 300;

/** ~/.logis-pr-state.json — mencatat PR yang sudah diumumkan ke Teams. Override: LOGIS_PR_STATE. */
export function statePath(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  return env.LOGIS_PR_STATE ? path.resolve(env.LOGIS_PR_STATE) : path.join(homeDir, '.logis-pr-state.json');
}

async function read(file: string): Promise<StateFile> {
  try {
    const raw = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as Partial<StateFile>;
    return { notified: raw.notified && typeof raw.notified === 'object' ? raw.notified : {} };
  } catch {
    return { notified: {} };
  }
}

export function createNotifiedStore(file: string = statePath(), now: () => Date = () => new Date()): NotifiedStore {
  return {
    async sentAt(prUrl) {
      const iso = (await read(file)).notified[prUrl];
      if (!iso) return null;
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
    },
    async markSent(prUrl) {
      const state = await read(file);
      state.notified[prUrl] = now().toISOString();
      const entries = Object.entries(state.notified)
        .sort((a, b) => a[1].localeCompare(b[1]))
        .slice(-MAX_ENTRIES);
      await writeFile(file, `${JSON.stringify({ notified: Object.fromEntries(entries) }, null, 2)}\n`, 'utf8');
    },
  };
}
