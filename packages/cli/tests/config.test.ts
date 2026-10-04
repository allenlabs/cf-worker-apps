import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  APP_NAMES,
  configPath,
  loadConfig,
  saveConfig,
  normalizeConfig,
  requireApp,
  DEFAULTS,
} from '../src/lib/config.js';

let workDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'allenlabs-cli-test-'));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('configPath', () => {
  it('uses XDG_CONFIG_HOME when set', () => {
    expect(configPath({ XDG_CONFIG_HOME: '/x' }, '/home/u')).toBe('/x/allenlabs/cli.json');
  });
  it('falls back to ~/.config when XDG unset', () => {
    expect(configPath({}, '/home/u')).toBe('/home/u/.config/allenlabs/cli.json');
  });
  it('falls back when XDG is empty string', () => {
    expect(configPath({ XDG_CONFIG_HOME: '' }, '/h')).toBe('/h/.config/allenlabs/cli.json');
  });
});

describe('loadConfig', () => {
  it('returns {} when file is missing', async () => {
    const cfg = await loadConfig(join(workDir, 'missing.json'));
    expect(cfg).toEqual({});
  });
  it('returns {} when file is invalid JSON', async () => {
    const p = join(workDir, 'broken.json');
    await fs.writeFile(p, '{not json}');
    expect(await loadConfig(p)).toEqual({});
  });
  it('reads a valid config', async () => {
    const p = join(workDir, 'ok.json');
    await fs.writeFile(p, JSON.stringify({
      inbox: { url: 'https://x', client_id: 'cli', secret: 's' },
    }));
    const cfg = await loadConfig(p);
    expect(cfg.inbox?.url).toBe('https://x');
  });
  it('re-throws non-ENOENT non-syntax errors', async () => {
    // Point at a directory (EISDIR) to trigger a non-ENOENT error.
    await expect(loadConfig(workDir)).rejects.toBeInstanceOf(Error);
  });
});

describe('saveConfig', () => {
  it('atomically writes the config and creates dirs', async () => {
    const p = join(workDir, 'sub', 'deep', 'cli.json');
    await saveConfig({ focus: { url: 'u', client_id: 'c', secret: 's' } }, p);
    const back = await loadConfig(p);
    expect(back.focus?.client_id).toBe('c');
  });
  it('round-trips through normalizeConfig', async () => {
    const p = join(workDir, 'rt.json');
    const cfg = {
      inbox: { url: 'https://x', client_id: 'cli', secret: 'secret-value' },
      focus: { url: 'https://y', client_id: 'cli', secret: 'another' },
    };
    await saveConfig(cfg, p);
    expect(await loadConfig(p)).toEqual(cfg);
  });
});

describe('normalizeConfig', () => {
  it('drops non-object input', () => {
    expect(normalizeConfig(null)).toEqual({});
    expect(normalizeConfig(42)).toEqual({});
    expect(normalizeConfig('str')).toEqual({});
  });
  it('drops sections that are not objects', () => {
    expect(normalizeConfig({ inbox: 'nope', focus: null })).toEqual({});
  });
  it('drops sections with missing fields', () => {
    expect(normalizeConfig({ inbox: { url: 'u' } })).toEqual({});
    expect(normalizeConfig({ inbox: { url: 'u', client_id: 'c' } })).toEqual({});
    expect(normalizeConfig({ inbox: { url: 'u', client_id: 'c', secret: 42 } })).toEqual({});
  });
  it('keeps both apps when both are valid', () => {
    const ok = {
      inbox: { url: 'u1', client_id: 'c1', secret: 's1' },
      focus: { url: 'u2', client_id: 'c2', secret: 's2' },
    };
    expect(normalizeConfig(ok)).toEqual(ok);
  });
  it('round-trips the context app section', () => {
    const ok = {
      context: { url: 'https://context-api.allenlabs.org', client_id: 'cli', secret: 'top-secret' },
    };
    expect(normalizeConfig(ok)).toEqual(ok);
  });
});

describe('requireApp', () => {
  it('returns the section when present', () => {
    const c = { inbox: { url: 'u', client_id: 'c', secret: 's' } };
    expect(requireApp(c, 'inbox').url).toBe('u');
  });
  it('throws when missing', () => {
    expect(() => requireApp({}, 'focus')).toThrow(/focus is not configured/);
  });
});

describe('DEFAULTS', () => {
  it('has the well-known endpoints', () => {
    expect(DEFAULTS.inbox.url).toBe('https://inbox-api.allenlabs.org');
    expect(DEFAULTS.focus.url).toBe('https://focus-api.allenlabs.org');
    expect(DEFAULTS.context.url).toBe('https://context-api.allenlabs.org');
    expect(DEFAULTS.inbox.client_id).toBe('cli');
  });
});

describe('APP_NAMES', () => {
  it('enumerates all three apps in canonical order', () => {
    expect([...APP_NAMES]).toEqual(['inbox', 'focus', 'context']);
  });
});
