import { describe, expect, it } from 'vitest';
import {
  PROJECT_KEY_RE,
  deriveProjectKey,
  displayName,
  formatDate,
  formatDateTime,
  formatHours,
  handle,
  issueKey,
  slugify,
  timeAgo,
} from '../../src/lib/format';

describe('formatDate', () => {
  it('returns empty for nullish input', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
  });

  it('formats a Date as YYYY-MM-DD', () => {
    expect(formatDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('treats a number as a unix-second timestamp', () => {
    const t = Math.floor(new Date(2026, 4, 21).getTime() / 1000);
    expect(formatDate(t)).toBe('2026-05-21');
  });

  it('parses an ISO string', () => {
    expect(formatDate('2026-05-21T00:00:00')).toBe('2026-05-21');
  });

  it('returns empty for invalid input', () => {
    expect(formatDate('not-a-date')).toBe('');
  });
});

describe('formatDateTime', () => {
  it('formats both date and time with zero-padding', () => {
    expect(formatDateTime(new Date(2026, 4, 21, 9, 7))).toBe('2026-05-21 09:07');
  });

  it('returns empty for nullish', () => {
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime(undefined)).toBe('');
  });

  it('returns empty for unparseable strings', () => {
    expect(formatDateTime('garbage')).toBe('');
  });

  it('handles unix-second numbers', () => {
    const t = Math.floor(new Date(2026, 4, 21, 12, 30).getTime() / 1000);
    expect(formatDateTime(t)).toBe('2026-05-21 12:30');
  });
});

describe('timeAgo', () => {
  it('returns "just now" for fresh timestamps', () => {
    expect(timeAgo(new Date())).toBe('just now');
  });

  it('uses minutes for sub-hour deltas', () => {
    const t = new Date(Date.now() - 5 * 60 * 1000);
    expect(timeAgo(t)).toBe('5 min ago');
  });

  it('uses hours for sub-day deltas', () => {
    const t = new Date(Date.now() - 3 * 60 * 60 * 1000);
    expect(timeAgo(t)).toBe('3 h ago');
  });

  it('uses days under a month', () => {
    const t = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    expect(timeAgo(t)).toBe('7 d ago');
  });

  it('falls back to formatDate beyond a month', () => {
    const t = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    expect(timeAgo(t)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns empty for nullish', () => {
    expect(timeAgo(null)).toBe('');
    expect(timeAgo(undefined)).toBe('');
  });

  it('accepts a unix-second number', () => {
    const t = Math.floor(Date.now() / 1000) - 5 * 60;
    expect(timeAgo(t)).toBe('5 min ago');
  });

  it('accepts an ISO-string date', () => {
    const t = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(timeAgo(t)).toBe('2 h ago');
  });
});

describe('formatHours', () => {
  it('drops trailing zeros', () => {
    expect(formatHours(2)).toBe('2 h');
    expect(formatHours(2.5)).toBe('2.50 h');
    expect(formatHours(2.5000001)).toBe('2.50 h');
  });

  it('returns empty for nullish', () => {
    expect(formatHours(null)).toBe('');
    expect(formatHours(undefined)).toBe('');
  });
});

describe('slugify', () => {
  it('lowercases and replaces non-alphanumerics', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
  });

  it('collapses runs of separators and trims', () => {
    expect(slugify('--a---b--')).toBe('a-b');
  });

  it('keeps digits', () => {
    expect(slugify('Project 2026')).toBe('project-2026');
  });

  it('truncates to 80 chars', () => {
    const s = slugify('x'.repeat(200));
    expect(s.length).toBeLessThanOrEqual(80);
  });

  it('returns empty for a fully-stripped string', () => {
    expect(slugify('!!!')).toBe('');
  });
});

describe('displayName', () => {
  it('prefers preferredName over everything', () => {
    expect(
      displayName({
        preferredName: 'Al',
        firstname: 'Allen',
        lastname: 'Lim',
        name: 'Allen Lim',
        username: 'allenlim',
        login: 'allen',
      }),
    ).toBe('Al');
  });

  it('falls back to firstname + lastname', () => {
    expect(displayName({ firstname: 'Allen', lastname: 'Lim' })).toBe('Allen Lim');
  });

  it('uses just firstname when lastname is blank', () => {
    expect(displayName({ firstname: 'Allen', lastname: '   ' })).toBe('Allen');
  });

  it('falls back to name when firstname/lastname are empty', () => {
    expect(displayName({ firstname: '', lastname: '', name: 'Display Name' })).toBe(
      'Display Name',
    );
  });

  it('falls back to username, then login, then email-local', () => {
    expect(displayName({ username: 'handle' })).toBe('handle');
    expect(displayName({ login: 'thelogin' })).toBe('thelogin');
    expect(displayName({ email: 'someone@example.com' })).toBe('someone');
  });

  it('returns Unknown when nothing usable is present', () => {
    expect(displayName({})).toBe('Unknown');
    expect(displayName({ preferredName: '   ', name: null, email: '' })).toBe('Unknown');
  });
});

describe('handle', () => {
  it('prefixes a non-empty username with @', () => {
    expect(handle('allenlim')).toBe('@allenlim');
  });

  it('returns empty for blank/nullish usernames', () => {
    expect(handle('')).toBe('');
    expect(handle('   ')).toBe('');
    expect(handle(null)).toBe('');
    expect(handle(undefined)).toBe('');
  });
});

describe('issueKey', () => {
  it('composes the project key and number (RED-1)', () => {
    expect(issueKey('RED', 1)).toBe('RED-1');
    expect(issueKey('BLUE', 42)).toBe('BLUE-42');
  });
});

describe('deriveProjectKey', () => {
  it('uppercases alnum and caps at 5 chars', () => {
    expect(deriveProjectKey('redmine')).toBe('REDMI');
    expect(deriveProjectKey('my-test-project')).toBe('MYTES');
  });

  it('strips leading digits and falls back to PRJ when empty', () => {
    expect(deriveProjectKey('123abc')).toBe('ABC');
    expect(deriveProjectKey('123')).toBe('PRJ');
    expect(deriveProjectKey('')).toBe('PRJ');
    expect(deriveProjectKey(null)).toBe('PRJ');
    expect(deriveProjectKey(undefined)).toBe('PRJ');
  });

  it('produces values that satisfy PROJECT_KEY_RE', () => {
    expect(PROJECT_KEY_RE.test(deriveProjectKey('redmine'))).toBe(true);
    expect(PROJECT_KEY_RE.test('RED')).toBe(true);
    expect(PROJECT_KEY_RE.test('1AB')).toBe(false); // must start with a letter
    expect(PROJECT_KEY_RE.test('TOOLONGKEYXX')).toBe(false); // > 10 chars
  });
});
