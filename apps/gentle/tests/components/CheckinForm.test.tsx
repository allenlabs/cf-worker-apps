import { describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { CheckinForm, ToggleRow } from '~/components/CheckinForm';

const wrap = (ui: ReactElement) => <I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>;
const render = (ui: ReactElement) => {
  const result = rtlRender(wrap(ui));
  return { ...result, rerender: (next: ReactElement) => result.rerender(wrap(next)) };
};

describe('ToggleRow', () => {
  it('cycles via onChange: null → true → null', () => {
    const calls: Array<boolean | null> = [];
    const { rerender } = render(
      <ToggleRow
        label="meds"
        question="took meds?"
        value={null}
        testId="meds"
        onChange={(v) => calls.push(v)}
      />,
    );
    fireEvent.click(screen.getByTestId('meds-yes'));
    expect(calls[0]).toBe(true);

    rerender(
      <ToggleRow
        label="meds"
        question="took meds?"
        value={true}
        testId="meds"
        onChange={(v) => calls.push(v)}
      />,
    );
    // Clicking yes again should toggle off to null.
    fireEvent.click(screen.getByTestId('meds-yes'));
    expect(calls[1]).toBeNull();
  });

  it('"no" pill cycles independently of yes', () => {
    const calls: Array<boolean | null> = [];
    const { rerender } = render(
      <ToggleRow
        label="meds"
        question="took meds?"
        value={null}
        testId="meds"
        onChange={(v) => calls.push(v)}
      />,
    );
    fireEvent.click(screen.getByTestId('meds-no'));
    expect(calls[0]).toBe(false);
    rerender(
      <ToggleRow
        label="meds"
        question="took meds?"
        value={false}
        testId="meds"
        onChange={(v) => calls.push(v)}
      />,
    );
    fireEvent.click(screen.getByTestId('meds-no'));
    expect(calls[1]).toBeNull();
  });

  it('sets aria-pressed correctly', () => {
    render(
      <ToggleRow
        label="meds"
        question="took meds?"
        value={true}
        testId="meds"
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId('meds-yes').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('meds-no').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('CheckinForm', () => {
  it('hydrates from initial values', () => {
    const initial = {
      id: 1,
      userId: 1,
      entryDate: '2026-05-24',
      sleptOk: true,
      meds: false,
      ate: null,
      moved: null,
      talked: null,
      note: 'hello',
      createdAt: '2026-05-24T00:00:00Z',
      updatedAt: '2026-05-24T00:00:00Z',
    };
    render(
      <CheckinForm initial={initial} date="2026-05-24" onSubmit={() => {}} />,
    );
    expect(screen.getByTestId('slept_ok-yes').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('meds-no').getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByTestId('note-input') as HTMLTextAreaElement).value).toBe('hello');
  });

  it('submits the current state', () => {
    const onSubmit = vi.fn();
    render(<CheckinForm initial={null} date="2026-05-24" onSubmit={onSubmit} />);
    fireEvent.click(screen.getByTestId('slept_ok-yes'));
    fireEvent.click(screen.getByTestId('meds-no'));
    fireEvent.change(screen.getByTestId('note-input'), { target: { value: 'rough' } });
    fireEvent.click(screen.getByTestId('save-button'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]![0];
    expect(payload.slept_ok).toBe(true);
    expect(payload.meds).toBe(false);
    expect(payload.note).toBe('rough');
    expect(payload.date).toBe('2026-05-24');
  });

  it('shows the error + Update label when initial present', () => {
    const initial = {
      id: 1,
      userId: 1,
      entryDate: '2026-05-24',
      sleptOk: null, meds: null, ate: null, moved: null, talked: null,
      note: null,
      createdAt: '2026-05-24T00:00:00Z',
      updatedAt: '2026-05-24T00:00:00Z',
    };
    render(
      <CheckinForm initial={initial} date="2026-05-24" onSubmit={() => {}} error="boom" />,
    );
    expect(screen.getByTestId('form-error').textContent).toBe('boom');
    expect(screen.getByTestId('save-button').textContent).toBe('Update');
  });

  it('disables the button when busy', () => {
    render(
      <CheckinForm initial={null} date="2026-05-24" onSubmit={() => {}} busy />,
    );
    expect((screen.getByTestId('save-button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('save-button').textContent).toBe('Saving…');
  });
});
