// `al config` — show resolved config + health.  Secrets are masked.

/* v8 ignore start — thin wrapper over lib/* (tested) + network. */

import { APP_NAMES, configPath, loadConfig } from '../lib/config.js';
import { pingHealth } from '../lib/hmac.js';
import { makeIO, resolveMode, type IO, type ModeFlags } from '../lib/output.js';

function mask(secret: string): string {
  if (secret.length <= 8) return '***';
  return `${secret.slice(0, 4)}…${secret.slice(-2)}`;
}

export async function configCommand(flags: ModeFlags = {}, io: IO = makeIO()): Promise<number> {
  const mode = resolveMode(flags);
  const path = configPath();
  const cfg = await loadConfig();

  if (mode === 'json') {
    const payload: Record<string, unknown> = { path, apps: {} };
    const apps = payload.apps as Record<string, unknown>;
    for (const app of APP_NAMES) {
      const c = cfg[app];
      if (!c) { apps[app] = null; continue; }
      const h = await pingHealth(c.url);
      apps[app] = {
        url: c.url,
        client_id: c.client_id,
        secret_preview: mask(c.secret),
        health: { ok: h.ok, status: h.status, error: h.error },
      };
    }
    io.stdout(JSON.stringify(payload));
    return 0;
  }

  io.stdout(`config: ${path}`);
  for (const app of APP_NAMES) {
    const c = cfg[app];
    if (!c) {
      io.stdout(`  ${app}: (not configured — run \`al login\`)`);
      continue;
    }
    const h = await pingHealth(c.url);
    const health = h.ok ? 'OK ✓' : `unreachable (${h.error ?? `HTTP ${h.status}`})`;
    io.stdout(`  ${app}:`);
    io.stdout(`    url        ${c.url}`);
    io.stdout(`    client_id  ${c.client_id}`);
    io.stdout(`    secret     ${mask(c.secret)}`);
    io.stdout(`    health     ${health}`);
  }
  return 0;
}

/* v8 ignore stop */
