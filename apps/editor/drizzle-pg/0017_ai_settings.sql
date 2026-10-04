-- Phase 19: per-workspace AI assist backend settings.
--
-- The AI assist route (/v1/ai) resolves which LLM backend to use per request.
-- A workspace owner/admin can opt the workspace into a CUSTOM OpenAI-compatible
-- provider (OpenAI, a self-hosted LiteLLM, a Codex proxy — anything that speaks
-- POST /chat/completions). When no row exists (or provider='workers_ai'), the
-- route falls back to the env LLM_* secrets, then to Cloudflare Workers AI — so
-- existing behavior is unchanged unless a workspace explicitly configures one.
--
--   provider        — 'workers_ai' (default) | 'openai' (OpenAI-compatible)
--   base_url        — the OpenAI-compatible base (no trailing /chat/completions)
--   model           — optional model id override
--   api_key_cipher  — AES-GCM ciphertext of the API key (base64), NULLable.
--                     NEVER stored in plaintext; encrypted with the server's
--                     AI_SETTINGS_KEY secret via Web Crypto.
--   api_key_iv      — base64 IV used for the AES-GCM encryption (per write).
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS editor.ai_settings (
  workspace_id uuid PRIMARY KEY REFERENCES editor.workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'workers_ai',
  base_url text,
  model text,
  api_key_cipher text,
  api_key_iv text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
