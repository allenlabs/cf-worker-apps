// `al login` — interactive setup.
//
// Prompts for endpoint + HMAC secret for each app, tries pass-cli first
// if available, then smoke-tests /health.  Writes to ~/.config/allenlabs/cli.json.

/* v8 ignore start — interactive, requires a TTY + pass-cli; lib/* tested. */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import {
  APP_NAMES,
  DEFAULTS,
  loadConfig,
  saveConfig,
  type AppConfig,
  type AppName,
  type CliConfig,
} from '../lib/config.js';
import { pingHealth } from '../lib/hmac.js';
import {
  emitError,
  makeIO,
  resolveMode,
  type IO,
  type ModeFlags,
} from '../lib/output.js';

const PASS_CLI_ITEMS: Record<AppName, string> = {
  inbox: 'Inbox API HMAC',
  focus: 'Focus API HMAC',
  context: 'Context API HMAC',
};

/** Try to fetch a secret from pass-cli.  Returns null on any failure. */
export async function fetchFromPassCli(itemTitle: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'pass-cli',
      ['item', 'view', '--vault-name', 'Development', '--item-title', itemTitle, '--field', 'password', '--output', 'human'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdoutBuf = '';
    child.stdout.on('data', (d: Buffer) => { stdoutBuf += d.toString('utf8'); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const trimmed = stdoutBuf.trim();
      resolve(trimmed.length > 0 ? trimmed : null);
    });
  });
}

export async function loginCommand(flags: ModeFlags = {}, io: IO = makeIO()): Promise<number> {
  const mode = resolveMode(flags);
  if (!stdin.isTTY) {
    return emitError(io, mode, '`al login` is interactive — run from a terminal.');
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const existing = await loadConfig();
  const next: CliConfig = { ...existing };

  for (const app of APP_NAMES) {
    io.stdout(`\n== ${app} ==`);
    const defaults = DEFAULTS[app];
    const existingApp = existing[app];
    const urlPrompt = `endpoint [${existingApp?.url ?? defaults.url}]: `;
    const url = (await rl.question(urlPrompt)).trim() || existingApp?.url || defaults.url;
    const clientIdPrompt = `client_id [${existingApp?.client_id ?? defaults.client_id}]: `;
    const clientId = (await rl.question(clientIdPrompt)).trim() || existingApp?.client_id || defaults.client_id;

    io.stdout(`looking up HMAC secret from pass-cli ("${PASS_CLI_ITEMS[app]}")…`);
    const fromPass = await fetchFromPassCli(PASS_CLI_ITEMS[app]);
    let secret: string;
    if (fromPass) {
      io.stdout('  found in pass-cli ✓');
      secret = fromPass;
    } else {
      io.stdout('  not found in pass-cli — paste the secret instead:');
      secret = (await rl.question('secret: ')).trim();
      if (!secret) {
        io.stdout(`  skipping ${app} (empty secret)`);
        continue;
      }
    }
    const appCfg: AppConfig = { url, client_id: clientId, secret };
    next[app] = appCfg;
  }
  rl.close();

  await saveConfig(next);

  io.stdout('\n== health check ==');
  for (const app of APP_NAMES) {
    const cfg = next[app];
    if (!cfg) { io.stdout(`  ${app}: (not configured)`); continue; }
    const h = await pingHealth(cfg.url);
    io.stdout(`  ${app}: ${h.ok ? 'OK ✓' : `unreachable (${h.error ?? `HTTP ${h.status}`})`}`);
  }
  io.stdout('\nsaved.');
  return 0;
}

/* v8 ignore stop */
