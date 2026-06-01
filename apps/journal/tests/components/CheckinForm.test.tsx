import { describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { CheckinForm, ScoreRow } from '~/components/CheckinForm';
import type { EntryRow } from '~/server/journal';

const render = (ui: React.ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

const baseEntry: EntryRow = {
  id: 1,
  userId: 1,
  entryDate: '2026-05-24',
  mood: 4,
  energy: 4,
  focus: 4,
  mind: 'good',
  blockers: '',
  tags: [],
  createdAt: '2026-05-24T10:00:00.000Z',
  updatedAt: '2026-05-24T10:00:00.000Z',
  source: 'web',
};

describe('ScoreRow', () => {
  it('renders buttons + invokes onChange', () => {
    const onChange = vi.fn();
    render(<ScoreRow label="mood" value={3} testId="mood" onChange={onChange} />);
    expect(screen.getByTestId('mood-3')).toBeInTheDocument();
    expect(screen.getByTestId('mood-label').textContent).toBe('meh');
    fireEvent.click(screen.getByTestId('mood-5'));
    expect(onChange).toHaveBeenCalledWith(5);
  });
});

describe('CheckinForm', () => {
  it('fresh form (initial=null) has default values', () => {
    const onSubmit = vi.fn();
    render(<CheckinForm initial={null} date="2026-05-24" onSubmit={onSubmit} />);
    fireEvent.click(screen.getByTestId('save-button'));
    expect(onSubmit).toHaveBeenCalledWith({
      mood: 3, energy: 3, focus: 3, mind: '', blockers: '', date: '2026-05-24',
    });
  });

  it('hydrates from initial entry', () => {
    const onSubmit = vi.fn();
    render(<CheckinForm initial={baseEntry} date="2026-05-24" onSubmit={onSubmit} />);
    expect(screen.getByTestId('save-button').textContent).toBe('Update');
    fireEvent.click(screen.getByTestId('save-button'));
    expect(onSubmit).toHaveBeenCalledWith({
      mood: 4, energy: 4, focus: 4, mind: 'good', blockers: '', date: '2026-05-24',
    });
  });

  it('updates mind / blockers', () => {
    const onSubmit = vi.fn();
    render(<CheckinForm initial={null} date="2026-05-24" onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId('mind-input'), { target: { value: 'feel ok' } });
    fireEvent.change(screen.getByTestId('blockers-input'), { target: { value: 'standups' } });
    fireEvent.click(screen.getByTestId('save-button'));
    expect(onSubmit).toHaveBeenCalledWith({
      mood: 3, energy: 3, focus: 3, mind: 'feel ok', blockers: 'standups', date: '2026-05-24',
    });
  });

  it('shows error + busy state', () => {
    render(<CheckinForm initial={null} date="2026-05-24" onSubmit={() => {}} busy error="boom" />);
    expect(screen.getByTestId('form-error').textContent).toBe('boom');
    expect(screen.getByTestId('save-button').textContent).toBe('Saving…');
    expect(screen.getByTestId('save-button')).toBeDisabled();
  });

  it('hydrates with nullable mind/blockers', () => {
    render(
      <CheckinForm
        initial={{ ...baseEntry, mind: null, blockers: null }}
        date="2026-05-24"
        onSubmit={() => {}}
      />,
    );
    expect((screen.getByTestId('mind-input') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByTestId('blockers-input') as HTMLTextAreaElement).value).toBe('');
  });
});
