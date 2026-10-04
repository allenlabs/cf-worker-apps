import { describe, expect, it } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { RitualCard } from '~/components/RitualCard';
import type { RitualRow } from '~/server/transition';

const render = (ui: ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

const baseRitual: RitualRow = {
  id: 1,
  userId: 1,
  leavingAt: 'state of art',
  nextStep: 'run the tests',
  mightForget: null,
  target: null,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
};

describe('RitualCard', () => {
  it('renders core fields', () => {
    render(<ul><RitualCard ritual={baseRitual} /></ul>);
    expect(screen.getByTestId('leaving-1').textContent).toBe('state of art');
    expect(screen.getByTestId('next-1').textContent).toBe('run the tests');
    expect(screen.getByTestId('target-1').textContent).toBe('kept here only');
  });
  it('renders might_forget when present', () => {
    render(<ul><RitualCard ritual={{ ...baseRitual, mightForget: 'the env var' }} /></ul>);
    expect(screen.getByTestId('forget-1').textContent).toBe('the env var');
  });
  it('hides might_forget when null', () => {
    render(<ul><RitualCard ritual={baseRitual} /></ul>);
    expect(screen.queryByTestId('forget-1')).toBeNull();
  });
  it('renders target label', () => {
    render(<ul><RitualCard ritual={{ ...baseRitual, target: 'inbox' }} /></ul>);
    expect(screen.getByTestId('target-1').textContent).toBe('→ inbox');
  });
});
