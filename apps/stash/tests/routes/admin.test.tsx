import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className, ...rest }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} className={className} {...rest}>
      {children}
    </a>
  ),
  createFileRoute: () => () => ({}),
  useRouter: () => ({ navigate: () => {}, invalidate: () => {} }),
}));

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({
    inputValidator: () => ({ handler: () => () => Promise.resolve(null) }),
    handler: () => () => Promise.resolve(null),
  }),
}));

import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import {
  ClientRow,
  IssuedSecret,
  NewClientForm,
} from '~/routes/admin.api-clients';

const render = (ui: React.ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

const NOW = Date.parse('2026-05-24T12:00:00Z');

describe('ClientRow', () => {
  it('renders client_id + name + revoke button', () => {
    let removed: string | null = null;
    render(
      <ClientRow
        client={{
          clientId: 'ext-laptop',
          name: 'Laptop Extension',
          createdAt: new Date(NOW - 60_000).toISOString(),
        }}
        now={NOW}
        onDelete={(id) => {
          removed = id;
        }}
      />,
    );
    const row = screen.getByTestId('client-ext-laptop');
    expect(row.textContent).toContain('ext-laptop');
    expect(row.textContent).toContain('Laptop Extension');
    fireEvent.click(screen.getByTestId('delete-ext-laptop'));
    expect(removed).toBe('ext-laptop');
  });
});

describe('NewClientForm', () => {
  it('submits the entered values', () => {
    let captured: { clientId: string; name: string } | null = null;
    render(
      <NewClientForm
        onSubmit={(clientId, name) => {
          captured = { clientId, name };
        }}
      />,
    );
    fireEvent.change(screen.getByTestId('new-client-id'), {
      target: { value: 'ext-laptop' },
    });
    fireEvent.change(screen.getByTestId('new-client-name'), {
      target: { value: 'Laptop' },
    });
    fireEvent.click(screen.getByTestId('new-client-submit'));
    expect(captured).toEqual({ clientId: 'ext-laptop', name: 'Laptop' });
  });

  it('does not submit when fields are empty', () => {
    let called = false;
    render(
      <NewClientForm
        onSubmit={() => {
          called = true;
        }}
      />,
    );
    expect((screen.getByTestId('new-client-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByTestId('new-client-form'));
    expect(called).toBe(false);
  });

  it('shows an error message when provided', () => {
    render(<NewClientForm onSubmit={() => {}} error="boom" />);
    expect(screen.getByTestId('new-client-error').textContent).toBe('boom');
  });
});

describe('IssuedSecret', () => {
  it('renders the secret and dismiss button', () => {
    let dismissed = false;
    render(
      <IssuedSecret
        clientId="ext-laptop"
        hmacSecret="abc123-secret"
        onDismiss={() => {
          dismissed = true;
        }}
      />,
    );
    expect(screen.getByTestId('issued-secret-value').textContent).toBe('abc123-secret');
    fireEvent.click(screen.getByTestId('dismiss-issued'));
    expect(dismissed).toBe(true);
  });
});
