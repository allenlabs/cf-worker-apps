import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className, ...rest }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} className={className} {...rest}>
      {children}
    </a>
  ),
}));

import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { Header } from '~/components/Header';

const render = (ui: ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

describe('Header', () => {
  it('renders the logo + search box + new link', () => {
    render(<Header />);
    expect(screen.getByTestId('header-logo')).toBeTruthy();
    expect(screen.getByTestId('header-search')).toBeTruthy();
    expect(screen.getByTestId('header-new')).toBeTruthy();
  });

  it('uses the initialQuery to populate the search box', () => {
    render(<Header initialQuery="cors" />);
    expect((screen.getByTestId('header-search') as HTMLInputElement).value).toBe('cors');
  });

  it('updates the input as the user types', () => {
    render(<Header />);
    const input = screen.getByTestId('header-search') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'docker' } });
    expect(input.value).toBe('docker');
  });

  it('focuses the search box on "/" press', () => {
    render(<Header />);
    const input = screen.getByTestId('header-search') as HTMLInputElement;
    expect(document.activeElement).not.toBe(input);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/' }));
    expect(document.activeElement).toBe(input);
  });

  it('ignores non-"/" keys', () => {
    render(<Header />);
    const input = screen.getByTestId('header-search') as HTMLInputElement;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));
    expect(document.activeElement).not.toBe(input);
  });

  it('ignores "/" when typing into another input', () => {
    render(
      <>
        <input data-testid="other" />
        <Header />
      </>,
    );
    const other = screen.getByTestId('other') as HTMLInputElement;
    other.focus();
    other.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    expect(document.activeElement).toBe(other);
  });
});
