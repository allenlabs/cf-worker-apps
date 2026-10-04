import { describe, expect, it } from 'vitest';
import { linkifyRefs, renderMarkdown } from '../../src/server/markdown';

describe('renderMarkdown', () => {
  it('returns empty for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('renders headings and emphasis', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** text.');
    expect(html).toContain('<h1');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('strips <script> tags', () => {
    const html = renderMarkdown('Hello\n\n<script>alert(1)</script>\n\nworld');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  it('strips inline event handlers', () => {
    const html = renderMarkdown('<img src=x onerror="boom()">');
    expect(html).not.toMatch(/onerror=/i);
  });

  it('neutralises javascript: URLs', () => {
    const html = renderMarkdown('[click](javascript:steal())');
    expect(html.toLowerCase()).not.toContain('javascript:');
  });

  it('strips <style> blocks', () => {
    const html = renderMarkdown('<style>body{display:none}</style>\n\nok');
    expect(html).not.toContain('<style');
  });

  it('preserves fenced code blocks', () => {
    const html = renderMarkdown('```\nconst x = 1;\n```');
    expect(html).toContain('<code');
    expect(html).toContain('const x = 1');
  });
});

describe('linkifyRefs', () => {
  it('turns "#123" into an issue link', () => {
    const out = linkifyRefs('fixed in #123', 7);
    expect(out).toContain('/projects/7/issues/123');
    expect(out).toContain('>#123<');
  });

  it('handles multiple refs', () => {
    const out = linkifyRefs('see #1 and #22', 1);
    expect(out.match(/href=/g)?.length).toBe(2);
  });

  it('passes through plain text untouched', () => {
    expect(linkifyRefs('no refs here', 1)).toBe('no refs here');
  });
});
