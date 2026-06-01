import { describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';

const render = (ui: React.ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return {
    ...actual,
    useRouter: () => ({ invalidate: () => {}, navigate: () => {} }),
  };
});

import { ClientList, IssueForm, SecretBanner } from '~/routes/admin.api-clients';

describe('IssueForm', () => {
  it('calls onSubmit with the typed values', () => {
    const onSubmit = vi.fn();
    render(<IssueForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId('client-id'), { target: { value: 'cli' } });
    fireEvent.change(screen.getByTestId('client-name'), { target: { value: 'My CLI' } });
    fireEvent.click(screen.getByTestId('issue-submit'));
    expect(onSubmit).toHaveBeenCalledWith({ clientId: 'cli', name: 'My CLI' });
  });

  it('disables submit until both fields are filled', () => {
    render(<IssueForm onSubmit={() => {}} />);
    const btn = screen.getByTestId('issue-submit') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('client-id'), { target: { value: 'a' } });
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('client-name'), { target: { value: 'b' } });
    expect(btn.disabled).toBe(false);
  });

  it('disables submit when busy', () => {
    render(<IssueForm onSubmit={() => {}} busy />);
    expect((screen.getByTestId('issue-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not call onSubmit when one field is empty (and form is submitted)', () => {
    const onSubmit = vi.fn();
    render(<IssueForm onSubmit={onSubmit} />);
    fireEvent.submit(screen.getByTestId('issue-form'));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('SecretBanner', () => {
  it('shows the client id and secret', () => {
    render(<SecretBanner secret={{ clientId: 'cli', hmacSecret: 'super-secret' }} />);
    expect(screen.getByTestId('secret-client-id').textContent).toBe('cli');
    expect(screen.getByTestId('secret-hmac').textContent).toBe('super-secret');
  });
});

describe('ClientList', () => {
  it('shows the empty state when no clients', () => {
    render(<ClientList clients={[]} />);
    expect(screen.getByTestId('clients-empty')).toBeTruthy();
  });

  it('lists each client', () => {
    render(
      <ClientList
        clients={[
          { id: 1, clientId: 'cli', name: 'CLI', createdAt: '2026-05-24T09:00:00Z' },
          { id: 2, clientId: 'ext', name: 'Ext', createdAt: '2026-05-23T09:00:00Z' },
        ]}
      />,
    );
    expect(screen.getByTestId('client-1').textContent).toMatch(/cli/);
    expect(screen.getByTestId('client-2').textContent).toMatch(/ext/);
  });
});
