// Pure @mention parsing, shared by the notification dispatcher. No runtime deps.

/**
 * Extract unique, lowercased @handles from free text. A handle is `@` followed
 * by letters/digits/underscore/dot/hyphen (e.g. @allen.lim, @bob_2). Returns
 * lowercased handles so callers can match case-insensitively; an empty array
 * when there are none.
 */
export function parseMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const re = /@([a-zA-Z0-9._-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.add(m[1]!.toLowerCase());
  }
  return [...out];
}
