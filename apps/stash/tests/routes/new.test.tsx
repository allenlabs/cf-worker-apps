import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
  useRouter: () => ({ navigate: () => {}, invalidate: () => {} }),
}));

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({
    inputValidator: () => ({ handler: () => () => Promise.resolve(null) }),
    handler: () => () => Promise.resolve(null),
  }),
}));

import { parseTags } from '~/routes/new';

describe('parseTags', () => {
  it('returns [] for empty input', () => {
    expect(parseTags('')).toEqual([]);
    expect(parseTags('   ')).toEqual([]);
  });
  it('splits on commas + whitespace', () => {
    expect(parseTags('a, b c')).toEqual(['a', 'b', 'c']);
  });
  it('strips leading #', () => {
    expect(parseTags('#sh #curl')).toEqual(['sh', 'curl']);
  });
  it('lowercases tags', () => {
    expect(parseTags('Curl HTTP')).toEqual(['curl', 'http']);
  });
  it('dedupes while preserving order', () => {
    expect(parseTags('a b a c b')).toEqual(['a', 'b', 'c']);
  });
});
