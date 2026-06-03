// Unit tests for the Phase 17 automations.ts impls: the webhook URL guard,
// action normalization, server-side action execution (edit_property / add_page /
// send_notification / send_webhook), trigger matching, the schedule next-run
// math, and the CRUD impls. Driven by the same fake `Sql` tagged-template the
// other handler tests use.

import { describe, it, expect, vi } from 'vitest';
import {
  isSafeWebhookUrl,
  normalizeServerAction,
  runActionsImpl,
  triggerMatchesPropertyEdit,
  computeFirstRun,
  advanceSchedule,
  runDatabaseTriggerImpl,
  createAutomationImpl,
  updateAutomationImpl,
  setEnabledImpl,
  deleteAutomationImpl,
  listAutomationsImpl,
  dueScheduledAutomationsImpl,
  runScheduledAutomationsImpl,
  type ActionDeps,
} from '@api/handlers/automations';
import type { Sql } from '@api/lib/db';

interface Call {
  text: string;
  params: unknown[];
}
function fakeSql(responder: (text: string, params: unknown[]) => unknown[]): {
  sql: Sql;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn = ((first: unknown, ...params: unknown[]) => {
    // postgres.js dual-call: tagged template (TemplateStringsArray) OR the
    // `sql(obj, ...cols)` assignment helper (a plain object). The latter is an
    // interpolation inside an UPDATE … SET ${sql(assign, ...)} — return a marker.
    if (!Array.isArray(first) || !(first as { raw?: unknown }).raw) {
      return { __assign: first, cols: params };
    }
    const strings = first as unknown as TemplateStringsArray;
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ text, params });
    return Promise.resolve(responder(text, params));
  }) as unknown as Sql & { json: (v: unknown) => unknown };
  // postgres.js `sql.json(...)` + `sql(obj, ...cols)` helpers used by impls.
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => ({ __json: v });
  return { sql: fn as Sql, calls };
}

const D1 = '11111111-1111-1111-1111-111111111111';
const ROW = '22222222-2222-2222-2222-222222222222';

function deps(fetcher?: typeof fetch): ActionDeps {
  return { fetcher: fetcher ?? (vi.fn() as unknown as typeof fetch) };
}

describe('isSafeWebhookUrl', () => {
  it('allows public http(s) URLs', () => {
    expect(isSafeWebhookUrl('https://example.com/hook')).toBe(true);
    expect(isSafeWebhookUrl('http://1.2.3.4/x')).toBe(true);
    expect(isSafeWebhookUrl('https://hooks.slack.com/services/abc')).toBe(true);
  });
  it('rejects non-http(s) schemes', () => {
    expect(isSafeWebhookUrl('ftp://example.com')).toBe(false);
    expect(isSafeWebhookUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeWebhookUrl('not a url')).toBe(false);
  });
  it('rejects loopback / private / link-local / metadata', () => {
    expect(isSafeWebhookUrl('http://localhost/x')).toBe(false);
    expect(isSafeWebhookUrl('http://127.0.0.1/x')).toBe(false);
    expect(isSafeWebhookUrl('http://10.0.0.5/x')).toBe(false);
    expect(isSafeWebhookUrl('http://192.168.1.1/x')).toBe(false);
    expect(isSafeWebhookUrl('http://172.16.0.1/x')).toBe(false);
    expect(isSafeWebhookUrl('http://172.31.255.255/x')).toBe(false);
    expect(isSafeWebhookUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isSafeWebhookUrl('http://[::1]/x')).toBe(false);
    expect(isSafeWebhookUrl('http://metadata.google.internal/x')).toBe(false);
    expect(isSafeWebhookUrl('http://0.0.0.0/x')).toBe(false);
    expect(isSafeWebhookUrl('http://224.0.0.1/x')).toBe(false);
  });
  it('allows 172.x outside the private 16-31 band', () => {
    expect(isSafeWebhookUrl('http://172.32.0.1/x')).toBe(true);
    expect(isSafeWebhookUrl('http://172.15.0.1/x')).toBe(true);
  });
});

describe('normalizeServerAction', () => {
  it('maps button-block names to server names', () => {
    expect(normalizeServerAction({ kind: 'edit_pages', propertyId: 'p', value: 1 })).toMatchObject({
      kind: 'edit_property',
      propertyId: 'p',
    });
    expect(normalizeServerAction({ kind: 'add_page_to_db', databaseId: D1 })).toMatchObject({
      kind: 'add_page_to',
      databaseId: D1,
    });
  });
  it('drops client-only + invalid actions', () => {
    expect(normalizeServerAction({ kind: 'show_confirm', message: '?' })).toBeNull();
    expect(normalizeServerAction({ kind: 'insert_blocks', blocks: [] })).toBeNull();
    expect(normalizeServerAction({ kind: 'open_page', pageId: 'p' })).toBeNull();
    expect(normalizeServerAction({ kind: 'edit_property' })).toBeNull(); // no propertyId
    expect(normalizeServerAction(null)).toBeNull();
  });
});

describe('runActionsImpl', () => {
  it('edit_property on the current row updates that row only', async () => {
    const { sql, calls } = fakeSql(() => [{ id: ROW }]);
    const res = await runActionsImpl(sql, deps(), {
      databaseId: D1,
      rowId: ROW,
      actions: [{ kind: 'edit_pages', propertyId: 'prop1', value: 'done', currentRowOnly: true }],
      actorEmail: 'a@x.com',
    });
    expect(res.ran).toBe(1);
    // updateRowImpl issues an UPDATE editor.pages on the row.
    expect(calls.some((c) => c.text.includes('UPDATE editor.pages') && c.params.includes(ROW))).toBe(true);
  });

  it('edit_property without currentRowOnly edits all rows of the DB', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT id FROM editor.pages')) return [{ id: 'r1' }, { id: 'r2' }];
      return [{ id: 'r1' }];
    });
    const res = await runActionsImpl(sql, deps(), {
      databaseId: D1,
      actions: [{ kind: 'edit_property', propertyId: 'p', value: 1, currentRowOnly: false }],
      actorEmail: 'a@x.com',
    });
    expect(res.ran).toBe(1);
    expect(calls.some((c) => c.text.includes('SELECT id FROM editor.pages'))).toBe(true);
  });

  it('add_page_to creates a row + sets preset props', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT workspace_id')) return [{ workspaceId: 'ws1' }];
      if (text.includes('INSERT INTO editor.pages')) return [{ id: 'newrow', title: 'X' }];
      return [{ id: 'newrow' }];
    });
    const res = await runActionsImpl(sql, deps(), {
      databaseId: D1,
      actions: [{ kind: 'add_page_to', databaseId: D1, title: 'X', props: { p: 'v' } }],
      actorEmail: 'a@x.com',
      actorId: 'u1',
    });
    expect(res.ran).toBe(1);
    expect(calls.some((c) => c.text.includes('INSERT INTO editor.pages'))).toBe(true);
  });

  it('send_notification inserts one notification per recipient', async () => {
    const { sql, calls } = fakeSql(() => [{ id: 'n1' }]);
    const res = await runActionsImpl(sql, deps(), {
      databaseId: D1,
      actions: [{ kind: 'send_notification', recipients: ['a@x.com', 'b@x.com'], body: 'hi' }],
      actorEmail: 'sys@x.com',
    });
    expect(res.ran).toBe(1);
    const inserts = calls.filter((c) => c.text.includes('INSERT INTO editor.notifications'));
    expect(inserts).toHaveLength(2);
  });

  it('send_webhook POSTs to a safe URL + records an error on an unsafe one', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('ok'));
    const { sql } = fakeSql(() => []);
    const ok = await runActionsImpl(sql, deps(fetcher as unknown as typeof fetch), {
      databaseId: D1,
      actions: [{ kind: 'send_webhook', url: 'https://example.com/hook', payload: { a: 1 } }],
      actorEmail: 'a@x.com',
    });
    expect(ok.ran).toBe(1);
    expect(fetcher).toHaveBeenCalledOnce();
    const bad = await runActionsImpl(sql, deps(fetcher as unknown as typeof fetch), {
      databaseId: D1,
      actions: [{ kind: 'send_webhook', url: 'http://169.254.169.254/x' }],
      actorEmail: 'a@x.com',
    });
    expect(bad.ran).toBe(0);
    expect(bad.errors[0]).toContain('unsafe url');
  });

  it('skips client-only actions and counts them', async () => {
    const { sql } = fakeSql(() => []);
    const res = await runActionsImpl(sql, deps(), {
      databaseId: D1,
      actions: [{ kind: 'show_confirm', message: '?' }, { kind: 'open_page', pageId: 'p' }],
      actorEmail: 'a@x.com',
    });
    expect(res.ran).toBe(0);
    expect(res.skipped).toBe(2);
  });
});

describe('triggerMatchesPropertyEdit', () => {
  it('matches any prop when no propertyId set', () => {
    expect(triggerMatchesPropertyEdit({ kind: 'property_edited' }, 'p1')).toBe(true);
  });
  it('matches only the named prop', () => {
    expect(triggerMatchesPropertyEdit({ kind: 'property_edited', propertyId: 'p1' }, 'p1')).toBe(true);
    expect(triggerMatchesPropertyEdit({ kind: 'property_edited', propertyId: 'p1' }, 'p2')).toBe(false);
  });
  it('honors equals + notEmpty conditions', () => {
    expect(
      triggerMatchesPropertyEdit({ kind: 'property_edited', condition: { equals: 'Done' } }, 'p', 'Done'),
    ).toBe(true);
    expect(
      triggerMatchesPropertyEdit({ kind: 'property_edited', condition: { equals: 'Done' } }, 'p', 'Todo'),
    ).toBe(false);
    expect(
      triggerMatchesPropertyEdit({ kind: 'property_edited', condition: { notEmpty: true } }, 'p', ''),
    ).toBe(false);
    expect(
      triggerMatchesPropertyEdit({ kind: 'property_edited', condition: { notEmpty: true } }, 'p', 'x'),
    ).toBe(true);
  });
  it('returns false for non-property_edited triggers', () => {
    expect(triggerMatchesPropertyEdit({ kind: 'page_added' }, 'p')).toBe(false);
  });
});

describe('computeFirstRun / advanceSchedule', () => {
  const NOON = Date.parse('2026-06-02T12:00:00Z');
  it('returns null for non-schedule triggers', () => {
    expect(computeFirstRun({ kind: 'page_added' }, NOON)).toBeNull();
  });
  it('rolls to tomorrow when the slot already passed today', () => {
    const next = computeFirstRun({ kind: 'schedule', every: 'day', at: '09:00' }, NOON);
    expect(next).toBe('2026-06-03T09:00:00.000Z');
  });
  it('uses today when the slot is still ahead', () => {
    const next = computeFirstRun({ kind: 'schedule', every: 'day', at: '15:30' }, NOON);
    expect(next).toBe('2026-06-02T15:30:00.000Z');
  });
  it('advances by cadence', () => {
    expect(advanceSchedule('day', NOON)).toBe('2026-06-03T12:00:00.000Z');
    expect(advanceSchedule('week', NOON)).toBe('2026-06-09T12:00:00.000Z');
    expect(advanceSchedule('month', NOON)).toBe('2026-07-02T12:00:00.000Z');
  });
});

describe('runDatabaseTriggerImpl', () => {
  it('fires only matching enabled automations', async () => {
    const autos = [
      { id: 'a1', database_id: D1, name: null, enabled: true, trigger: { kind: 'page_added' }, actions: [{ kind: 'send_notification', recipients: ['x@x.com'], body: 'hi' }], next_run_at: null, last_run_at: null, created_at: 't', created_by: null },
      { id: 'a2', database_id: D1, name: null, enabled: false, trigger: { kind: 'page_added' }, actions: [], next_run_at: null, last_run_at: null, created_at: 't', created_by: null },
      { id: 'a3', database_id: D1, name: null, enabled: true, trigger: { kind: 'property_edited' }, actions: [], next_run_at: null, last_run_at: null, created_at: 't', created_by: null },
    ];
    const { sql } = fakeSql((text) => {
      if (text.includes('FROM editor.db_automations')) {
        return autos.map((a) => ({
          id: a.id,
          databaseId: a.database_id,
          name: a.name,
          enabled: a.enabled,
          trigger: a.trigger,
          actions: a.actions,
          nextRunAt: a.next_run_at,
          lastRunAt: a.last_run_at,
          createdAt: a.created_at,
          createdBy: a.created_by,
        }));
      }
      return [{ id: 'n1' }];
    });
    const fired = await runDatabaseTriggerImpl(sql, deps(), {
      databaseId: D1,
      event: 'page_added',
      rowId: ROW,
      actorEmail: 'a@x.com',
    });
    expect(fired).toBe(1); // only a1 (enabled + page_added)
  });
});

describe('CRUD impls', () => {
  it('createAutomationImpl computes next_run_at for schedule triggers', async () => {
    const seen: unknown[][] = [];
    const { sql } = fakeSql((text, params) => {
      if (text.includes('INSERT INTO editor.db_automations')) {
        seen.push(params);
        return [
          {
            id: 'a1',
            databaseId: D1,
            name: null,
            enabled: true,
            trigger: { kind: 'schedule', every: 'day', at: '09:00' },
            actions: [],
            nextRunAt: '2026-06-03T09:00:00.000Z',
            lastRunAt: null,
            createdAt: 't',
            createdBy: 'u@x.com',
          },
        ];
      }
      return [];
    });
    const created = await createAutomationImpl(sql, {
      databaseId: D1,
      trigger: { kind: 'schedule', every: 'day', at: '09:00' },
      actions: [],
      createdBy: 'u@x.com',
      now: () => Date.parse('2026-06-02T12:00:00Z'),
    });
    expect(created.nextRunAt).toBe('2026-06-03T09:00:00.000Z');
    // next_run_at param was the computed ISO, not null.
    expect(seen[0]).toContain('2026-06-03T09:00:00.000Z');
  });

  it('updateAutomationImpl recomputes next_run_at when the trigger changes', async () => {
    const { sql, calls } = fakeSql(() => [{ id: 'a1' }]);
    const ok = await updateAutomationImpl(sql, 'a1', {
      trigger: { kind: 'schedule', every: 'week', at: '09:00' },
      now: () => Date.parse('2026-06-02T12:00:00Z'),
    });
    expect(ok).toBe(true);
    const upd = calls.find((c) => c.text.includes('UPDATE editor.db_automations'));
    expect(upd).toBeTruthy();
  });

  it('setEnabled / delete / list issue the expected statements', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT')) return [];
      return [{ id: 'a1' }];
    });
    expect(await setEnabledImpl(sql, 'a1', false)).toBe(true);
    expect(await deleteAutomationImpl(sql, 'a1')).toBe(true);
    await listAutomationsImpl(sql, D1);
    expect(calls.some((c) => c.text.includes('SET enabled'))).toBe(true);
    expect(calls.some((c) => c.text.includes('DELETE FROM editor.db_automations'))).toBe(true);
  });
});

describe('scheduled automations', () => {
  it('runs due ones, sets last_run_at + advances next_run_at', async () => {
    const due = [
      {
        id: 'a1',
        databaseId: D1,
        name: null,
        enabled: true,
        trigger: { kind: 'schedule', every: 'day', at: '09:00' },
        actions: [{ kind: 'send_notification', recipients: ['x@x.com'], body: 'morning' }],
        nextRunAt: '2026-06-02T09:00:00.000Z',
        lastRunAt: null,
        createdAt: 't',
        createdBy: null,
      },
    ];
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('WHERE enabled = true AND next_run_at')) return due;
      return [{ id: 'n1' }];
    });
    const fired = await runScheduledAutomationsImpl(sql, deps(), '2026-06-02T12:00:00.000Z');
    expect(fired).toBe(1);
    const upd = calls.find((c) => c.text.includes('SET last_run_at'));
    expect(upd).toBeTruthy();
    // advanced to the next day.
    expect(upd!.params).toContain('2026-06-03T12:00:00.000Z');
  });

  it('dueScheduledAutomationsImpl selects by next_run_at <= now', async () => {
    const { sql, calls } = fakeSql(() => []);
    await dueScheduledAutomationsImpl(sql, '2026-06-02T12:00:00.000Z');
    expect(calls[0]!.text).toContain('next_run_at <=');
  });
});
