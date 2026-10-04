// Phase 14 unit tests for the client-side export helpers (pure string/DOM work,
// no browser needed — turndown bundles its own HTML parser).

import { describe, it, expect } from 'vitest';
import { buildHtmlDocument, htmlToMarkdown } from '~/lib/export';

describe('buildHtmlDocument', () => {
  it('wraps the snapshot in a standalone doc with an escaped title', () => {
    const doc = buildHtmlDocument('Hi <there> & you', '<p>body</p>');
    expect(doc).toContain('<!doctype html>');
    expect(doc).toContain('<title>Hi &lt;there&gt; &amp; you</title>');
    expect(doc).toContain('<h1>Hi &lt;there&gt; &amp; you</h1>');
    expect(doc).toContain('<p>body</p>');
  });

  it('falls back to Untitled for an empty title', () => {
    expect(buildHtmlDocument('   ', '<p>x</p>')).toContain('<title>Untitled</title>');
  });
});

describe('htmlToMarkdown', () => {
  it('prefixes the title as an H1 and converts common blocks', () => {
    const md = htmlToMarkdown('My Page', '<h2>Section</h2><p>Hello <strong>world</strong></p>');
    expect(md.startsWith('# My Page')).toBe(true);
    expect(md).toContain('## Section');
    expect(md).toContain('**world**');
  });

  it('converts links and bullet lists', () => {
    const md = htmlToMarkdown('T', '<ul><li>one</li><li>two</li></ul><p><a href="https://x.com">link</a></p>');
    expect(md).toContain('-   one');
    expect(md).toContain('[link](https://x.com)');
  });

  it('renders task-list checkboxes as GFM checkboxes', () => {
    const html =
      '<ul data-type="taskList">' +
      '<li data-checked="true"><label><input type="checkbox" checked></label><div>done</div></li>' +
      '<li data-checked="false"><label><input type="checkbox"></label><div>todo</div></li>' +
      '</ul>';
    const md = htmlToMarkdown('T', html);
    expect(md).toContain('[x] done');
    expect(md).toContain('[ ] todo');
  });

  it('handles empty content (just the title heading)', () => {
    expect(htmlToMarkdown('Only Title', '')).toBe('# Only Title\n');
  });
});
