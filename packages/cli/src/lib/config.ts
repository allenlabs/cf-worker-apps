// Config storage for @allenlabs/cli.
//
// Lives at $XDG_CONFIG_HOME/allenlabs/cli.json (defaults to
// ~/.config/allenlabs/cli.json).  Two app-scoped sections so we can add
// more apps later (today, journal, …) without breaking schema.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface AppConfig {
  url: string;
  client_id: string;
  secret: string;
}

export interface CliConfig {
  inbox?: AppConfig;
  focus?: AppConfig;
  context?: AppConfig;
}

export type AppName = 'inbox' | 'focus' | 'context';

export const APP_NAMES: readonly AppName[] = ['inbox', 'focus', 'context'] as const;

export const DEFAULTS: Record<AppName, { url: string; client_id: string }> = {
  inbox: { url: 'https://inbox-api.allenlabs.org', client_id: 'cli' },
  focus: { url: 'https://focus-api.allenlabs.org', client_id: 'cli' },
  context: { url: 'https://context-api.allenlabs.org', client_id: 'cli' },
};

/** Resolve the config file path. Respects XDG_CONFIG_HOME, falls back to ~/.config. */
export function configPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(home, '.config');
  return join(base, 'allenlabs', 'cli.json');
}

/** Load the config file. Returns {} if it doesn't exist or isn't valid JSON. */
export async function loadConfig(path: string = configPath()): Promise<CliConfig> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return normalizeConfig(parsed);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return {};
    // Treat malformed JSON as empty config so the CLI doesn't wedge on a
    // hand-edited file; the user can rerun `al login` to fix it.
    if (err instanceof SyntaxError) return {};
    throw err;
  }
}

/** Atomically write the config file (chmod 0600). */
export async function saveConfig(cfg: CliConfig, path: string = configPath()): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, path);
}

/** Coerce arbitrary JSON into our shape, dropping garbage. */
export function normalizeConfig(input: unknown): CliConfig {
  if (!input || typeof input !== 'object') return {};
  const obj = input as Record<string, unknown>;
  const out: CliConfig = {};
  for (const app of APP_NAMES) {
    const section = obj[app];
    if (!section || typeof section !== 'object') continue;
    const s = section as Record<string, unknown>;
    if (typeof s.url === 'string' && typeof s.client_id === 'string' && typeof s.secret === 'string') {
      out[app] = { url: s.url, client_id: s.client_id, secret: s.secret };
    }
  }
  return out;
}

/** Require an app to be configured, with a friendly error. */
export function requireApp(cfg: CliConfig, app: AppName): AppConfig {
  const section = cfg[app];
  if (!section) {
    throw new Error(
      `${app} is not configured. Run \`al login\` to set up endpoint + HMAC secret.`,
    );
  }
  return section;
}
