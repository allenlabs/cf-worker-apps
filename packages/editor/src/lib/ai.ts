import type { AiAction } from './types';

/**
 * One selectable AI action in the bubble menu. `i18nKey` resolves a label via
 * the host's `aiT` (falling back to `defaultLabel`). `needsTargetLang` marks
 * the translate action (descoped to a fixed pair of languages — see
 * {@link TRANSLATE_LANGS}); `needsTone` marks change-tone. Kept as plain data so
 * it's unit-testable and the DOM menu can be built without React.
 */
export interface AiMenuAction {
  action: AiAction;
  i18nKey: string;
  defaultLabel: string;
  icon: string;
  needsTargetLang?: boolean;
  needsTone?: boolean;
}

/**
 * Actions shown in the bubble-toolbar AI menu, in order, for a non-empty
 * selection. `custom` and `continue_writing` are NOT here — those are reached
 * via the slash "Ask AI" / "Continue writing" items (a selection already exists
 * in the bubble case).
 */
export const AI_SELECTION_ACTIONS: AiMenuAction[] = [
  { action: 'improve_writing', i18nKey: 'ai.improve', defaultLabel: 'Improve writing', icon: '✦' },
  { action: 'fix_grammar', i18nKey: 'ai.fixGrammar', defaultLabel: 'Fix spelling & grammar', icon: '✓' },
  { action: 'make_shorter', i18nKey: 'ai.shorter', defaultLabel: 'Make shorter', icon: '↧' },
  { action: 'make_longer', i18nKey: 'ai.longer', defaultLabel: 'Make longer', icon: '↥' },
  { action: 'summarize', i18nKey: 'ai.summarize', defaultLabel: 'Summarize', icon: '≣' },
  { action: 'explain', i18nKey: 'ai.explain', defaultLabel: 'Explain', icon: '?' },
  { action: 'change_tone', i18nKey: 'ai.changeTone', defaultLabel: 'Change tone to professional', icon: '♺', needsTone: true },
  // DESCOPE: a translate submenu is a follow-up; offer two fixed languages as
  // separate rows so the plain-DOM menu stays a flat list (no nested popups).
  { action: 'translate', i18nKey: 'ai.translateEn', defaultLabel: 'Translate to English', icon: '🌐', needsTargetLang: true },
  { action: 'translate', i18nKey: 'ai.translateKo', defaultLabel: 'Translate to Korean', icon: '🌐', needsTargetLang: true },
];

/**
 * The default target language carried by each translate row. Keyed by i18nKey
 * (the two fixed rows above) — the value is the model-facing language name.
 */
export const TRANSLATE_LANGS: Record<string, string> = {
  'ai.translateEn': 'English',
  'ai.translateKo': 'Korean',
};

/** Default tone for the single change-tone row (DESCOPE: a tone submenu is a
 * follow-up). */
export const DEFAULT_TONE = 'professional';

/** Resolve an action's label via the host's translator, falling back to the
 * built-in English default. Pure, so it's unit-tested. */
export function aiActionLabel(item: AiMenuAction, t?: (key: string) => string): string {
  if (!t) return item.defaultLabel;
  const out = t(item.i18nKey);
  // The shared i18n `t` returns the key unchanged when missing; fall back then.
  return out && out !== item.i18nKey ? out : item.defaultLabel;
}

/** Resolve a bare i18n key with the same key-unchanged fallback semantics. */
export function aiLabel(key: string, fallback: string, t?: (key: string) => string): string {
  if (!t) return fallback;
  const out = t(key);
  return out && out !== key ? out : fallback;
}
