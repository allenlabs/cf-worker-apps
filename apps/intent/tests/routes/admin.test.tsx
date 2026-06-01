import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
  createFileRoute: () => () => ({ Route: { useLoaderData: () => ({ clients: [] }) } }),
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

import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { ClientRow, IssuedSecret, NewClientForm } from '~/routes/admin.api-clients';

const render = (ui: ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

describe('ClientRow', () => {
  it('renders client + invokes delete', () => {
    const onDelete = vi.fn();
    render(
      <ClientRow
        client={{ clientId: 'cli', name: 'CLI', createdAt: '2026-05-24T10:00:00Z' }}
        onDelete={onDelete}
      />,
    );
    expect(screen.getByTestId('client-cli')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('delete-cli'));
    expect(onDelete).toHaveBeenCalledWith('cli');
  });
  it('works without onDelete handler', () => {
    render(
      <ClientRow
        client={{ clientId: 'cli', name: 'CLI', createdAt: '' }}
      />,
    );
    fireEvent.click(screen.getByTestId('delete-cli'));
  });
});

describe('NewClientForm', () => {
  it('submit disabled until fields filled', () => {
    const onSubmit = vi.fn();
    render(<NewClientForm onSubmit={onSubmit} />);
    const btn = screen.getByTestId('new-client-submit');
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByTestId('new-client-id'), { target: { value: 'ext-1' } });
    fireEvent.change(screen.getByTestId('new-client-name'), { target: { value: 'Ext' } });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onSubmit).toHaveBeenCalledWith('ext-1', 'Ext');
  });
  it('ignores submit when fields blank', () => {
    const onSubmit = vi.fn();
    render(<NewClientForm onSubmit={onSubmit} />);
    fireEvent.submit(screen.getByTestId('new-client-form'));
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('shows error + busy', () => {
    render(<NewClientForm onSubmit={() => {}} busy error="bad" />);
    expect(screen.getByTestId('new-client-error').textContent).toBe('bad');
    expect(screen.getByTestId('new-client-submit').textContent).toBe('Issuing…');
  });
});

describe('IssuedSecret', () => {
  it('renders secret + dismiss', () => {
    const onDismiss = vi.fn();
    render(<IssuedSecret clientId="cli" hmacSecret="sek" onDismiss={onDismiss} />);
    expect(screen.getByTestId('issued-secret-value').textContent).toBe('sek');
    fireEvent.click(screen.getByTestId('dismiss-issued'));
    expect(onDismiss).toHaveBeenCalled();
  });
});
