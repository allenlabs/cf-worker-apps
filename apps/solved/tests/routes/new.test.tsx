import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>{children}</a>
  ),
  createFileRoute: () => () => ({}),
  useRouter: () => ({ navigate: () => {} }),
}));

import { parseTags } from '~/routes/new';

describe('parseTags', () => {
  it('returns [] for empty input', () => {
    expect(parseTags('')).toEqual([]);
  });
  it('splits on commas + whitespace + lowercases + strips #', () => {
    expect(parseTags('CORS,  #Workerd  http')).toEqual(['cors', 'workerd', 'http']);
  });
  it('dedupes', () => {
    expect(parseTags('a a a')).toEqual(['a']);
  });
});
