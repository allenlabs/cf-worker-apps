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

import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { Header } from '~/components/Header';

describe('Header', () => {
  it('renders logo + nav', () => {
    render(
      <I18nProvider locale="en" dict={appDict}>
        <Header />
      </I18nProvider>,
    );
    expect(screen.getByTestId('header-logo')).toBeInTheDocument();
    expect(screen.getByTestId('nav-recent')).toBeInTheDocument();
    expect(screen.getByTestId('nav-new')).toBeInTheDocument();
  });
});
