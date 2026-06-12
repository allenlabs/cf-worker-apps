import { marked } from 'marked';

// Configure once.  marked.parse is synchronous when called with `async: false`.
marked.setOptions({ gfm: true, breaks: true, async: false });

// Minimal HTML sanitisation: strip <script>, on* handlers, and javascript: URLs.
// Good enough for trusted-but-not-trusted authoring inside a self-hosted tool.
function sanitize(html: string): string {
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
    .replace(/ on[a-z]+="[^"]*"/gi, '')
    .replace(/ on[a-z]+='[^']*'/gi, '')
    .replace(/javascript:/gi, 'about:blank');
}

export function renderMarkdown(input: string): string {
  if (!input) return '';
  const html = marked.parse(input) as string;
  return sanitize(html);
}

// Linkify issue refs like #123 inside plain text (for activity feed titles).
export function linkifyRefs(text: string, projectId: number): string {
  return text.replace(/#(\d+)/g, `<a class="text-redmine-600 hover:underline" href="/projects/${projectId}/issues/$1">#$1</a>`);
}
