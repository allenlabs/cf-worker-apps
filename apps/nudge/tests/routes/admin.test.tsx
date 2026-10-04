import { describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { ClientRow, NewClientForm, IssuedSecret } from '~/routes/admin.api-clients';

const render = (ui: React.ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

describe('ClientRow', () => {
  it('renders + calls onDelete', () => {
    const onDelete = vi.fn();
    render(
      <ClientRow
        client={{ clientId: 'ext-1', name: 'Ext', createdAt: new Date().toISOString() }}
        onDelete={onDelete}
      />,
    );
    expect(screen.getByText('ext-1')).toBeInTheDocument();
    expect(screen.getByText('Ext')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('delete-ext-1'));
    expect(onDelete).toHaveBeenCalledWith('ext-1');
  });

  it('tolerates missing onDelete', () => {
    render(
      <ClientRow client={{ clientId: 'x', name: 'X', createdAt: new Date().toISOString() }} />,
    );
    fireEvent.click(screen.getByTestId('delete-x'));
  });
});

describe('NewClientForm', () => {
  it('requires both fields to enable submit', () => {
    const onSubmit = vi.fn();
    render(<NewClientForm onSubmit={onSubmit} />);
    const submit = screen.getByTestId('new-client-submit');
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId('new-client-id'), { target: { value: 'x' } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId('new-client-name'), { target: { value: 'X' } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith('x', 'X');
  });

  it('blocks submit on whitespace-only', () => {
    const onSubmit = vi.fn();
    render(<NewClientForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId('new-client-id'), { target: { value: '   ' } });
    fireEvent.change(screen.getByTestId('new-client-name'), { target: { value: '   ' } });
    fireEvent.submit(screen.getByTestId('new-client-form'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows error + busy state', () => {
    render(<NewClientForm onSubmit={() => {}} busy error="boom" />);
    expect(screen.getByTestId('new-client-error').textContent).toBe('boom');
    expect(screen.getByTestId('new-client-submit').textContent).toBe('Issuing…');
  });
});

describe('IssuedSecret', () => {
  it('renders + dismisses', () => {
    const onDismiss = vi.fn();
    render(<IssuedSecret clientId="x" hmacSecret="secret-value-xyz" onDismiss={onDismiss} />);
    expect(screen.getByTestId('issued-secret-value').textContent).toBe('secret-value-xyz');
    fireEvent.click(screen.getByTestId('dismiss-issued'));
    expect(onDismiss).toHaveBeenCalled();
  });
});
