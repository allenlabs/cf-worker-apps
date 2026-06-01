import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className, ...rest }: {
    children: React.ReactNode;
    to: string;
    className?: string;
  }) => (
    <a href={to} className={className} {...rest}>
      {children}
    </a>
  ),
  createFileRoute: () => () => ({ Route: { useLoaderData: () => null, useSearch: () => ({}) } }),
  useRouter: () => ({ invalidate: () => {}, navigate: () => {} }),
}));

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({
    inputValidator: () => ({ handler: () => () => Promise.resolve(null) }),
    handler: () => () => Promise.resolve(null),
  }),
}));

vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => null,
}));

import { render as rtlRender, screen } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { EmptyState } from '~/routes/index';

const render = (ui: React.ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

describe('EmptyState', () => {
  it('renders the gentle copy', () => {
    render(<EmptyState />);
    expect(screen.getByTestId('empty-state').textContent).toContain('All clear');
  });
});
