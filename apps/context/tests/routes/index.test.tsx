import { describe, expect, it } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { EmptyState, SnapshotRowInner } from '~/routes/index';

function render(ui: React.ReactElement) {
  return rtlRender(
    <I18nProvider locale="en" dict={appDict}>
      {ui}
    </I18nProvider>,
  );
}

const NOW = Date.parse('2026-05-24T12:00:00Z');

describe('SnapshotRowInner', () => {
  it('renders name + time-ago + restore label', () => {
    render(
      <SnapshotRowInner
        snapshot={{
          id: 7,
          name: 'fixing auth',
          createdAt: new Date(NOW - 12 * 60_000).toISOString(),
          restoredAt: null,
          restoredCount: 2,
          hasCwd: true,
          hasBranch: false,
        }}
        now={NOW}
      />,
    );
    const row = screen.getByTestId('row-7');
    expect(row.textContent).toContain('fixing auth');
    expect(row.textContent).toContain('12m ago');
    expect(row.textContent).toContain('2 restores');
    expect(row.textContent).toContain('cwd');
    expect(row.textContent).not.toContain('branch');
  });

  it('shows the never-restored label when restoredCount is 0', () => {
    render(
      <SnapshotRowInner
        snapshot={{
          id: 1,
          name: 'x',
          createdAt: new Date(NOW - 60_000).toISOString(),
          restoredAt: null,
          restoredCount: 0,
          hasCwd: false,
          hasBranch: true,
        }}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('row-1').textContent).toContain('never restored');
    expect(screen.getByTestId('row-1').textContent).toContain('branch');
  });

  it('uses the snapshot id in the testid', () => {
    render(
      <SnapshotRowInner
        snapshot={{
          id: 42,
          name: 'x',
          createdAt: new Date(NOW).toISOString(),
          restoredAt: null,
          restoredCount: 0,
          hasCwd: false,
          hasBranch: false,
        }}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('row-42')).toBeTruthy();
  });
});

describe('EmptyState', () => {
  it('shows the CLI hint copy', () => {
    render(<EmptyState />);
    expect(screen.getByTestId('empty-state').textContent).toMatch(/al ctx save/);
  });
});
