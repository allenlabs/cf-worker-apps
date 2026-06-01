import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>{children}</a>
  ),
  createFileRoute: () => () => ({}),
  useRouter: () => ({ navigate: () => {} }),
}));

import { render as rtlRender, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { DetailHeader } from '~/routes/entry.$id';

const render = (ui: ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

const NOW = Date.parse('2026-05-24T12:00:00Z');

describe('DetailHeader', () => {
  it('renders title + source + ref + url + tags', () => {
    render(
      <DetailHeader
        entry={{
          id: 3,
          title: 'CORS fix',
          body: 'b',
          tags: ['cors', 'workerd'],
          source: 'pr_merged',
          sourceRef: 'pm:pm#42',
          sourceUrl: 'https://example.com/pr/42',
          createdAt: new Date(NOW - 5 * 60_000).toISOString(),
          updatedAt: new Date(NOW - 5 * 60_000).toISOString(),
        }}
        now={NOW}
      />,
    );
    const h = screen.getByTestId('detail-header');
    expect(h.textContent).toContain('CORS fix');
    expect(h.textContent).toContain('5m ago');
    expect(h.textContent).toContain('pr_merged');
    expect(h.textContent).toContain('pm:pm#42');
    expect(screen.getByTestId('tag-cors')).toBeTruthy();
    expect(screen.getByTestId('tag-workerd')).toBeTruthy();
  });

  it('shows edited timestamp when updated > created', () => {
    render(
      <DetailHeader
        entry={{
          id: 1,
          title: 't',
          body: 'b',
          tags: [],
          source: null,
          sourceRef: null,
          sourceUrl: null,
          createdAt: new Date(NOW - 60 * 60_000).toISOString(),
          updatedAt: new Date(NOW - 5 * 60_000).toISOString(),
        }}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('detail-header').textContent).toMatch(/edited 5m ago/);
  });
});
