export function formatDate(d: Date | string | number | null | undefined): string {
  if (!d) return '';
  const date = d instanceof Date ? d : typeof d === 'number' ? new Date(d * 1000) : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function formatDateTime(d: Date | string | number | null | undefined): string {
  if (!d) return '';
  const date = d instanceof Date ? d : typeof d === 'number' ? new Date(d * 1000) : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

export function timeAgo(d: Date | string | number | null | undefined): string {
  if (!d) return '';
  const date = d instanceof Date ? d : typeof d === 'number' ? new Date(d * 1000) : new Date(d);
  const ms = Date.now() - date.getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d2 = Math.floor(h / 24);
  if (d2 < 30) return `${d2} d ago`;
  return formatDate(date);
}

export function formatHours(n: number | null | undefined): string {
  if (n == null) return '';
  return `${n.toFixed(2).replace(/\.00$/, '')} h`;
}

/**
 * Resolve the display name for a person across PM. Preference order matches the
 * suite-wide convention: preferredName → name (firstname+lastname) → username →
 * login → email-local-part → 'Unknown'. Whitespace-only values are skipped.
 */
export function displayName(person: {
  preferredName?: string | null;
  firstname?: string | null;
  lastname?: string | null;
  name?: string | null;
  username?: string | null;
  login?: string | null;
  email?: string | null;
}): string {
  const pick = (v: string | null | undefined): string | null => {
    const t = (v ?? '').trim();
    return t.length > 0 ? t : null;
  };
  const fullName = pick(
    [pick(person.firstname), pick(person.lastname)].filter(Boolean).join(' ') || person.name,
  );
  return (
    pick(person.preferredName) ??
    fullName ??
    pick(person.username) ??
    pick(person.login) ??
    pick(person.email?.split('@')[0]) ??
    'Unknown'
  );
}

/** Render a @handle when a username exists, else empty string. */
export function handle(username: string | null | undefined): string {
  const u = (username ?? '').trim();
  return u ? `@${u}` : '';
}

/** Compose the Jira-style human key for an issue: `${projectKey}-${number}` (e.g. RED-1). */
export function issueKey(projectKey: string, number: number): string {
  return `${projectKey}-${number}`;
}

/**
 * Derive a default project key from a name or identifier: uppercase alnum with
 * any leading digits stripped, capped at 5 chars, falling back to 'PRJ' when
 * nothing usable remains. Keys always start with a letter so they compose
 * unambiguously into issue keys. An explicit key passed on project create takes
 * priority over this fallback.
 */
export function deriveProjectKey(source: string | null | undefined): string {
  const cleaned = (source ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^[0-9]+/, '');
  return cleaned ? cleaned.slice(0, 5) : 'PRJ';
}

/** Project key validity: 1–10 chars, starts with a letter, uppercase alnum. */
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{0,9}$/;

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
