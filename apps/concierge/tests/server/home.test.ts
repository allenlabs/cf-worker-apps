import { describe, expect, it } from 'vitest';
import { insertPmUser, makeTestDb } from '../_setup/db';
import { loadHomeImpl } from '~/server/home';
import { insertNudgeImpl, setPreferencesImpl } from '~/server/concierge';

describe('loadHomeImpl', () => {
  it('returns null when sub is missing', async () => {
    const db = await makeTestDb();
    expect(await loadHomeImpl(db, null)).toBeNull();
  });

  it('returns null when sub does not map to pm.users', async () => {
    const db = await makeTestDb();
    expect(await loadHomeImpl(db, 'unknown')).toBeNull();
  });

  it('returns me + nudges + preferences in one round-trip', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    await setPreferencesImpl(db, u.id, {
      enabled: true,
      cadenceMinutes: 120,
      quietStart: 22 * 60,
      quietEnd: 6 * 60,
    });
    await insertNudgeImpl(
      db,
      { userId: u.id, topic: 'open-thread', question: 'a', channels: ['today'] },
      new Date(2026, 0, 1),
    );
    await insertNudgeImpl(
      db,
      { userId: u.id, topic: 'open-thread', question: 'b', channels: ['push', 'today'] },
      new Date(2026, 0, 2),
    );

    const home = await loadHomeImpl(db, 'sso-alice');
    expect(home?.me.login).toBe('alice');
    expect(home?.preferences.cadenceMinutes).toBe(120);
    expect(home?.preferences.quietStart).toBe(22 * 60);
    expect(home?.nudges.map((n) => n.question)).toEqual(['b', 'a']);
    expect(home?.nudges[0]!.channels).toEqual(['push', 'today']);
  });

  it('falls back to default preferences when no row exists', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    const home = await loadHomeImpl(db, 'sso-alice');
    expect(home?.preferences.userId).toBe(u.id);
    expect(home?.preferences.enabled).toBe(true);
    expect(home?.preferences.cadenceMinutes).toBe(240);
  });

  it('honours a custom limit', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    for (let i = 0; i < 5; i++) {
      await insertNudgeImpl(db, {
        userId: u.id,
        topic: 'open-thread',
        question: `q${i}`,
        channels: [],
      });
    }
    const home = await loadHomeImpl(db, 'sso-alice', 2);
    expect(home?.nudges.length).toBe(2);
  });

  it('clamps limit to a sane range', async () => {
    const db = await makeTestDb();
    await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    expect(Array.isArray((await loadHomeImpl(db, 'sso-alice', 0))?.nudges)).toBe(true);
    expect(Array.isArray((await loadHomeImpl(db, 'sso-alice', 9999))?.nudges)).toBe(true);
  });

  it('preferences round-trip with null quietStart/quietEnd', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    await setPreferencesImpl(db, u.id, {
      enabled: true,
      cadenceMinutes: 60,
      quietStart: null,
      quietEnd: null,
    });
    const home = await loadHomeImpl(db, 'sso-alice');
    expect(home?.preferences.quietStart).toBeNull();
    expect(home?.preferences.quietEnd).toBeNull();
    expect(home?.preferences.cadenceMinutes).toBe(60);
  });

  it('returns all-null optional timestamps for a fresh nudge', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    await insertNudgeImpl(db, {
      userId: u.id,
      topic: 'open-thread',
      question: 'q',
      channels: [],
    });
    const home = await loadHomeImpl(db, 'sso-alice');
    expect(home?.nudges[0]!.openedAt).toBeNull();
    expect(home?.nudges[0]!.dismissedAt).toBeNull();
    expect(home?.nudges[0]!.repliedAt).toBeNull();
  });

  it('parses every channel value through the home loader', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    await insertNudgeImpl(db, {
      userId: u.id,
      topic: 'open-thread',
      question: 'q',
      channels: ['push', 'today', 'email'],
    });
    const home = await loadHomeImpl(db, 'sso-alice');
    expect(home?.nudges[0]!.channels).toEqual(['push', 'today', 'email']);
  });
});
