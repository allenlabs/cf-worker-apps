import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className, ...rest }: {
    children: React.ReactNode;
    to: string;
    className?: string;
  }) => (
    <a href={to} className={className} {...rest}>
      {children}
    </a>
  ),
}));

import { render as rtlRender, screen } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { Header } from '~/components/Header';

const render = (ui: React.ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

describe('Header', () => {
  it('renders logo + nav', () => {
    render(<Header />);
    expect(screen.getByTestId('header-logo')).toBeInTheDocument();
    expect(screen.getByTestId('nav-today')).toBeInTheDocument();
    expect(screen.getByTestId('nav-history')).toBeInTheDocument();
  });
});
