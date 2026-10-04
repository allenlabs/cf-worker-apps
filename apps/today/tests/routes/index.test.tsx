import { describe, expect, it } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import {
  ActiveFocusFooter,
  ActivityPanel,
  FocusPanel,
  HeroCard,
  InboxPanel,
  PmPanel,
  Section,
  Sparkline,
  kindLabel,
  maxHeatmap,
  sumHeatmap,
} from '~/routes/index';

function render(ui: React.ReactElement) {
  return rtlRender(
    <I18nProvider locale="en" dict={appDict}>
      {ui}
    </I18nProvider>,
  );
}
import type {
  ActiveFocusRow,
  InboxUnreadRow,
  PmAssignedRow,
  RecentActivityRow,
} from '~/server/today';

const baseActive: ActiveFocusRow = {
  id: 1,
  taskText: 'fix auth bug',
  targetMinutes: 25,
  startedAt: new Date('2026-05-24T10:00:00Z').toISOString(),
  endsAt: new Date('2026-05-24T10:25:00Z').toISOString(),
};

describe('kindLabel', () => {
  it('returns a friendly label for each kind', () => {
    expect(kindLabel('focus')).toMatch(/FOCUS/);
    expect(kindLabel('overdue')).toMatch(/OVERDUE/);
    expect(kindLabel('due-today')).toMatch(/DUE TODAY/);
    expect(kindLabel('inbox')).toMatch(/INBOX/);
  });
});

describe('sumHeatmap / maxHeatmap', () => {
  it('sums an array of minute totals', () => {
    expect(sumHeatmap([0, 25, 0, 50, 0, 0, 75])).toBe(150);
  });
  it('returns the max', () => {
    expect(maxHeatmap([0, 25, 0, 50, 0, 0, 75])).toBe(75);
  });
  it('returns 0 for an empty array', () => {
    expect(maxHeatmap([])).toBe(0);
    expect(sumHeatmap([])).toBe(0);
  });
});

describe('HeroCard', () => {
  it('renders the warm empty state when no action is available', () => {
    render(<HeroCard action={null} activeFocus={null} />);
    expect(screen.getByTestId('hero-empty')).toBeTruthy();
    expect(screen.getByText(/Quiet today/i)).toBeTruthy();
    // Always emits the ONE NEXT ACTION token so the deploy smoke probe can
    // verify the SSR shell rendered.
    expect(screen.getByTestId('hero-empty').textContent).toMatch(/ONE NEXT ACTION/);
  });

  it('renders the chosen action with kind label + CTA', () => {
    render(
      <HeroCard
        action={{ kind: 'overdue', label: 'fix login', url: 'https://example.test/x' }}
        activeFocus={null}
      />,
    );
    const hero = screen.getByTestId('hero');
    expect(hero.getAttribute('data-kind')).toBe('overdue');
    expect(hero.textContent).toMatch(/OVERDUE/);
    expect(hero.textContent).toMatch(/fix login/);
    expect((screen.getByTestId('hero-cta') as HTMLAnchorElement).href).toBe(
      'https://example.test/x',
    );
  });

  it('shows the active-focus footer when there is an active session', () => {
    const now = Date.parse('2026-05-24T10:00:00Z');
    render(
      <HeroCard
        action={{ kind: 'focus', label: baseActive.taskText, url: 'https://focus.allenlabs.org/' }}
        activeFocus={baseActive}
      />,
    );
    // The footer renders inside the hero; it sets its own testid.
    expect(screen.getByTestId('active-footer')).toBeTruthy();
    // The "ends at" timestamp should be present (clockTime renders local
    // HH:MM — the exact value depends on the runner's TZ; just assert the
    // label fragment).
    expect(screen.getByTestId('active-footer').textContent).toMatch(/ends at/);
    // Reference now to silence unused-var lint without weakening the test.
    expect(now).toBeGreaterThan(0);
  });
});

describe('ActiveFocusFooter', () => {
  it('renders M:SS remaining and the ends-at clock label', () => {
    const now = Date.parse('2026-05-24T10:00:00Z');
    const endsAt = new Date(now + 12 * 60_000 + 34 * 1000).toISOString();
    render(
      <ActiveFocusFooter
        activeFocus={{ ...baseActive, endsAt }}
        nowOverride={now}
      />,
    );
    expect(screen.getByTestId('active-footer').textContent).toMatch(/12:34/);
    expect(screen.getByTestId('active-footer').textContent).toMatch(/ends at/);
  });

  it('clamps to 0:00 once endsAt is past', () => {
    const now = Date.parse('2026-05-24T10:00:00Z');
    const endsAt = new Date(now - 60_000).toISOString();
    render(
      <ActiveFocusFooter
        activeFocus={{ ...baseActive, endsAt }}
        nowOverride={now}
      />,
    );
    expect(screen.getByTestId('active-footer').textContent).toMatch(/0:00/);
  });
});

describe('Sparkline', () => {
  it('renders one rect per day', () => {
    render(<Sparkline days={[0, 25, 50, 75, 0, 100, 25]} />);
    const svg = screen.getByTestId('sparkline');
    expect(svg.querySelectorAll('rect')).toHaveLength(7);
    // The zero day uses the dim slate fill class.
    expect(screen.getByTestId('spark-0').getAttribute('class')).toMatch(/fill-slate-700/);
    expect(screen.getByTestId('spark-5').getAttribute('class')).toMatch(/fill-amber-500/);
  });

  it('renders zero-height bars when every day is zero (no NaN heights)', () => {
    render(<Sparkline days={[0, 0, 0, 0, 0, 0, 0]} />);
    const rects = screen.getByTestId('sparkline').querySelectorAll('rect');
    for (const r of rects) {
      expect(Number(r.getAttribute('height'))).toBe(0);
    }
  });
});

describe('Section', () => {
  it('shows the badge when it is a non-zero number', () => {
    render(
      <Section title="Inbox" badge={3} testId="s">
        body
      </Section>,
    );
    const el = screen.getByTestId('s');
    expect(el.textContent).toMatch(/Inbox/);
    expect(el.textContent).toMatch(/3/);
  });

  it('hides the badge when it is zero', () => {
    render(
      <Section title="Inbox" badge={0} testId="s">
        body
      </Section>,
    );
    const summary = screen.getByTestId('s').querySelector('summary')!;
    expect(summary.textContent).toMatch(/Inbox/);
    // Zero badge should not render the small bubble.
    expect(summary.querySelectorAll('span').length).toBe(1);
  });

  it('hides the badge when omitted', () => {
    render(
      <Section title="X" testId="s">
        body
      </Section>,
    );
    const summary = screen.getByTestId('s').querySelector('summary')!;
    expect(summary.querySelectorAll('span').length).toBe(1);
  });

  it('respects defaultOpen', () => {
    render(
      <Section title="X" testId="s" defaultOpen>
        body
      </Section>,
    );
    expect((screen.getByTestId('s') as HTMLDetailsElement).open).toBe(true);
  });
});

describe('FocusPanel', () => {
  it('renders minutes + sparkline + sessions', () => {
    render(
      <FocusPanel
        focusToday={{ totalMinutes: 75, sessionCount: 3 }}
        focusHeatmap={{ days: [0, 25, 0, 50, 0, 0, 0] }}
      />,
    );
    const panel = screen.getByTestId('focus-panel');
    expect(panel.textContent).toMatch(/1 h 15 min/);
    expect(panel.textContent).toMatch(/3/);
    expect(panel.querySelector('[data-testid="sparkline"]')).toBeTruthy();
  });
});

describe('InboxPanel', () => {
  const unread: InboxUnreadRow[] = [
    { id: 1, text: 'one', capturedAt: new Date().toISOString(), source: null },
    { id: 2, text: 'two', capturedAt: new Date().toISOString(), source: null },
  ];

  it('shows the list when there are unread items', () => {
    render(<InboxPanel inboxCount={{ unread: 2 }} inboxUnread={unread} />);
    expect(screen.getByTestId('inbox-list')).toBeTruthy();
    expect(screen.getByTestId('inbox-1').textContent).toBe('one');
  });

  it('shows the "nothing unread" affordance when empty', () => {
    render(<InboxPanel inboxCount={{ unread: 0 }} inboxUnread={[]} />);
    expect(screen.queryByTestId('inbox-list')).toBeNull();
    expect(screen.getByTestId('inbox-panel').textContent).toMatch(/Nothing unread/);
  });
});

describe('PmPanel', () => {
  const issues: PmAssignedRow[] = [
    {
      id: 7,
      subject: 'fix login',
      projectIdentifier: 'web',
      projectName: 'Web',
      dueDate: '2026-05-24',
      updatedAt: new Date().toISOString(),
      statusIsClosed: false,
      statusName: 'Open',
    },
    {
      id: 8,
      subject: 'rename a thing',
      projectIdentifier: 'core',
      projectName: 'Core',
      dueDate: null,
      updatedAt: new Date().toISOString(),
      statusIsClosed: false,
      statusName: 'Open',
    },
  ];

  it('renders the assigned list with project + due labels', () => {
    render(<PmPanel pmAssigned={issues} />);
    expect(screen.getByTestId('pm-7').textContent).toMatch(/fix login/);
    expect(screen.getByTestId('pm-7').textContent).toMatch(/due 2026-05-24/);
    expect(screen.getByTestId('pm-8').textContent).toMatch(/rename a thing/);
    // No "due …" suffix for the one without a due_date.
    expect(screen.getByTestId('pm-8').textContent).not.toMatch(/due /);
  });

  it('shows the empty affordance when nothing is assigned', () => {
    render(<PmPanel pmAssigned={[]} />);
    expect(screen.getByTestId('pm-panel').textContent).toMatch(/Nothing assigned/);
    expect(screen.queryByTestId('pm-list')).toBeNull();
  });
});

describe('ActivityPanel', () => {
  const activity: RecentActivityRow[] = [
    {
      id: 1,
      title: 'commented on #42',
      kind: 'commented',
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    },
  ];

  it('renders activity entries with kind + relative time', () => {
    render(<ActivityPanel recentActivity={activity} />);
    expect(screen.getByTestId('activity-1').textContent).toMatch(/commented/);
    expect(screen.getByTestId('activity-1').textContent).toMatch(/5m ago/);
  });

  it('shows the empty affordance', () => {
    render(<ActivityPanel recentActivity={[]} />);
    expect(screen.getByTestId('activity-panel').textContent).toMatch(/No recent activity/);
  });
});
