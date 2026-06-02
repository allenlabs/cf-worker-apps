// Phase 14: client-side page export (Markdown + HTML).
//
// HTML  — the page snapshot wrapped in a minimal standalone document.
// Markdown — the snapshot HTML converted with turndown (MIT), with a small
//            GFM-ish extension for task-list checkboxes (the editor emits
//            <ul data-type="taskList"><li><input type=checkbox>…</li></ul>).
//
// Both trigger a browser download via a Blob + a transient <a download>.

import TurndownService from 'turndown';

/** Slugify a title into a safe filename stem (fallback "page"). */
function safeFileStem(title: string): string {
  const stem = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '') // strip path/illegal chars
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    .trim();
  return stem || 'page';
}

/** Wrap snapshot HTML in a minimal, self-contained HTML document. */
export function buildHtmlDocument(title: string, snapshotHtml: string): string {
  const safeTitle = title.trim() || 'Untitled';
  const escaped = safeTitle
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaped}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #111; }
  pre { background: #f5f5f5; padding: 1rem; border-radius: 6px; overflow: auto; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  blockquote { border-left: 3px solid #ddd; margin: 0; padding-left: 1rem; color: #555; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; } td, th { border: 1px solid #ddd; padding: 4px 8px; }
</style>
</head>
<body>
<h1>${escaped}</h1>
${snapshotHtml}
</body>
</html>
`;
}

/** Build a turndown instance configured for the editor's common blocks. */
function makeTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  // Task-list checkboxes: the editor renders
  //   <ul data-type="taskList"><li data-checked="true|false">…</li></ul>.
  // Detect via the parent <ul data-type="taskList"> + the li's own data-checked
  // attribute (NOT querySelector — turndown's bundled DOM matches querySelector
  // across the detached fragment, so it false-positives on plain lists). Emit
  // GitHub-style "- [ ] " / "- [x] " items.
  const isTaskItem = (node: HTMLElement): boolean => {
    if (node.nodeName !== 'LI') return false;
    const parent = node.parentNode as HTMLElement | null;
    return parent?.getAttribute?.('data-type') === 'taskList';
  };
  td.addRule('taskListItems', {
    filter: (node) => isTaskItem(node as HTMLElement),
    replacement: (content, node) => {
      const checked = (node as HTMLElement).getAttribute('data-checked') === 'true';
      const text = content.replace(/^\s*\n+/, '').replace(/\n+\s*$/, '').trim();
      return `- ${checked ? '[x]' : '[ ]'} ${text}\n`;
    },
  });
  return td;
}

/** Convert snapshot HTML to Markdown, prefixed with the title as an H1. */
export function htmlToMarkdown(title: string, snapshotHtml: string): string {
  const td = makeTurndown();
  const body = td.turndown(snapshotHtml || '');
  const heading = `# ${title.trim() || 'Untitled'}`;
  return body ? `${heading}\n\n${body}\n` : `${heading}\n`;
}

/** Trigger a browser download of `content` as `filename` with the given MIME. */
export function downloadFile(filename: string, content: string, mime: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Export the page as a downloaded .html file. */
export function exportPageHtml(title: string, snapshotHtml: string): void {
  downloadFile(`${safeFileStem(title)}.html`, buildHtmlDocument(title, snapshotHtml), 'text/html');
}

/** Export the page as a downloaded .md file. */
export function exportPageMarkdown(title: string, snapshotHtml: string): void {
  downloadFile(
    `${safeFileStem(title)}.md`,
    htmlToMarkdown(title, snapshotHtml),
    'text/markdown',
  );
}
