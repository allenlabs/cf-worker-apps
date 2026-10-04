import { describe, expect, it } from 'vitest';
import { breadcrumbLabel } from '../src/extensions/breadcrumb';

describe('breadcrumbLabel', () => {
  it('returns the trimmed title', () => {
    expect(breadcrumbLabel('  Roadmap  ')).toBe('Roadmap');
  });

  it('falls back to "Untitled" for blank/nullish', () => {
    expect(breadcrumbLabel('')).toBe('Untitled');
    expect(breadcrumbLabel('   ')).toBe('Untitled');
    expect(breadcrumbLabel(null)).toBe('Untitled');
    expect(breadcrumbLabel(undefined)).toBe('Untitled');
  });
});
