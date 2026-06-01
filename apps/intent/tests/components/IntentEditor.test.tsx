import { describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { IntentEditor } from '~/components/IntentEditor';

const render = (ui: ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

describe('IntentEditor', () => {
  it('renders initial text', () => {
    render(<IntentEditor initialText="hello" updatedAt="" onSave={async () => {}} />);
    expect((screen.getByTestId('intent-input') as HTMLTextAreaElement).value).toBe('hello');
  });

  it('shows "never set" when updatedAt empty', () => {
    render(<IntentEditor initialText="" updatedAt="" onSave={async () => {}} />);
    expect(screen.getByTestId('intent-meta').textContent).toContain('never set');
  });

  it('shows relative ago when updatedAt set', () => {
    const t = new Date(Date.now() - 60_000).toISOString();
    render(<IntentEditor initialText="x" updatedAt={t} onSave={async () => {}} />);
    expect(screen.getByTestId('intent-meta').textContent).toContain('ago');
  });

  it('save button disabled when text unchanged', () => {
    render(<IntentEditor initialText="hello" updatedAt="" onSave={async () => {}} />);
    expect(screen.getByTestId('save-button')).toBeDisabled();
  });

  it('save button enabled when text differs', () => {
    render(<IntentEditor initialText="hello" updatedAt="" onSave={async () => {}} />);
    fireEvent.change(screen.getByTestId('intent-input'), { target: { value: 'world' } });
    expect(screen.getByTestId('save-button')).not.toBeDisabled();
  });

  it('marks unsaved label', () => {
    render(<IntentEditor initialText="hello" updatedAt="" onSave={async () => {}} />);
    fireEvent.change(screen.getByTestId('intent-input'), { target: { value: 'changed' } });
    expect(screen.getByTestId('intent-meta').textContent).toContain('unsaved');
  });

  it('calls onSave on click', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<IntentEditor initialText="hello" updatedAt="" onSave={onSave} />);
    fireEvent.change(screen.getByTestId('intent-input'), { target: { value: 'changed' } });
    fireEvent.click(screen.getByTestId('save-button'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('changed'));
  });

  it('calls onSave on blur when text differs', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<IntentEditor initialText="hello" updatedAt="" onSave={onSave} />);
    fireEvent.change(screen.getByTestId('intent-input'), { target: { value: 'changed' } });
    fireEvent.blur(screen.getByTestId('intent-input'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('changed'));
  });

  it('skips save on blur when text unchanged', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<IntentEditor initialText="hello" updatedAt="" onSave={onSave} />);
    fireEvent.blur(screen.getByTestId('intent-input'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows error on failed save', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('boom'));
    render(<IntentEditor initialText="hello" updatedAt="" onSave={onSave} />);
    fireEvent.change(screen.getByTestId('intent-input'), { target: { value: 'changed' } });
    fireEvent.click(screen.getByTestId('save-button'));
    await waitFor(() => expect(screen.getByTestId('form-error').textContent).toBe('boom'));
  });

  it('shows error on failed save (non-Error)', async () => {
    const onSave = vi.fn().mockRejectedValue('bang');
    render(<IntentEditor initialText="hello" updatedAt="" onSave={onSave} />);
    fireEvent.change(screen.getByTestId('intent-input'), { target: { value: 'changed' } });
    fireEvent.click(screen.getByTestId('save-button'));
    await waitFor(() => expect(screen.getByTestId('form-error').textContent).toBe('bang'));
  });

  it('updates char count', () => {
    render(<IntentEditor initialText="abc" updatedAt="" onSave={async () => {}} />);
    fireEvent.change(screen.getByTestId('intent-input'), { target: { value: 'abcdef' } });
    expect(screen.getByTestId('intent-editor').textContent).toContain('6/280');
  });

  it('re-syncs when initial props change', () => {
    const { rerender } = render(
      <IntentEditor initialText="one" updatedAt="" onSave={async () => {}} />,
    );
    rerender(
      <I18nProvider locale="en" dict={appDict}>
        <IntentEditor initialText="two" updatedAt="" onSave={async () => {}} />
      </I18nProvider>,
    );
    expect((screen.getByTestId('intent-input') as HTMLTextAreaElement).value).toBe('two');
  });

  it('shows Saving label during in-flight save', async () => {
    let resolve: (() => void) | null = null;
    const onSave = vi.fn().mockImplementation(
      () => new Promise<void>((r) => { resolve = r; }),
    );
    render(<IntentEditor initialText="x" updatedAt="" onSave={onSave} />);
    fireEvent.change(screen.getByTestId('intent-input'), { target: { value: 'y' } });
    fireEvent.click(screen.getByTestId('save-button'));
    await waitFor(() => expect(screen.getByTestId('save-button').textContent).toBe('Saving…'));
    resolve!();
    await waitFor(() => expect(screen.getByTestId('save-button').textContent).toBe('Save'));
  });
});
