import { describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { ClientRow, NewClientForm, IssuedSecret } from '~/routes/admin.api-clients';

const render = (ui: React.ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

describe('ClientRow', () => {
  it('renders + delete', () => {
    const onDelete = vi.fn();
    render(
      <ClientRow
        client={{ clientId: 'x', name: 'X', createdAt: new Date().toISOString() }}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByTestId('delete-x'));
    expect(onDelete).toHaveBeenCalledWith('x');
  });
  it('tolerates missing onDelete', () => {
    render(
      <ClientRow client={{ clientId: 'y', name: 'Y', createdAt: new Date().toISOString() }} />,
    );
    fireEvent.click(screen.getByTestId('delete-y'));
  });
});

describe('NewClientForm', () => {
  it('disabled when fields empty', () => {
    const onSubmit = vi.fn();
    render(<NewClientForm onSubmit={onSubmit} />);
    expect(screen.getByTestId('new-client-submit')).toBeDisabled();
  });
  it('submits trimmed values', () => {
    const onSubmit = vi.fn();
    render(<NewClientForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId('new-client-id'), { target: { value: '  x  ' } });
    fireEvent.change(screen.getByTestId('new-client-name'), { target: { value: ' X ' } });
    fireEvent.click(screen.getByTestId('new-client-submit'));
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
  it('shows error', () => {
    render(<NewClientForm onSubmit={() => {}} error="boom" busy />);
    expect(screen.getByTestId('new-client-error').textContent).toBe('boom');
  });
});

describe('IssuedSecret', () => {
  it('renders + dismisses', () => {
    const onDismiss = vi.fn();
    render(<IssuedSecret clientId="x" hmacSecret="xxx" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('dismiss-issued'));
    expect(onDismiss).toHaveBeenCalled();
  });
});
