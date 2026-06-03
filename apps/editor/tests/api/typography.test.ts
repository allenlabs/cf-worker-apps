// Phase 18 unit tests for the pure typography/icon helpers (~/lib/typography).

import { describe, it, expect } from 'vitest';
import {
  PAGE_FONTS,
  normalizeFont,
  pageTypographyClass,
  isImageIcon,
} from '~/lib/typography';

describe('normalizeFont', () => {
  it('keeps known fonts', () => {
    expect(normalizeFont('serif')).toBe('serif');
    expect(normalizeFont('mono')).toBe('mono');
    expect(normalizeFont('default')).toBe('default');
  });

  it('falls back to default for unknown / nullish', () => {
    expect(normalizeFont('comic-sans')).toBe('default');
    expect(normalizeFont(null)).toBe('default');
    expect(normalizeFont(undefined)).toBe('default');
    expect(normalizeFont('')).toBe('default');
  });

  it('exposes the fonts in menu order', () => {
    expect(PAGE_FONTS).toEqual(['default', 'serif', 'mono']);
  });
});

describe('pageTypographyClass', () => {
  it('is empty for the default presentation', () => {
    expect(pageTypographyClass('default', false)).toBe('');
    expect(pageTypographyClass(null, undefined)).toBe('');
  });

  it('maps serif/mono fonts to their classes', () => {
    expect(pageTypographyClass('serif', false)).toBe('ae-page-serif');
    expect(pageTypographyClass('mono', false)).toBe('ae-page-mono');
  });

  it('adds the small-text class', () => {
    expect(pageTypographyClass('default', true)).toBe('ae-page-small');
  });

  it('combines font + small text', () => {
    expect(pageTypographyClass('serif', true)).toBe('ae-page-serif ae-page-small');
  });

  it('ignores an unknown font (treated as default)', () => {
    expect(pageTypographyClass('wingdings', true)).toBe('ae-page-small');
  });
});

describe('isImageIcon', () => {
  it('treats http(s) URLs as image icons', () => {
    expect(isImageIcon('https://files.example.com/a.png')).toBe(true);
    expect(isImageIcon('http://x/y.jpg')).toBe(true);
  });

  it('treats /files/ paths as image icons', () => {
    expect(isImageIcon('/files/abc123.png')).toBe(true);
  });

  it('treats emoji / empty as NOT image icons', () => {
    expect(isImageIcon('📄')).toBe(false);
    expect(isImageIcon('')).toBe(false);
    expect(isImageIcon(null)).toBe(false);
    expect(isImageIcon(undefined)).toBe(false);
  });
});
