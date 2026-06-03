/**
 * Code-block language registry — the common set we register with lowlight and
 * surface in the NodeView language picker. Kept as a pure module so the list +
 * normalization helper are unit-testable without importing the TipTap node.
 *
 * `id` is the canonical highlight.js language name (also what we store in the
 * node's `language` attr + emit as `class="language-<id>"` for round-trip);
 * `label` is the human label shown in the dropdown; `aliases` cover the names
 * a ```fence might use (e.g. "ts" → "typescript").
 */
export interface CodeLanguage {
  id: string;
  label: string;
  aliases: string[];
}

/** The languages we register + offer. `plaintext` is the no-highlight default. */
export const CODE_LANGUAGES: CodeLanguage[] = [
  { id: 'plaintext', label: 'Plain text', aliases: ['text', 'txt', 'plain', 'none', ''] },
  { id: 'typescript', label: 'TypeScript', aliases: ['ts'] },
  { id: 'javascript', label: 'JavaScript', aliases: ['js', 'node'] },
  { id: 'tsx', label: 'TSX', aliases: ['typescriptreact'] },
  { id: 'jsx', label: 'JSX', aliases: ['javascriptreact'] },
  { id: 'python', label: 'Python', aliases: ['py'] },
  { id: 'go', label: 'Go', aliases: ['golang'] },
  { id: 'rust', label: 'Rust', aliases: ['rs'] },
  { id: 'json', label: 'JSON', aliases: ['json5'] },
  { id: 'bash', label: 'Bash', aliases: ['sh', 'shell', 'zsh'] },
  { id: 'sql', label: 'SQL', aliases: ['postgres', 'postgresql', 'mysql'] },
  { id: 'xml', label: 'HTML', aliases: ['html', 'htm', 'xhtml', 'svg'] },
  { id: 'css', label: 'CSS', aliases: ['scss', 'sass', 'less'] },
  { id: 'yaml', label: 'YAML', aliases: ['yml'] },
  { id: 'markdown', label: 'Markdown', aliases: ['md', 'mkd'] },
];

/** The canonical default language id (no highlighting). */
export const DEFAULT_CODE_LANGUAGE = 'plaintext';

const ALIAS_TO_ID: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const lang of CODE_LANGUAGES) {
    m.set(lang.id.toLowerCase(), lang.id);
    for (const a of lang.aliases) m.set(a.toLowerCase(), lang.id);
  }
  return m;
})();

/**
 * Normalize a raw language token (from a ```fence, a paste, or the picker) to
 * one of our canonical ids. Unknown / empty tokens fall back to the default
 * (`plaintext`) so the picker + highlighting never break on a stray value.
 */
export function normalizeLanguage(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_CODE_LANGUAGE;
  const key = raw.trim().toLowerCase();
  return ALIAS_TO_ID.get(key) ?? DEFAULT_CODE_LANGUAGE;
}

/** Human label for a (raw or canonical) language token. */
export function languageLabel(raw: string | null | undefined): string {
  const id = normalizeLanguage(raw);
  return CODE_LANGUAGES.find((l) => l.id === id)?.label ?? 'Plain text';
}
