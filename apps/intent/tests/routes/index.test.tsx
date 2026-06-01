import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
  createFileRoute: () => () => ({ Route: { useLoaderData: () => null } }),
  useRouter: () => ({ invalidate: () => {} }),
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

import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { NoSession } from '~/routes/index';

describe('NoSession', () => {
  it('renders signed-out copy', () => {
    render(
      <I18nProvider locale="en" dict={appDict}>
        <NoSession />
      </I18nProvider>,
    );
    expect(screen.getByTestId('no-session').textContent).toContain('Signed out');
  });
});
