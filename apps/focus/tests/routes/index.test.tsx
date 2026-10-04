import { describe, expect, it } from 'vitest';
import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import {
  ActiveSessionView,
  Countdown,
  ReflectionView,
  StartForm,
  TodayStats,
  computeRemainingSeconds,
  ringDashOffset,
} from '~/routes/index';

function render(ui: React.ReactElement) {
  const wrap = (node: React.ReactElement) => (
    <I18nProvider locale="en" dict={appDict}>
      {node}
    </I18nProvider>
  );
  const result = rtlRender(wrap(ui));
  return {
    ...result,
    rerender: (node: React.ReactElement) => result.rerender(wrap(node)),
  };
}

describe('computeRemainingSeconds', () => {
  const NOW = 1_700_000_000_000;
  it('returns positive remaining seconds before endsAt', () => {
    const endsAt = new Date(NOW + 25 * 60_000).toISOString();
    expect(computeRemainingSeconds(endsAt, NOW)).toBe(25 * 60);
  });
  it('clamps to 0 once endsAt is past', () => {
    const endsAt = new Date(NOW - 1000).toISOString();
    expect(computeRemainingSeconds(endsAt, NOW)).toBe(0);
  });
  it('returns 0 for an invalid endsAt', () => {
    expect(computeRemainingSeconds('not-a-date', NOW)).toBe(0);
  });
});

describe('ringDashOffset', () => {
  it('clamps below 0', () => {
    expect(ringDashOffset(-1, 100)).toBe(0);
  });
  it('clamps above 1', () => {
    expect(ringDashOffset(2, 100)).toBe(100);
  });
  it('linearly interpolates', () => {
    expect(ringDashOffset(0.25, 100)).toBe(25);
  });
});

describe('StartForm', () => {
  it('submits the trimmed task + chosen minutes', () => {
    let captured: { taskText: string; targetMinutes: number; inboxItemId?: number } | null = null;
    render(
      <StartForm
        inboxSuggestions={[]}
        onStart={(input) => {
          captured = input;
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: '  fix auth  ' } });
    fireEvent.click(screen.getByRole('radio', { name: '45 min' }));
    fireEvent.submit(screen.getByTestId('start-form'));
    expect(captured).toEqual({ taskText: 'fix auth', targetMinutes: 45 });
  });

  it('pre-fills initialTaskText for cheap re-entry after an abandoned session', () => {
    render(
      <StartForm
        initialTaskText="fix auth bug"
        inboxSuggestions={[]}
        onStart={() => {}}
      />,
    );
    expect((screen.getByLabelText('Task') as HTMLInputElement).value).toBe('fix auth bug');
  });

  it('does nothing on whitespace-only input', () => {
    let called = false;
    render(
      <StartForm
        inboxSuggestions={[]}
        onStart={() => {
          called = true;
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: '   ' } });
    fireEvent.submit(screen.getByTestId('start-form'));
    expect(called).toBe(false);
  });

  it('fills the form when an inbox suggestion is clicked', () => {
    type Captured = { taskText: string; targetMinutes: number; inboxItemId?: number };
    const captured: { v: Captured | null } = { v: null };
    render(
      <StartForm
        inboxSuggestions={[
          { id: 99, text: 'refill meds' },
          { id: 100, text: 'review PR #42' },
        ]}
        onStart={(input) => {
          captured.v = input;
        }}
      />,
    );
    fireEvent.click(screen.getByText('refill meds'));
    fireEvent.submit(screen.getByTestId('start-form'));
    expect(captured.v?.taskText).toBe('refill meds');
    expect(captured.v?.inboxItemId).toBe(99);
  });

  it('truncates long inbox suggestions to 40 chars + ellipsis', () => {
    const longText = 'a'.repeat(80);
    render(
      <StartForm
        inboxSuggestions={[{ id: 1, text: longText }]}
        onStart={() => {}}
      />,
    );
    expect(screen.getByTestId('inbox-suggestions').textContent).toContain(`${'a'.repeat(40)}…`);
  });
});

describe('Countdown', () => {
  it('renders the M:SS label with frozen "now"', () => {
    const now = Date.parse('2026-05-24T10:00:00Z');
    const endsAt = new Date(now + 25 * 60_000).toISOString();
    render(<Countdown endsAt={endsAt} targetMinutes={25} nowOverride={now} />);
    expect(screen.getByTestId('countdown-mmss').textContent).toBe('25:00');
  });

  it('renders the "ends at" clock-time label', () => {
    const now = Date.parse('2026-05-24T10:00:00Z');
    const endsAt = new Date(now + 25 * 60_000).toISOString();
    render(<Countdown endsAt={endsAt} targetMinutes={25} nowOverride={now} />);
    expect(screen.getByTestId('countdown').textContent).toMatch(/ends at/);
  });

  it('handles a 0-minute target without dividing by zero', () => {
    const now = Date.parse('2026-05-24T10:00:00Z');
    render(<Countdown endsAt={new Date(now).toISOString()} targetMinutes={0} nowOverride={now} />);
    expect(screen.getByTestId('countdown-mmss').textContent).toBe('0:00');
  });
});

describe('ActiveSessionView', () => {
  const baseActive = {
    id: 1,
    taskText: 'fix auth',
    targetMinutes: 25,
    startedAt: new Date('2026-05-24T10:00:00Z').toISOString(),
    endsAt: new Date('2026-05-24T10:25:00Z').toISOString(),
    inboxItemId: null,
    pmIssueId: null,
  };

  it('shows the task text and the Done / +5 / Step away controls', () => {
    render(
      <ActiveSessionView
        active={baseActive}
        todayDistractionCount={0}
        onDistract={() => {}}
        onEnd={() => {}}
        onExtend={() => {}}
      />,
    );
    expect(screen.getByText('fix auth')).toBeTruthy();
    expect(screen.getByTestId('done-early')).toBeTruthy();
    expect(screen.getByTestId('extend')).toBeTruthy();
    expect(screen.getByTestId('step-away')).toBeTruthy();
  });

  it('does not show the wobble counter when zero', () => {
    render(
      <ActiveSessionView
        active={baseActive}
        todayDistractionCount={0}
        onDistract={() => {}}
        onEnd={() => {}}
        onExtend={() => {}}
      />,
    );
    expect(screen.queryByTestId('distractions-today')).toBeNull();
  });

  it('shows singular "1 wobble" and plural "2 wobbles"', () => {
    const { rerender } = render(
      <ActiveSessionView
        active={baseActive}
        todayDistractionCount={1}
        onDistract={() => {}}
        onEnd={() => {}}
        onExtend={() => {}}
      />,
    );
    expect(screen.getByTestId('distractions-today').textContent).toMatch(/1 wobble noted/);
    rerender(
      <ActiveSessionView
        active={baseActive}
        todayDistractionCount={2}
        onDistract={() => {}}
        onEnd={() => {}}
        onExtend={() => {}}
      />,
    );
    expect(screen.getByTestId('distractions-today').textContent).toMatch(/2 wobbles noted/);
  });

  it('opens the wobble modal and dispatches onDistract with the label', () => {
    let captured: string | null = null;
    render(
      <ActiveSessionView
        active={baseActive}
        todayDistractionCount={0}
        onDistract={(l) => {
          captured = l;
        }}
        onEnd={() => {}}
        onExtend={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('note-wobble'));
    const input = screen.getByLabelText('Wobble label') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'twitter' } });
    fireEvent.submit(input.closest('form')!);
    expect(captured).toBe('twitter');
  });

  it('does not dispatch onDistract on whitespace-only label', () => {
    let called = false;
    render(
      <ActiveSessionView
        active={baseActive}
        todayDistractionCount={0}
        onDistract={() => {
          called = true;
        }}
        onEnd={() => {}}
        onExtend={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('note-wobble'));
    const input = screen.getByLabelText('Wobble label') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);
    expect(called).toBe(false);
  });

  it('Cancel button closes the modal without dispatching', () => {
    let called = false;
    render(
      <ActiveSessionView
        active={baseActive}
        todayDistractionCount={0}
        onDistract={() => {
          called = true;
        }}
        onEnd={() => {}}
        onExtend={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('note-wobble'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByTestId('wobble-modal')).toBeNull();
    expect(called).toBe(false);
  });

  it('"Done early" fires onEnd("completed")', () => {
    let captured: string | null = null;
    render(
      <ActiveSessionView
        active={baseActive}
        todayDistractionCount={0}
        onDistract={() => {}}
        onEnd={(r) => {
          captured = r;
        }}
        onExtend={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('done-early'));
    expect(captured).toBe('completed');
  });

  it('"Step away" fires onEnd("abandoned")', () => {
    let captured: string | null = null;
    render(
      <ActiveSessionView
        active={baseActive}
        todayDistractionCount={0}
        onDistract={() => {}}
        onEnd={(r) => {
          captured = r;
        }}
        onExtend={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('step-away'));
    expect(captured).toBe('abandoned');
  });

  it('"+5 more" fires onExtend', () => {
    let extended = false;
    render(
      <ActiveSessionView
        active={baseActive}
        todayDistractionCount={0}
        onDistract={() => {}}
        onEnd={() => {}}
        onExtend={() => {
          extended = true;
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('extend'));
    expect(extended).toBe(true);
  });
});

describe('ReflectionView', () => {
  it('keeps Save disabled until a satisfaction star is picked', () => {
    let saved: { notes: string; satisfaction: number } | null = null;
    render(
      <ReflectionView
        onSave={(v) => {
          saved = v;
        }}
        onSkip={() => {}}
      />,
    );
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('star-4'));
    expect(save.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Reflection notes'), {
      target: { value: 'good run' },
    });
    fireEvent.click(save);
    expect(saved).toEqual({ notes: 'good run', satisfaction: 4 });
  });

  it('Skip fires onSkip', () => {
    let skipped = false;
    render(
      <ReflectionView
        onSave={() => {}}
        onSkip={() => {
          skipped = true;
        }}
      />,
    );
    fireEvent.click(screen.getByText('Skip'));
    expect(skipped).toBe(true);
  });

  it('uses the warm "you started" copy, not punishing language', () => {
    render(<ReflectionView onSave={() => {}} onSkip={() => {}} />);
    expect(screen.getByTestId('reflection-view').textContent).toMatch(
      /You started — that's the hard part/i,
    );
  });
});

describe('TodayStats', () => {
  it('renders focused minutes, sessions, and wobble counts', () => {
    render(
      <TodayStats
        todayFocusedMinutes={75}
        todaySessionsCount={3}
        todayDistractionCount={2}
      />,
    );
    const el = screen.getByTestId('today-stats');
    expect(el.textContent).toMatch(/1 h 15 min/);
    expect(el.textContent).toMatch(/3/);
    expect(el.textContent).toMatch(/2/);
  });
});
