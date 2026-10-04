import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>{children}</a>
  ),
  createFileRoute: () => () => ({}),
  useRouter: () => ({ invalidate: () => {} }),
}));

import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import {
  ClientRow,
  IssuedSecret,
  NewClientForm,
} from '~/routes/admin.api-clients';

const render = (ui: ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

const NOW = Date.parse('2026-05-24T12:00:00Z');

describe('ClientRow', () => {
  it('renders + invokes onDelete', () => {
    const onDelete = vi.fn();
    render(
      <ClientRow
        client={{
          clientId: 'cli',
          name: 'CLI',
          createdAt: new Date(NOW - 30 * 60_000).toISOString(),
        }}
        now={NOW}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByTestId('delete-cli'));
    expect(onDelete).toHaveBeenCalledWith('cli');
  });
});

describe('NewClientForm', () => {
  it('invokes onSubmit with trimmed values', () => {
    const onSubmit = vi.fn();
    render(<NewClientForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId('new-client-id'), { target: { value: '  ext-1  ' } });
    fireEvent.change(screen.getByTestId('new-client-name'), { target: { value: ' Ext ' } });
    fireEvent.click(screen.getByTestId('new-client-submit'));
    expect(onSubmit).toHaveBeenCalledWith('ext-1', 'Ext');
  });

  it("doesn't submit when blank", () => {
    const onSubmit = vi.fn();
    render(<NewClientForm onSubmit={onSubmit} />);
    // Submitting via form (not button) — button is disabled.  Use requestSubmit
    // path: dispatch a submit event directly.
    const form = screen.getByTestId('new-client-form') as HTMLFormElement;
    fireEvent.submit(form);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('renders an error', () => {
    render(<NewClientForm onSubmit={() => {}} error="boom" />);
    expect(screen.getByTestId('new-client-error').textContent).toBe('boom');
  });
});

describe('IssuedSecret', () => {
  it('renders + dismisses', () => {
    const onDismiss = vi.fn();
    render(<IssuedSecret clientId="cli" hmacSecret="sec123" onDismiss={onDismiss} />);
    expect(screen.getByTestId('issued-secret-value').textContent).toBe('sec123');
    fireEvent.click(screen.getByTestId('dismiss-issued'));
    expect(onDismiss).toHaveBeenCalled();
  });
});
