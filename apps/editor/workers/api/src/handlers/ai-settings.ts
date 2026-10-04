// Per-workspace AI assist backend settings.
//
// A workspace owner/admin can point the AI assist route (/v1/ai) at a CUSTOM
// OpenAI-compatible provider (OpenAI, a self-hosted LiteLLM, a Codex proxy —
// anything that speaks POST /chat/completions). The API key is encrypted at
// rest (AES-GCM via lib/crypto) and NEVER returned to the client.
//
// Resolution precedence (resolveAiBackendImpl), highest first:
//   1. The workspace's stored 'openai' settings (key decrypted per-request).
//   2. The env LLM_BASE_URL/LLM_API_KEY/LLM_MODEL secrets.
//   3. Cloudflare Workers AI (the AI binding).
//   4. None → the route returns 503.
//
// Pure (postgres.js `Sql` + injected crypto deps) — Hono/Cloudflare-free so the
// validation, never-leak, and precedence rules are unit-testable in isolation.

import type { Sql } from '../lib/db';
import { isSafeHttpUrl } from '../lib/host-guard';
import type { AiEnv } from './ai';

/** The provider union persisted in editor.ai_settings.provider. */
export type AiProvider = 'workers_ai' | 'openai';

/** Non-secret view returned to the client. The API key is NEVER included; only
 * a `hasKey` boolean reveals whether one is stored. */
export interface AiSettingsView {
  provider: AiProvider;
  baseUrl?: string;
  model?: string;
  hasKey: boolean;
}

/** A stored settings row (internal — includes the cipher, never returned raw). */
interface AiSettingsRow {
  provider: string;
  baseUrl: string | null;
  model: string | null;
  apiKeyCipher: string | null;
  apiKeyIv: string | null;
}

/** Crypto seam — injected so tests can stub the AES-GCM round-trip. */
export interface AiSettingsCryptoDeps {
  /** Server secret used to encrypt/decrypt the API key (env AI_SETTINGS_KEY). */
  encryptionKey?: string;
  encrypt?: (key: string, plaintext: string) => Promise<{ cipher: string; iv: string }>;
  decrypt?: (key: string, cipher: string, iv: string) => Promise<string>;
}

/** Discriminated result for setAiSettings so the route maps to an HTTP status. */
export type SetAiSettingsResult =
  | { ok: true; view: AiSettingsView }
  | { ok: false; status: 400 | 409; error: string };

/** Read the raw stored row for a workspace (null when none configured). */
async function readRow(sql: Sql, workspaceId: string): Promise<AiSettingsRow | null> {
  const [row] = await sql<AiSettingsRow[]>`
    SELECT provider,
           base_url       AS "baseUrl",
           model,
           api_key_cipher AS "apiKeyCipher",
           api_key_iv     AS "apiKeyIv"
    FROM editor.ai_settings
    WHERE workspace_id = ${workspaceId}
    LIMIT 1
  `;
  return row ?? null;
}

/**
 * The non-secret AI settings view for a workspace. No row → the default
 * (workers_ai, no key). NEVER returns the key or its cipher.
 */
export async function getAiSettingsImpl(sql: Sql, workspaceId: string): Promise<AiSettingsView> {
  const row = await readRow(sql, workspaceId);
  if (!row) return { provider: 'workers_ai', hasKey: false };
  const provider: AiProvider = row.provider === 'openai' ? 'openai' : 'workers_ai';
  return {
    provider,
    baseUrl: row.baseUrl ?? undefined,
    model: row.model ?? undefined,
    hasKey: Boolean(row.apiKeyCipher && row.apiKeyIv),
  };
}

export interface SetAiSettingsInput {
  workspaceId: string;
  provider: AiProvider;
  baseUrl?: string;
  model?: string;
  /** Plaintext API key to encrypt. Omitted → keep the existing cipher. */
  apiKey?: string;
}

/**
 * Configure a workspace's AI backend. Validates the provider union; for 'openai'
 * requires a base URL that passes the shared SSRF guard (blocks
 * localhost/private/metadata, allows public + tunneled hosts). Encrypts the API
 * key at rest with AES-GCM. When the key is omitted on update, the existing
 * cipher is kept; switching to 'workers_ai' clears the stored key. If a key is
 * supplied but AI_SETTINGS_KEY isn't configured, returns 409 (never stores
 * plaintext). The caller is responsible for the owner/admin role gate.
 */
export async function setAiSettingsImpl(
  sql: Sql,
  deps: AiSettingsCryptoDeps,
  input: SetAiSettingsInput,
  updatedBy?: string,
): Promise<SetAiSettingsResult> {
  if (input.provider !== 'workers_ai' && input.provider !== 'openai') {
    return { ok: false, status: 400, error: 'invalid provider' };
  }

  const trimmedKey = input.apiKey?.trim();

  if (input.provider === 'workers_ai') {
    // Switching back to Workers AI clears any custom provider config + key.
    await sql`
      INSERT INTO editor.ai_settings (workspace_id, provider, base_url, model, api_key_cipher, api_key_iv, updated_by, updated_at)
      VALUES (${input.workspaceId}, 'workers_ai', NULL, NULL, NULL, NULL, ${updatedBy ?? null}, now())
      ON CONFLICT (workspace_id) DO UPDATE SET
        provider = 'workers_ai',
        base_url = NULL,
        model = NULL,
        api_key_cipher = NULL,
        api_key_iv = NULL,
        updated_by = ${updatedBy ?? null},
        updated_at = now()
    `;
    return { ok: true, view: { provider: 'workers_ai', hasKey: false } };
  }

  // provider === 'openai'
  const baseUrl = input.baseUrl?.trim();
  if (!baseUrl) {
    return { ok: false, status: 400, error: 'base URL required for openai provider' };
  }
  if (!isSafeHttpUrl(baseUrl)) {
    return { ok: false, status: 400, error: 'base URL is not a safe public http(s) target' };
  }
  const model = input.model?.trim() || null;

  // Resolve the cipher to store: a new key needs encryption (which needs the
  // server secret); an omitted key keeps whatever's already stored.
  let cipher: string | null;
  let iv: string | null;
  if (trimmedKey) {
    if (!deps.encryptionKey) {
      return { ok: false, status: 409, error: 'encryption not configured' };
    }
    const encrypt = deps.encrypt;
    if (!encrypt) {
      return { ok: false, status: 409, error: 'encryption not configured' };
    }
    const enc = await encrypt(deps.encryptionKey, trimmedKey);
    cipher = enc.cipher;
    iv = enc.iv;
  } else {
    const existing = await readRow(sql, input.workspaceId);
    cipher = existing?.apiKeyCipher ?? null;
    iv = existing?.apiKeyIv ?? null;
  }

  await sql`
    INSERT INTO editor.ai_settings (workspace_id, provider, base_url, model, api_key_cipher, api_key_iv, updated_by, updated_at)
    VALUES (${input.workspaceId}, 'openai', ${baseUrl}, ${model}, ${cipher}, ${iv}, ${updatedBy ?? null}, now())
    ON CONFLICT (workspace_id) DO UPDATE SET
      provider = 'openai',
      base_url = ${baseUrl},
      model = ${model},
      api_key_cipher = ${cipher},
      api_key_iv = ${iv},
      updated_by = ${updatedBy ?? null},
      updated_at = now()
  `;
  return {
    ok: true,
    view: {
      provider: 'openai',
      baseUrl,
      model: model ?? undefined,
      hasKey: Boolean(cipher && iv),
    },
  };
}

/** The effective backend the AI handler should use for a request. */
export type ResolvedAiBackend =
  | { kind: 'openai'; baseUrl: string; apiKey: string; model?: string }
  | { kind: 'workers_ai' }
  | { kind: 'none' };

/**
 * Resolve the effective AI backend for a workspace, applying the precedence:
 *   1. workspace 'openai' settings (key decrypted) — when fully configured.
 *   2. env LLM_BASE_URL + LLM_API_KEY (OpenAI-compatible secrets).
 *   3. Cloudflare Workers AI (the AI binding).
 *   4. none.
 *
 * A workspace 'openai' row that's missing a usable key/baseUrl, or can't be
 * decrypted (e.g. AI_SETTINGS_KEY rotated), falls through to the env/Workers-AI
 * chain rather than erroring — the feature degrades instead of breaking.
 */
export async function resolveAiBackendImpl(
  sql: Sql,
  env: AiEnv,
  deps: AiSettingsCryptoDeps,
  workspaceId: string,
): Promise<ResolvedAiBackend> {
  const row = await readRow(sql, workspaceId);
  if (row && row.provider === 'openai' && row.baseUrl && row.apiKeyCipher && row.apiKeyIv) {
    if (deps.encryptionKey && deps.decrypt) {
      try {
        const apiKey = await deps.decrypt(deps.encryptionKey, row.apiKeyCipher, row.apiKeyIv);
        if (apiKey) {
          return {
            kind: 'openai',
            baseUrl: row.baseUrl,
            apiKey,
            model: row.model ?? undefined,
          };
        }
      } catch (e) {
        // Decrypt failed (rotated key / tampered cipher). Fall through to env /
        // Workers AI so AI assist still works; never surface the cipher.
        console.error('[ai-settings] decrypt failed; falling back', workspaceId, e);
      }
    }
  }

  // 2. Env OpenAI-compatible secrets.
  if (env.LLM_BASE_URL && env.LLM_API_KEY) {
    return {
      kind: 'openai',
      baseUrl: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
      model: env.LLM_MODEL,
    };
  }

  // 3. Workers AI binding.
  if (env.AI) return { kind: 'workers_ai' };

  // 4. Nothing configured.
  return { kind: 'none' };
}
