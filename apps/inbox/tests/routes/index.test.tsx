import { describe, expect, it } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import {
  CaptureBox,
  EmptyState,
  ItemRow,
  KEY_TO_ACTION,
  nextIndex,
} from '~/routes/index';

function render(ui: React.ReactElement) {
  return rtlRender(
    <I18nProvider locale="en" dict={appDict}>
      {ui}
    </I18nProvider>,
  );
}

describe('nextIndex', () => {
  it('clamps at lower bound', () => {
    expect(nextIndex(0, 3, -1)).toBe(0);
  });
  it('clamps at upper bound', () => {
    expect(nextIndex(2, 3, +1)).toBe(2);
  });
  it('moves forward when room', () => {
    expect(nextIndex(0, 3, +1)).toBe(1);
  });
  it('handles empty list', () => {
    expect(nextIndex(0, 0, +1)).toBe(0);
    expect(nextIndex(0, 0, -1)).toBe(0);
  });
});

describe('KEY_TO_ACTION', () => {
  it('covers the documented keys', () => {
    expect(KEY_TO_ACTION['1']).toBe('pin');
    expect(KEY_TO_ACTION['2']).toBe('refile_pm_placeholder');
    expect(KEY_TO_ACTION.d).toBe('drop');
    expect(KEY_TO_ACTION.s).toBe('snooze1d');
    expect(KEY_TO_ACTION.S).toBe('snooze1w');
    expect(KEY_TO_ACTION.u).toBe('unread');
  });
  it('does not bind j or k (those are nav, not actions)', () => {
    expect(KEY_TO_ACTION.j).toBeUndefined();
    expect(KEY_TO_ACTION.k).toBeUndefined();
  });
});

describe('CaptureBox', () => {
  it('invokes onCapture with trimmed text and clears the input', async () => {
    const { fireEvent } = await import('@testing-library/react');
    let captured: string | null = null;
    const { getByRole, getByLabelText } = render(
      <CaptureBox onCapture={(t) => { captured = t; }} />,
    );
    const input = getByLabelText('Capture') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   remember water   ' } });
    fireEvent.submit(input.closest('form')!);
    expect(captured).toBe('remember water');
    expect(input.value).toBe('');
    expect(getByRole('button', { name: /Capture/i })).toBeTruthy();
  });

  it('does nothing for whitespace-only input', async () => {
    const { fireEvent } = await import('@testing-library/react');
    let called = false;
    const { getByLabelText } = render(<CaptureBox onCapture={() => { called = true; }} />);
    const input = getByLabelText('Capture') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);
    expect(called).toBe(false);
  });
});

describe('ItemRow', () => {
  const baseItem = {
    id: 42,
    text: 'wash car',
    source: 'cli' as const,
    tags: ['errand'],
    status: 'unread' as const,
    snoozedUntil: null,
    refiledTo: null,
    capturedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  };

  it('renders text + meta + selected state', () => {
    render(<ItemRow item={baseItem} selected={true} />);
    const el = screen.getByTestId('item-42');
    expect(el.getAttribute('data-selected')).toBe('true');
    expect(el.textContent).toMatch(/wash car/);
    expect(el.textContent).toMatch(/cli/);
    expect(el.textContent).toMatch(/#errand/);
  });

  it('shows wakes label when snoozed', () => {
    render(
      <ItemRow
        item={{
          ...baseItem,
          status: 'snoozed',
          snoozedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        }}
        selected={false}
      />,
    );
    expect(screen.getByTestId('item-42').textContent).toMatch(/wakes/);
  });
});

describe('EmptyState', () => {
  it('shows the inbox-zero celebration', () => {
    render(<EmptyState />);
    expect(screen.getByTestId('inbox-zero')).toBeTruthy();
    expect(screen.getByText(/Inbox zero/i)).toBeTruthy();
  });
});
