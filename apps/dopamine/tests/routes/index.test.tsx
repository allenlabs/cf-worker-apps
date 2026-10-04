import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
  createFileRoute: () => () => ({ Route: { useLoaderData: () => null } }),
  useRouter: () => ({ invalidate: () => {} }),
}));

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({
    inputValidator: () => ({ handler: () => () => Promise.resolve(null) }),
    handler: () => () => Promise.resolve(null),
  }),
}));

vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => null,
}));

import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { EmptyFeed, RandomWinPanel } from '~/routes/index';
import type { EventRow } from '~/server/dopamine';

const render = (ui: ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

describe('EmptyFeed', () => {
  it('renders empty copy', () => {
    render(<EmptyFeed />);
    expect(screen.getByTestId('empty-feed').textContent).toContain('No wins captured yet');
  });
});

describe('RandomWinPanel', () => {
  const event: EventRow = {
    id: 1,
    userId: 1,
    kind: 'pr_merged',
    title: 'won',
    body: 'context',
    sourceRef: null,
    importance: 1,
    tags: [],
    occurredAt: new Date().toISOString(),
  };

  it('shows empty state initially', () => {
    render(<RandomWinPanel highlight={null} onClick={() => {}} />);
    expect(screen.getByTestId('random-empty')).toBeInTheDocument();
    expect(screen.getByTestId('random-button').textContent).toBe('pick one');
  });
  it('shows highlight', () => {
    render(<RandomWinPanel highlight={event} onClick={() => {}} />);
    expect(screen.getByTestId('random-highlight').textContent).toContain('won');
    expect(screen.getByTestId('random-highlight').textContent).toContain('context');
    expect(screen.getByTestId('random-button').textContent).toBe('another');
  });
  it('handles body=null', () => {
    render(<RandomWinPanel highlight={{ ...event, body: null }} onClick={() => {}} />);
    expect(screen.getByTestId('random-highlight').textContent).toContain('won');
  });
  it('busy state', () => {
    render(<RandomWinPanel highlight={null} onClick={() => {}} busy />);
    expect(screen.getByTestId('random-button')).toBeDisabled();
    expect(screen.getByTestId('random-button').textContent).toBe('thinking…');
  });
  it('click fires handler', () => {
    const onClick = vi.fn();
    render(<RandomWinPanel highlight={null} onClick={onClick} />);
    fireEvent.click(screen.getByTestId('random-button'));
    expect(onClick).toHaveBeenCalled();
  });
});
