import { describe, expect, it } from 'vitest';
import { slugifyHeading, ensureHeadingId } from '../src/lib/headings';

describe('slugifyHeading', () => {
  it('lowercases, trims, and hyphenates non-alphanumerics', () => {
    expect(slugifyHeading('  Hello, World!  ')).toBe('hello-world');
    expect(slugifyHeading('Section 2.1 — Intro')).toBe('section-2-1-intro');
  });

  it('keeps unicode letters/numbers', () => {
    expect(slugifyHeading('한글 제목')).toBe('한글-제목');
  });

  it('returns empty string for non-word input', () => {
    expect(slugifyHeading('!!!')).toBe('');
    expect(slugifyHeading('')).toBe('');
  });
});

describe('ensureHeadingId', () => {
  it('keeps an existing id when it is not already used', () => {
    const used = new Set<string>();
    expect(ensureHeadingId('intro', 'Intro', used)).toBe('intro');
    expect(used.has('intro')).toBe(true);
  });

  it('derives a slug from text when no id exists', () => {
    const used = new Set<string>();
    expect(ensureHeadingId(null, 'Getting Started', used)).toBe('getting-started');
  });

  it('dedupes colliding slugs with a numeric suffix', () => {
    const used = new Set<string>();
    expect(ensureHeadingId(null, 'Notes', used)).toBe('notes');
    expect(ensureHeadingId(null, 'Notes', used)).toBe('notes-2');
    expect(ensureHeadingId(null, 'Notes', used)).toBe('notes-3');
  });

  it('reassigns a duplicate existing id rather than colliding', () => {
    const used = new Set<string>(['notes']);
    expect(ensureHeadingId('notes', 'Notes', used)).toBe('notes-2');
  });

  it('falls back to "heading" for empty text', () => {
    const used = new Set<string>();
    expect(ensureHeadingId(null, '', used)).toBe('heading');
    expect(ensureHeadingId(null, '!!!', used)).toBe('heading-2');
  });
});
