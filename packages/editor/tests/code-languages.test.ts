import { describe, expect, it } from 'vitest';
import {
  CODE_LANGUAGES,
  DEFAULT_CODE_LANGUAGE,
  normalizeLanguage,
  languageLabel,
} from '../src/lib/code-languages';

describe('CODE_LANGUAGES', () => {
  it('starts with the no-highlight default and has unique canonical ids', () => {
    expect(CODE_LANGUAGES[0]!.id).toBe(DEFAULT_CODE_LANGUAGE);
    const ids = CODE_LANGUAGES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers the common picker set', () => {
    const ids = CODE_LANGUAGES.map((l) => l.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'typescript',
        'javascript',
        'tsx',
        'jsx',
        'python',
        'go',
        'rust',
        'json',
        'bash',
        'sql',
        'css',
        'yaml',
        'markdown',
      ]),
    );
  });
});

describe('normalizeLanguage', () => {
  it('maps aliases to canonical ids (case-insensitive)', () => {
    expect(normalizeLanguage('ts')).toBe('typescript');
    expect(normalizeLanguage('JS')).toBe('javascript');
    expect(normalizeLanguage('py')).toBe('python');
    expect(normalizeLanguage('golang')).toBe('go');
    expect(normalizeLanguage('html')).toBe('xml');
    expect(normalizeLanguage('  Shell ')).toBe('bash');
  });

  it('passes canonical ids through unchanged', () => {
    expect(normalizeLanguage('rust')).toBe('rust');
    expect(normalizeLanguage('markdown')).toBe('markdown');
  });

  it('falls back to the default for empty / unknown tokens', () => {
    expect(normalizeLanguage('')).toBe(DEFAULT_CODE_LANGUAGE);
    expect(normalizeLanguage(null)).toBe(DEFAULT_CODE_LANGUAGE);
    expect(normalizeLanguage(undefined)).toBe(DEFAULT_CODE_LANGUAGE);
    expect(normalizeLanguage('cobol')).toBe(DEFAULT_CODE_LANGUAGE);
  });
});

describe('languageLabel', () => {
  it('returns the human label for an alias or canonical id', () => {
    expect(languageLabel('ts')).toBe('TypeScript');
    expect(languageLabel('python')).toBe('Python');
    expect(languageLabel('html')).toBe('HTML');
  });

  it('labels unknown / empty tokens as plain text', () => {
    expect(languageLabel('')).toBe('Plain text');
    expect(languageLabel('zzz')).toBe('Plain text');
  });
});
