import { describe, expect, it } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { Heatmap } from '~/components/Heatmap';

const render = (ui: React.ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

describe('Heatmap', () => {
  it('renders one cell per date with the right bucket', () => {
    const cells = [
      { date: '2026-05-22', score: null },
      { date: '2026-05-23', score: 8 },
      { date: '2026-05-24', score: 13 },
    ];
    render(<Heatmap cells={cells} />);
    expect(screen.getByTestId('heatmap')).toBeInTheDocument();
    expect(screen.getByTestId('heatmap-cell-2026-05-22').getAttribute('data-bucket')).toBe('0');
    expect(screen.getByTestId('heatmap-cell-2026-05-23').getAttribute('data-bucket')).toBe('2');
    expect(screen.getByTestId('heatmap-cell-2026-05-24').getAttribute('data-bucket')).toBe('4');
  });
});
