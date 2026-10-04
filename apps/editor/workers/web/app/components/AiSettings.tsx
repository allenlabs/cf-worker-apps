// Per-workspace AI backend settings (owner/admin only).
//
// A workspace owner can point the editor's "✨ AI" actions at a custom
// OpenAI-compatible provider (OpenAI, a self-hosted LiteLLM, a Codex proxy —
// anything that speaks POST /chat/completions) instead of the default
// Cloudflare Workers AI. The API key is WRITE-ONLY: the server never returns it,
// so we show "key set ✓" when one is stored and only send a new key when the
// user types one. Clearing back to Workers AI drops the custom config + key.
//
// Rendered from the Sidebar footer as a button that opens a modal. The
// server-fn calls are injected (with live defaults) so the component is
// unit-testable under jsdom without the TanStack Start runtime.

import { useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import {
  aiSettingsGet as aiSettingsGetFn,
  aiSettingsSet as aiSettingsSetFn,
  type AiProvider,
  type AiSettingsView,
} from '~/server/docs';

export interface AiSettingsProps {
  workspaceId: string;
  /** Injectable for tests; defaults to the live server fns. */
  getSettings?: (workspaceId: string) => Promise<AiSettingsView>;
  setSettings?: (input: {
    workspaceId: string;
    provider: AiProvider;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }) => Promise<AiSettingsView>;
}

const liveGet = (workspaceId: string) => aiSettingsGetFn({ data: { workspaceId } });
const liveSet = (input: {
  workspaceId: string;
  provider: AiProvider;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}) => aiSettingsSetFn({ data: input });

export function AiSettings({ workspaceId, getSettings = liveGet, setSettings = liveSet }: AiSettingsProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [provider, setProvider] = useState<AiProvider>('workers_ai');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [canManage, setCanManage] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const view = await getSettings(workspaceId);
      setProvider(view.provider);
      setBaseUrl(view.baseUrl ?? '');
      setModel(view.model ?? '');
      setHasKey(view.hasKey);
      setApiKey('');
      setCanManage(view.canManage !== false);
    } catch {
      setError(t('ai.settings.loadError'));
    } finally {
      setLoading(false);
    }
  }

  function openPanel() {
    setOpen(true);
    void load();
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const view = await setSettings({
        workspaceId,
        provider,
        baseUrl: provider === 'openai' ? baseUrl.trim() : undefined,
        model: provider === 'openai' && model.trim() ? model.trim() : undefined,
        // Only send a key when the user typed one (write-only).
        apiKey: provider === 'openai' && apiKey.trim() ? apiKey.trim() : undefined,
      });
      setProvider(view.provider);
      setBaseUrl(view.baseUrl ?? '');
      setModel(view.model ?? '');
      setHasKey(view.hasKey);
      setApiKey('');
      setOpen(false);
    } catch {
      setError(t('ai.settings.saveError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        className="w-full text-left px-2 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
        onClick={openPanel}
        data-testid="ai-settings-open"
      >
        {t('ai.settings.open')}
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setOpen(false)}
          data-testid="ai-settings-overlay"
        >
          <div
            className="w-[28rem] max-w-[90vw] bg-white dark:bg-gray-800 rounded-lg shadow-xl p-5 text-gray-800 dark:text-gray-100"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={t('ai.settings.title')}
          >
            <h2 className="text-base font-semibold mb-1">{t('ai.settings.title')}</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{t('ai.settings.desc')}</p>

            {loading ? (
              <p className="text-sm text-gray-500" data-testid="ai-settings-loading">
                {t('page.loading')}
              </p>
            ) : (
              <fieldset disabled={!canManage || saving} className="space-y-3">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="ai-provider"
                    className="mt-0.5"
                    checked={provider === 'workers_ai'}
                    onChange={() => setProvider('workers_ai')}
                    data-testid="ai-provider-workers"
                  />
                  <span>
                    <span className="font-medium">{t('ai.settings.providerWorkers')}</span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {t('ai.settings.providerWorkersHint')}
                    </span>
                  </span>
                </label>

                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="ai-provider"
                    className="mt-0.5"
                    checked={provider === 'openai'}
                    onChange={() => setProvider('openai')}
                    data-testid="ai-provider-openai"
                  />
                  <span>
                    <span className="font-medium">{t('ai.settings.providerOpenai')}</span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {t('ai.settings.providerOpenaiHint')}
                    </span>
                  </span>
                </label>

                {provider === 'openai' ? (
                  <div className="space-y-2 pl-6">
                    <label className="block text-xs">
                      <span className="block mb-0.5 text-gray-500 dark:text-gray-400">
                        {t('ai.settings.baseUrl')}
                      </span>
                      <input
                        type="url"
                        className="w-full px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-transparent text-sm"
                        placeholder="https://api.openai.com/v1"
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        data-testid="ai-base-url"
                      />
                    </label>
                    <label className="block text-xs">
                      <span className="block mb-0.5 text-gray-500 dark:text-gray-400">
                        {t('ai.settings.model')}
                      </span>
                      <input
                        type="text"
                        className="w-full px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-transparent text-sm"
                        placeholder="gpt-4o-mini"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        data-testid="ai-model"
                      />
                    </label>
                    <label className="block text-xs">
                      <span className="block mb-0.5 text-gray-500 dark:text-gray-400">
                        {t('ai.settings.apiKey')}
                        {hasKey ? (
                          <span className="ml-1 text-green-600 dark:text-green-400" data-testid="ai-key-set">
                            {t('ai.settings.keySet')}
                          </span>
                        ) : null}
                      </span>
                      <input
                        type="password"
                        autoComplete="off"
                        className="w-full px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-transparent text-sm"
                        placeholder={hasKey ? t('ai.settings.keyKeep') : t('ai.settings.keyPlaceholder')}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        data-testid="ai-api-key"
                      />
                    </label>
                  </div>
                ) : null}

                {!canManage ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="ai-settings-readonly">
                    {t('ai.settings.adminOnly')}
                  </p>
                ) : null}
                {error ? (
                  <p className="text-xs text-red-600 dark:text-red-400" data-testid="ai-settings-error">
                    {error}
                  </p>
                ) : null}
              </fieldset>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                className="px-3 py-1.5 text-sm rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                onClick={() => setOpen(false)}
                data-testid="ai-settings-cancel"
              >
                {t('common.cancel')}
              </button>
              <button
                className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                onClick={save}
                disabled={!canManage || saving || loading}
                data-testid="ai-settings-save"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
