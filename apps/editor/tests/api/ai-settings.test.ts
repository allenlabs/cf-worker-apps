// Unit tests for the per-workspace AI settings impls + the backend resolver.
// Drives a FAKE `Sql` tagged-template backed by an in-memory row, plus injected
// crypto deps so we never touch real Web Crypto here (the round-trip is proven
// separately in crypto.test.ts). Asserts: provider validation, baseUrl SSRF
// guard, missing-encryption-key → 409, the view never leaks the key, and the
// resolveAiBackend precedence (workspace openai > env > workers_ai > none).

import { describe, it, expect, vi } from 'vitest';
import {
  getAiSettingsImpl,
  setAiSettingsImpl,
  resolveAiBackendImpl,
  type AiSettingsCryptoDeps,
} from '@api/handlers/ai-settings';
import type { Sql } from '@api/lib/db';
import type { AiEnv, AiBinding } from '@api/handlers/ai';

interface StoredRow {
  provider: string;
  baseUrl: string | null;
  model: string | null;
  apiKeyCipher: string | null;
  apiKeyIv: string | null;
}

/**
 * A fake Sql backed by a single mutable `row` ref. Handles:
 *   - SELECT … FROM editor.ai_settings  → returns [row] or []
 *   - INSERT … ON CONFLICT …            → captures the interpolated values into row
 * The tagged-template values arrive as the rest args; their ORDER matches the
 * column order in the impl's INSERT/UPDATE statements.
 */
function fakeSql(state: { row: StoredRow | null }): Sql {
  return ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('SELECT') && text.includes('editor.ai_settings')) {
      return Promise.resolve(state.row ? [state.row] : []);
    }
    if (text.includes('INSERT INTO editor.ai_settings')) {
      // The impl has two distinct statements. Detect which by the literal
      // provider baked into the SQL text, then read the interpolated values.
      if (text.includes("provider = 'workers_ai'")) {
        // VALUES (workspace_id, 'workers_ai', NULL, NULL, NULL, NULL, updated_by, …)
        state.row = {
          provider: 'workers_ai',
          baseUrl: null,
          model: null,
          apiKeyCipher: null,
          apiKeyIv: null,
        };
        return Promise.resolve([]);
      }
      // openai: VALUES (workspace_id, 'openai', base_url, model, cipher, iv, updated_by, …)
      const [, baseUrl, model, cipher, iv] = vals as [
        string,
        string | null,
        string | null,
        string | null,
        string | null,
      ];
      state.row = {
        provider: 'openai',
        baseUrl: baseUrl ?? null,
        model: model ?? null,
        apiKeyCipher: cipher ?? null,
        apiKeyIv: iv ?? null,
      };
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;
}

/** Crypto deps with a deterministic, reversible "encryption" for assertions. */
function fakeCrypto(key = 'server-key'): AiSettingsCryptoDeps {
  return {
    encryptionKey: key,
    encrypt: vi.fn(async (_k: string, plaintext: string) => ({
      cipher: `cipher(${plaintext})`,
      iv: 'iv0',
    })),
    decrypt: vi.fn(async (_k: string, cipher: string) =>
      cipher.replace(/^cipher\(/, '').replace(/\)$/, ''),
    ),
  };
}

const WS = '11111111-1111-1111-1111-111111111111';

describe('getAiSettingsImpl', () => {
  it('returns the workers_ai default when no row exists', async () => {
    const sql = fakeSql({ row: null });
    expect(await getAiSettingsImpl(sql, WS)).toEqual({ provider: 'workers_ai', hasKey: false });
  });

  it('never leaks the key — only exposes hasKey + the non-secret view', async () => {
    const sql = fakeSql({
      row: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        apiKeyCipher: 'cipher(sk-secret)',
        apiKeyIv: 'iv0',
      },
    });
    const view = await getAiSettingsImpl(sql, WS);
    expect(view).toEqual({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      hasKey: true,
    });
    // Defensive: no key/cipher field anywhere in the serialized view.
    expect(JSON.stringify(view)).not.toContain('sk-secret');
    expect(JSON.stringify(view)).not.toContain('cipher');
  });
});

describe('setAiSettingsImpl', () => {
  it('rejects an invalid provider with 400', async () => {
    const sql = fakeSql({ row: null });
    const res = await setAiSettingsImpl(sql, fakeCrypto(), {
      workspaceId: WS,
      // @ts-expect-error — exercising the runtime guard
      provider: 'anthropic',
    });
    expect(res).toEqual({ ok: false, status: 400, error: 'invalid provider' });
  });

  it('requires a base URL for the openai provider', async () => {
    const sql = fakeSql({ row: null });
    const res = await setAiSettingsImpl(sql, fakeCrypto(), { workspaceId: WS, provider: 'openai' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });

  it('blocks SSRF base URLs (localhost/private/metadata)', async () => {
    const sql = fakeSql({ row: null });
    for (const url of [
      'http://localhost/v1',
      'http://127.0.0.1/v1',
      'http://169.254.169.254/latest',
      'http://10.0.0.5/v1',
      'http://192.168.1.1/v1',
      'ftp://example.com/v1',
    ]) {
      const res = await setAiSettingsImpl(sql, fakeCrypto(), {
        workspaceId: WS,
        provider: 'openai',
        baseUrl: url,
        apiKey: 'sk-x',
      });
      expect(res.ok, url).toBe(false);
      if (!res.ok) expect(res.status).toBe(400);
    }
  });

  it('allows a public base URL and encrypts the key at rest', async () => {
    const state = { row: null as StoredRow | null };
    const sql = fakeSql(state);
    const crypto = fakeCrypto();
    const res = await setAiSettingsImpl(sql, crypto, {
      workspaceId: WS,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-secret',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.view).toEqual({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      hasKey: true,
    });
    expect(crypto.encrypt).toHaveBeenCalledWith('server-key', 'sk-secret');
    // Stored as ciphertext, never plaintext.
    expect(state.row?.apiKeyCipher).toBe('cipher(sk-secret)');
    expect(JSON.stringify(state.row)).not.toContain('sk-secret"');
  });

  it('returns 409 when a key is supplied but encryption is not configured', async () => {
    const sql = fakeSql({ row: null });
    const res = await setAiSettingsImpl(
      sql,
      { encrypt: undefined, decrypt: undefined }, // no encryptionKey
      { workspaceId: WS, provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' },
    );
    expect(res).toEqual({ ok: false, status: 409, error: 'encryption not configured' });
  });

  it('keeps the existing cipher when the key is omitted on update', async () => {
    const state = {
      row: {
        provider: 'openai',
        baseUrl: 'https://old.example/v1',
        model: 'm',
        apiKeyCipher: 'cipher(sk-keep)',
        apiKeyIv: 'iv-keep',
      } as StoredRow | null,
    };
    const sql = fakeSql(state);
    const crypto = fakeCrypto();
    const res = await setAiSettingsImpl(sql, crypto, {
      workspaceId: WS,
      provider: 'openai',
      baseUrl: 'https://new.example/v1',
    });
    expect(res.ok).toBe(true);
    expect(crypto.encrypt).not.toHaveBeenCalled();
    expect(state.row?.apiKeyCipher).toBe('cipher(sk-keep)');
    expect(state.row?.apiKeyIv).toBe('iv-keep');
    expect(state.row?.baseUrl).toBe('https://new.example/v1');
  });

  it('clears the key when switching to workers_ai', async () => {
    const state = {
      row: {
        provider: 'openai',
        baseUrl: 'https://x/v1',
        model: 'm',
        apiKeyCipher: 'cipher(sk)',
        apiKeyIv: 'iv',
      } as StoredRow | null,
    };
    const sql = fakeSql(state);
    const res = await setAiSettingsImpl(sql, fakeCrypto(), { workspaceId: WS, provider: 'workers_ai' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.view).toEqual({ provider: 'workers_ai', hasKey: false });
    expect(state.row?.apiKeyCipher).toBeNull();
    expect(state.row?.baseUrl).toBeNull();
    expect(state.row?.provider).toBe('workers_ai');
  });
});

describe('resolveAiBackendImpl precedence', () => {
  const aiBinding: AiBinding = { run: vi.fn(async () => ({ response: 'x' })) };

  it('workspace openai settings WIN over env + workers AI', async () => {
    const sql = fakeSql({
      row: {
        provider: 'openai',
        baseUrl: 'https://ws.example/v1',
        model: 'ws-model',
        apiKeyCipher: 'cipher(sk-ws)',
        apiKeyIv: 'iv',
      },
    });
    const env: AiEnv = { LLM_BASE_URL: 'https://env/v1', LLM_API_KEY: 'k', AI: aiBinding };
    const resolved = await resolveAiBackendImpl(sql, env, fakeCrypto(), WS);
    expect(resolved).toEqual({
      kind: 'openai',
      baseUrl: 'https://ws.example/v1',
      apiKey: 'sk-ws',
      model: 'ws-model',
    });
  });

  it('falls back to env LLM secrets when no workspace openai row', async () => {
    const sql = fakeSql({ row: null });
    const env: AiEnv = { LLM_BASE_URL: 'https://env/v1', LLM_API_KEY: 'env-key', AI: aiBinding };
    const resolved = await resolveAiBackendImpl(sql, env, fakeCrypto(), WS);
    expect(resolved).toEqual({
      kind: 'openai',
      baseUrl: 'https://env/v1',
      apiKey: 'env-key',
      model: undefined,
    });
  });

  it('falls back to workers_ai when only the AI binding is present', async () => {
    const sql = fakeSql({ row: { provider: 'workers_ai', baseUrl: null, model: null, apiKeyCipher: null, apiKeyIv: null } });
    const resolved = await resolveAiBackendImpl(sql, { AI: aiBinding }, fakeCrypto(), WS);
    expect(resolved).toEqual({ kind: 'workers_ai' });
  });

  it('returns none when nothing is configured', async () => {
    const sql = fakeSql({ row: null });
    const resolved = await resolveAiBackendImpl(sql, {}, fakeCrypto(), WS);
    expect(resolved).toEqual({ kind: 'none' });
  });

  it('falls through past a workspace openai row that cannot be decrypted', async () => {
    const sql = fakeSql({
      row: { provider: 'openai', baseUrl: 'https://ws/v1', model: null, apiKeyCipher: 'bad', apiKeyIv: 'iv' },
    });
    const crypto: AiSettingsCryptoDeps = {
      encryptionKey: 'k',
      decrypt: vi.fn(async () => {
        throw new Error('bad key');
      }),
    };
    // No env secrets, but a Workers AI binding → should degrade to workers_ai.
    const resolved = await resolveAiBackendImpl(sql, { AI: aiBinding }, crypto, WS);
    expect(resolved).toEqual({ kind: 'workers_ai' });
  });
});
