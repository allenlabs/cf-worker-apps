import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
  createFileRoute: () => () => ({ Route: { useLoaderData: () => null } }),
}));

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({ handler: () => () => Promise.resolve(null) }),
}));

import { render, screen } from '@testing-library/react';
import { StatTile } from '~/routes/history';

describe('StatTile', () => {
  it('renders label + value', () => {
    render(<StatTile label="avg mood" value="3.5" />);
    expect(screen.getByTestId('stat-avg mood').textContent).toContain('avg mood');
    expect(screen.getByTestId('stat-avg mood').textContent).toContain('3.5');
  });
});
