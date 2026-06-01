import { describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { RitualForm } from '~/components/RitualForm';

const render = (ui: ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

describe('RitualForm', () => {
  it('submit disabled until required fields filled', () => {
    render(<RitualForm onSubmit={async () => {}} />);
    const btn = screen.getByTestId('save-button');
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByTestId('leaving-input'), { target: { value: 'l' } });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByTestId('next-input'), { target: { value: 'n' } });
    expect(btn).not.toBeDisabled();
  });

  it('submits a minimal payload', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<RitualForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId('leaving-input'), { target: { value: 'l' } });
    fireEvent.change(screen.getByTestId('next-input'), { target: { value: 'n' } });
    fireEvent.click(screen.getByTestId('save-button'));
    expect(onSubmit).toHaveBeenCalledWith({
      leaving_at: 'l',
      next_step: 'n',
      might_forget: null,
      target: null,
    });
  });

  it('passes might_forget + target', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<RitualForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId('leaving-input'), { target: { value: 'l' } });
    fireEvent.change(screen.getByTestId('next-input'), { target: { value: 'n' } });
    fireEvent.change(screen.getByTestId('forget-input'), { target: { value: 'f' } });
    fireEvent.change(screen.getByTestId('target-select'), { target: { value: 'inbox' } });
    fireEvent.click(screen.getByTestId('save-button'));
    expect(onSubmit).toHaveBeenCalledWith({
      leaving_at: 'l',
      next_step: 'n',
      might_forget: 'f',
      target: 'inbox',
    });
  });

  it('ignores submit when required fields blank', () => {
    const onSubmit = vi.fn();
    render(<RitualForm onSubmit={onSubmit} />);
    fireEvent.submit(screen.getByTestId('ritual-form'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows error + busy', () => {
    render(<RitualForm onSubmit={async () => {}} busy error="boom" />);
    expect(screen.getByTestId('form-error').textContent).toBe('boom');
    expect(screen.getByTestId('save-button').textContent).toBe('Saving…');
  });

  it('clears target back to empty', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<RitualForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId('leaving-input'), { target: { value: 'l' } });
    fireEvent.change(screen.getByTestId('next-input'), { target: { value: 'n' } });
    fireEvent.change(screen.getByTestId('target-select'), { target: { value: 'inbox' } });
    fireEvent.change(screen.getByTestId('target-select'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('save-button'));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ target: null }));
  });
});
