import { describe, expect, it } from 'vitest';
import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import {
  DetailHeader,
  ImBackButton,
  LinkedEntities,
  PayloadTable,
  buildRestoreSnippet,
} from '~/routes/$id';

function render(ui: React.ReactElement) {
  return rtlRender(
    <I18nProvider locale="en" dict={appDict}>
      {ui}
    </I18nProvider>,
  );
}

const NOW = Date.parse('2026-05-24T12:00:00Z');

describe('buildRestoreSnippet', () => {
  it('returns null when neither cwd nor branch is in the payload', () => {
    expect(buildRestoreSnippet({})).toBeNull();
    expect(buildRestoreSnippet({ files: ['a'] })).toBeNull();
  });
  it('emits a plain cd when only cwd is present', () => {
    expect(buildRestoreSnippet({ cwd: '/home/me/work' })).toBe('cd /home/me/work');
  });
  it('emits a plain git switch when only branch is present', () => {
    expect(buildRestoreSnippet({ branch: 'main' })).toBe('git switch main');
  });
  it('joins cwd and branch with &&', () => {
    expect(buildRestoreSnippet({ cwd: '/home/me', branch: 'fix/auth' })).toBe(
      'cd /home/me && git switch fix/auth',
    );
  });
  it('quotes paths with spaces', () => {
    expect(buildRestoreSnippet({ cwd: '/path with space' })).toBe(`cd '/path with space'`);
  });
  it('escapes single quotes', () => {
    expect(buildRestoreSnippet({ cwd: "/path/o'connor" })).toBe(`cd '/path/o'"'"'connor'`);
  });
  it('ignores non-string cwd / branch', () => {
    expect(buildRestoreSnippet({ cwd: 42 })).toBeNull();
    expect(buildRestoreSnippet({ branch: { v: 1 } })).toBeNull();
  });
});

describe('PayloadTable', () => {
  it('renders the empty card when payload has no keys', () => {
    render(<PayloadTable payload={{}} />);
    expect(screen.getByTestId('payload-empty')).toBeTruthy();
  });

  it('renders recognised keys with curated labels in canonical order', () => {
    render(
      <PayloadTable
        payload={{
          branch: 'main',
          cwd: '/x',
          processes: ['vim', 'tmux'],
        }}
      />,
    );
    const ths = Array.from(screen.getByTestId('payload-table').querySelectorAll('th'));
    // Canonical order: cwd, branch, …, processes
    expect(ths.map((t) => t.textContent)).toEqual([
      'Working directory',
      'Git branch',
      'Processes',
    ]);
  });

  it('renders unrecognised keys (sorted) after recognised', () => {
    render(
      <PayloadTable
        payload={{
          zzz: 'last',
          aaa: 'first',
          cwd: '/x',
        }}
      />,
    );
    const ths = Array.from(screen.getByTestId('payload-table').querySelectorAll('th'));
    expect(ths.map((t) => t.textContent)).toEqual(['Working directory', 'Aaa', 'Zzz']);
  });

  it('renders an array recognised value as a list', () => {
    render(<PayloadTable payload={{ files: ['a.ts', 'b.ts'] }} />);
    const list = screen.getByTestId('list-files');
    expect(list.querySelectorAll('li').length).toBe(2);
  });

  it('renders an empty array recognised value with "(empty)"', () => {
    render(<PayloadTable payload={{ tabs: [] }} />);
    expect(screen.getByTestId('payload-tabs').textContent).toMatch(/\(empty\)/);
  });

  it('truncates long arrays after 50 items', () => {
    const files = Array.from({ length: 55 }, (_, i) => `f${i}.ts`);
    render(<PayloadTable payload={{ files }} />);
    expect(screen.getByTestId('list-files').textContent).toMatch(/\+5 more/);
  });

  it('renders unrecognised values as JSON', () => {
    render(<PayloadTable payload={{ custom: { a: 1, b: [2, 3] } }} />);
    expect(screen.getByTestId('payload-custom').textContent).toMatch(/"a": 1/);
  });
});

describe('DetailHeader', () => {
  it('renders the name + capture-time + restore label', () => {
    render(
      <DetailHeader
        snapshot={{
          id: 1,
          name: 'fixing auth',
          notes: null,
          payload: {},
          focusSessionId: null,
          pmIssueId: null,
          inboxItemId: null,
          createdAt: new Date(NOW - 60_000).toISOString(),
          restoredAt: null,
          restoredCount: 0,
        }}
        now={NOW}
      />,
    );
    const el = screen.getByTestId('detail-header');
    expect(el.textContent).toContain('fixing auth');
    expect(el.textContent).toMatch(/captured/);
    expect(el.textContent).toContain('never restored');
  });

  it('shows the last-restored time when present', () => {
    render(
      <DetailHeader
        snapshot={{
          id: 1,
          name: 'x',
          notes: null,
          payload: {},
          focusSessionId: null,
          pmIssueId: null,
          inboxItemId: null,
          createdAt: new Date(NOW - 10 * 60_000).toISOString(),
          restoredAt: new Date(NOW - 60_000).toISOString(),
          restoredCount: 1,
        }}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('detail-header').textContent).toMatch(/last restored/);
  });
});

describe('LinkedEntities', () => {
  it('renders nothing when there are no linked ids', () => {
    const { container } = render(
      <LinkedEntities
        snapshot={{ focusSessionId: null, pmIssueId: null, inboxItemId: null }}
      />,
    );
    expect(container.querySelector('[data-testid="linked-entities"]')).toBeNull();
  });

  it('renders all three when present', () => {
    render(
      <LinkedEntities
        snapshot={{ focusSessionId: 1, pmIssueId: 2, inboxItemId: 3 }}
      />,
    );
    const el = screen.getByTestId('linked-entities');
    expect(el.textContent).toMatch(/Focus session #1/);
    expect(el.textContent).toMatch(/PM issue #2/);
    expect(el.textContent).toMatch(/Inbox item #3/);
  });
});

describe('ImBackButton', () => {
  it('renders without snippet when payload has neither cwd nor branch', () => {
    let clicked = false;
    render(
      <ImBackButton
        payload={{ files: ['a'] }}
        onClick={() => {
          clicked = true;
        }}
      />,
    );
    expect(screen.queryByTestId('im-back-snippet')).toBeNull();
    fireEvent.click(screen.getByTestId('im-back-button'));
    expect(clicked).toBe(true);
  });

  it('renders a snippet preview when cwd is present', () => {
    render(
      <ImBackButton payload={{ cwd: '/x', branch: 'main' }} onClick={() => {}} />,
    );
    expect(screen.getByTestId('im-back-snippet').textContent).toMatch(/cd \/x && git switch main/);
  });

  it('honours the disabled prop', () => {
    render(<ImBackButton payload={{}} onClick={() => {}} disabled />);
    expect((screen.getByTestId('im-back-button') as HTMLButtonElement).disabled).toBe(true);
  });
});
