import { describe, expect, it } from 'vitest';
import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import {
  DayDetail,
  Heatmap,
  heatmapCellClass,
  intensityBucket,
} from '~/routes/history';

function render(ui: React.ReactElement) {
  return rtlRender(
    <I18nProvider locale="en" dict={appDict}>
      {ui}
    </I18nProvider>,
  );
}

describe('intensityBucket', () => {
  it('returns 0 for zero/negative minutes', () => {
    expect(intensityBucket(0)).toBe(0);
    expect(intensityBucket(-3)).toBe(0);
  });
  it('maps 1-15 to bucket 1', () => {
    expect(intensityBucket(1)).toBe(1);
    expect(intensityBucket(15)).toBe(1);
  });
  it('maps 16-30 to bucket 2', () => {
    expect(intensityBucket(16)).toBe(2);
    expect(intensityBucket(30)).toBe(2);
  });
  it('maps 31-60 to bucket 3', () => {
    expect(intensityBucket(31)).toBe(3);
    expect(intensityBucket(60)).toBe(3);
  });
  it('maps 61+ to bucket 4', () => {
    expect(intensityBucket(61)).toBe(4);
    expect(intensityBucket(360)).toBe(4);
  });
});

describe('heatmapCellClass', () => {
  it('returns a distinct class per bucket', () => {
    const classes = ([0, 1, 2, 3, 4] as const).map(heatmapCellClass);
    expect(new Set(classes).size).toBe(5);
  });
});

describe('Heatmap', () => {
  const days = Array.from({ length: 90 }, (_, i) => ({
    date: `2026-05-${String((i % 28) + 1).padStart(2, '0')}`,
    minutes: i % 5 === 0 ? 45 : 0,
    sessions: i % 5 === 0 ? 2 : 0,
  }));

  it('renders one rect per day', () => {
    const { container } = render(<Heatmap days={days} onSelectDay={() => {}} />);
    expect(container.querySelectorAll('rect').length).toBe(90);
  });

  it('clicking a cell fires onSelectDay with the ISO date', () => {
    let picked: string | null = null;
    render(
      <Heatmap
        days={[
          { date: '2026-05-24', minutes: 25, sessions: 1 },
          { date: '2026-05-25', minutes: 0, sessions: 0 },
        ]}
        onSelectDay={(d) => {
          picked = d;
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('cell-2026-05-24'));
    expect(picked).toBe('2026-05-24');
  });

  it('annotates the title with minutes + session count', () => {
    render(
      <Heatmap
        days={[{ date: '2026-05-24', minutes: 75, sessions: 3 }]}
        onSelectDay={() => {}}
      />,
    );
    const cell = screen.getByTestId('cell-2026-05-24');
    expect(cell.querySelector('title')?.textContent).toMatch(/1 h 15 min/);
    expect(cell.querySelector('title')?.textContent).toMatch(/3 sessions/);
  });

  it('singular vs plural sessions in the title', () => {
    render(
      <Heatmap
        days={[{ date: '2026-05-24', minutes: 25, sessions: 1 }]}
        onSelectDay={() => {}}
      />,
    );
    expect(screen.getByTestId('cell-2026-05-24').querySelector('title')?.textContent).toMatch(
      /1 session\b/,
    );
  });
});

describe('DayDetail', () => {
  const baseRow = {
    id: 1,
    taskText: 'fix auth',
    targetMinutes: 25,
    startedAt: new Date('2026-05-24T10:00:00Z').toISOString(),
    endedAt: new Date('2026-05-24T10:25:00Z').toISOString(),
    endedReason: 'completed' as const,
    notes: null,
    satisfaction: null,
    inboxItemId: null,
    pmIssueId: null,
    distractionCount: 0,
  };

  it('renders the celebratory empty state when no sessions', () => {
    render(<DayDetail day="2026-05-24" sessions={[]} />);
    expect(screen.getByTestId('day-empty').textContent).toMatch(/That's allowed/);
  });

  it('renders a session row with task text + ended reason badge', () => {
    render(<DayDetail day="2026-05-24" sessions={[baseRow]} />);
    expect(screen.getByText('fix auth')).toBeTruthy();
    expect(screen.getByText('completed')).toBeTruthy();
  });

  it('renders the satisfaction stars + wobble count when present', () => {
    render(
      <DayDetail
        day="2026-05-24"
        sessions={[{ ...baseRow, satisfaction: 4, distractionCount: 2, notes: 'great' }]}
      />,
    );
    const el = screen.getByTestId('day-detail');
    expect(el.textContent).toMatch(/★★★★/);
    expect(el.textContent).toMatch(/2 wobbles/);
    expect(el.textContent).toMatch(/great/);
  });

  it('renders the singular "1 wobble" form', () => {
    render(
      <DayDetail
        day="2026-05-24"
        sessions={[{ ...baseRow, distractionCount: 1 }]}
      />,
    );
    expect(screen.getByTestId('day-detail').textContent).toMatch(/1 wobble\b/);
  });

  it('renders abandoned with a neutral badge (no shame)', () => {
    render(
      <DayDetail
        day="2026-05-24"
        sessions={[{ ...baseRow, endedReason: 'abandoned' }]}
      />,
    );
    expect(screen.getByText('abandoned')).toBeTruthy();
  });

  it('renders extended with the focus-tone badge', () => {
    render(
      <DayDetail
        day="2026-05-24"
        sessions={[{ ...baseRow, endedReason: 'extended' }]}
      />,
    );
    expect(screen.getByText('extended')).toBeTruthy();
  });

  it('renders "in progress" when endedReason is null', () => {
    render(
      <DayDetail
        day="2026-05-24"
        sessions={[{ ...baseRow, endedReason: null, endedAt: null }]}
      />,
    );
    expect(screen.getByText('in progress')).toBeTruthy();
  });
});
