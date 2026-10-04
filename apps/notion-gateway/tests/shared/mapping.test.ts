import { describe, expect, it } from 'vitest';
import {
  buildPropertyValue,
  buildProperties,
  getInverseMapping,
  notionPropertyToPrimitive,
  suggestMapping,
} from '@shared/mapping';
import { PM_FIELDS, type NotionMapping, type NotionProperty } from '@shared/types';

function prop(id: string, name: string, type: string): NotionProperty {
  return { id, name, type };
}

describe('suggestMapping', () => {
  it('exact-matches by name', () => {
    const props: Record<string, NotionProperty> = {
      Title: prop('A', 'Title', 'title'),
      'Due Date': prop('B', 'Due Date', 'date'),
      Status: prop('C', 'Status', 'status'),
    };
    const mapping = suggestMapping(PM_FIELDS, props);
    expect(mapping.fields.subject?.propertyName).toBe('Title');
    expect(mapping.fields.dueDate?.propertyName).toBe('Due Date');
    expect(mapping.fields.status?.propertyName).toBe('Status');
  });

  it('falls back to the first type-compatible property', () => {
    const props: Record<string, NotionProperty> = {
      Heading: prop('A', 'Heading', 'title'),
      Notes: prop('B', 'Notes', 'rich_text'),
      Done: prop('C', 'Done', 'number'),
    };
    const mapping = suggestMapping(PM_FIELDS, props);
    // No "Subject" property — first title type used.
    expect(mapping.fields.subject?.propertyName).toBe('Heading');
    // No "Description" — first rich_text used.
    expect(mapping.fields.description?.propertyName).toBe('Notes');
  });

  it('returns null when no compatible type exists', () => {
    const props: Record<string, NotionProperty> = {
      Whatever: prop('A', 'Whatever', 'phone_number'),
    };
    const mapping = suggestMapping(PM_FIELDS, props);
    expect(mapping.fields.subject).toBeNull();
    expect(mapping.fields.dueDate).toBeNull();
  });

  it('normalizes name comparisons across whitespace/case/separators', () => {
    const props: Record<string, NotionProperty> = {
      'due_DATE': prop('A', 'due_DATE', 'date'),
      'Estimated Hours': prop('B', 'Estimated Hours', 'number'),
      'Done-%': prop('C', 'Done-%', 'number'),
    };
    const mapping = suggestMapping(PM_FIELDS, props);
    expect(mapping.fields.dueDate?.propertyName).toBe('due_DATE');
    expect(mapping.fields.estimatedHours?.propertyName).toBe('Estimated Hours');
    expect(mapping.fields.doneRatio?.propertyName).toBe('Done-%');
  });
});

describe('buildPropertyValue', () => {
  it('emits title text', async () => {
    expect(await buildPropertyValue('subject', 'Hello', 'title')).toEqual({
      title: [{ type: 'text', text: { content: 'Hello' } }],
    });
  });

  it('emits rich_text with truncation', async () => {
    const long = 'a'.repeat(3000);
    const out = (await buildPropertyValue('description', long, 'rich_text')) as {
      rich_text: Array<{ text: { content: string } }>;
    };
    expect(out.rich_text[0]!.text.content.length).toBe(2000);
  });

  it('emits select / status / multi_select / date / number / checkbox', async () => {
    expect(await buildPropertyValue('status', 'open', 'select')).toEqual({
      select: { name: 'open' },
    });
    expect(await buildPropertyValue('status', 'open', 'status')).toEqual({
      status: { name: 'open' },
    });
    expect(await buildPropertyValue('tracker', ['bug', 'task'], 'multi_select')).toEqual({
      multi_select: [{ name: 'bug' }, { name: 'task' }],
    });
    expect(await buildPropertyValue('tracker', 'bug', 'multi_select')).toEqual({
      multi_select: [{ name: 'bug' }],
    });
    expect(await buildPropertyValue('dueDate', '2026-06-01', 'date')).toEqual({
      date: { start: '2026-06-01' },
    });
    expect(await buildPropertyValue('estimatedHours', 3, 'number')).toEqual({ number: 3 });
    expect(await buildPropertyValue('estimatedHours', '3.5', 'number')).toEqual({ number: 3.5 });
    expect(await buildPropertyValue('estimatedHours', 'oops', 'number')).toEqual({ number: null });
    expect(await buildPropertyValue('isClosed', true, 'checkbox')).toEqual({ checkbox: true });
    expect(await buildPropertyValue('url', 'https://x', 'url')).toEqual({ url: 'https://x' });
    expect(await buildPropertyValue('email', 'a@b', 'email')).toEqual({ email: 'a@b' });
    expect(await buildPropertyValue('phone', '+1', 'phone_number')).toEqual({ phone_number: '+1' });
  });

  it('skips read-only types', async () => {
    for (const t of ['created_time', 'last_edited_time', 'formula', 'rollup']) {
      expect(await buildPropertyValue('x', 'v', t)).toBeUndefined();
    }
  });

  it('returns undefined for unknown types', async () => {
    expect(await buildPropertyValue('x', 'v', 'mystery')).toBeUndefined();
  });

  it('clears values when input is null/empty', async () => {
    expect(await buildPropertyValue('s', null, 'select')).toEqual({ select: null });
    expect(await buildPropertyValue('s', '', 'status')).toEqual({ status: null });
    expect(await buildPropertyValue('s', null, 'multi_select')).toEqual({ multi_select: [] });
    expect(await buildPropertyValue('s', null, 'date')).toEqual({ date: null });
    expect(await buildPropertyValue('s', null, 'people')).toEqual({ people: [] });
    expect(await buildPropertyValue('s', null, 'number')).toEqual({ number: null });
    expect(await buildPropertyValue('s', null, 'checkbox')).toEqual({ checkbox: false });
    expect(await buildPropertyValue('s', null, 'url')).toEqual({ url: null });
    expect(await buildPropertyValue('s', null, 'email')).toEqual({ email: null });
    expect(await buildPropertyValue('s', null, 'phone_number')).toEqual({ phone_number: null });
    expect(await buildPropertyValue('s', null, 'rich_text')).toEqual({ rich_text: [] });
    expect(await buildPropertyValue('s', null, 'title')).toEqual({ title: [] });
    expect(await buildPropertyValue('s', null, 'mystery')).toBeUndefined();
  });

  it('resolves people via the dep callback', async () => {
    const out = await buildPropertyValue('assignedTo', 'a@b.com', 'people', {
      resolvePersonId: async () => 'user-id-1',
    });
    expect(out).toEqual({ people: [{ id: 'user-id-1' }] });
  });

  it('skips people when the lookup misses', async () => {
    const out = await buildPropertyValue('assignedTo', 'a@b.com', 'people', {
      resolvePersonId: async () => null,
    });
    expect(out).toBeUndefined();
  });

  it('skips people with no resolver provided', async () => {
    expect(await buildPropertyValue('assignedTo', 'a@b.com', 'people')).toBeUndefined();
  });
});

describe('buildProperties', () => {
  it('builds the full payload from a mapping', async () => {
    const mapping: NotionMapping = {
      fields: {
        subject: { propertyId: 'A', propertyName: 'Title', propertyType: 'title' },
        status: { propertyId: 'B', propertyName: 'Status', propertyType: 'select' },
        // unmapped key
        description: null,
        // mapped but read-only type — should be skipped
        createdAt: {
          propertyId: 'C',
          propertyName: 'Created',
          propertyType: 'created_time',
        },
      },
    };
    const out = await buildProperties(
      PM_FIELDS,
      { subject: 'Hi', status: 'open', description: 'ignored' },
      mapping,
    );
    expect(out).toEqual({
      Title: { title: [{ type: 'text', text: { content: 'Hi' } }] },
      Status: { select: { name: 'open' } },
    });
  });
});

describe('notionPropertyToPrimitive', () => {
  it('reads title segments back into a flat string', () => {
    expect(
      notionPropertyToPrimitive({
        type: 'title',
        title: [{ plain_text: 'Hi ' }, { plain_text: 'there' }, {}],
      }),
    ).toBe('Hi there');
    // Missing title array falls back to '' via the `?? []` branch.
    expect(notionPropertyToPrimitive({ type: 'title' })).toBe('');
  });

  it('reads rich_text segments back into a flat string', () => {
    expect(
      notionPropertyToPrimitive({
        type: 'rich_text',
        rich_text: [{ plain_text: 'one' }, {}],
      }),
    ).toBe('one');
    // Missing rich_text array falls back to '' via the `?? []` branch.
    expect(notionPropertyToPrimitive({ type: 'rich_text' })).toBe('');
  });

  it('reads select / status names', () => {
    expect(notionPropertyToPrimitive({ type: 'select', select: { name: 'a' } })).toBe('a');
    expect(notionPropertyToPrimitive({ type: 'status', status: { name: 'b' } })).toBe('b');
    expect(notionPropertyToPrimitive({ type: 'select', select: null })).toBeNull();
    expect(notionPropertyToPrimitive({ type: 'status', status: null })).toBeNull();
  });

  it('reads multi_select into a name[]', () => {
    expect(
      notionPropertyToPrimitive({
        type: 'multi_select',
        multi_select: [{ name: 'one' }, { name: 'two' }, {}],
      }),
    ).toEqual(['one', 'two']);
    expect(notionPropertyToPrimitive({ type: 'multi_select' })).toEqual([]);
  });

  it('reads date.start (ignoring end)', () => {
    expect(
      notionPropertyToPrimitive({
        type: 'date',
        date: { start: '2026-01-02', end: '2026-01-09' },
      }),
    ).toBe('2026-01-02');
    expect(notionPropertyToPrimitive({ type: 'date', date: null })).toBeNull();
  });

  it('reads number / checkbox', () => {
    expect(notionPropertyToPrimitive({ type: 'number', number: 5 })).toBe(5);
    expect(notionPropertyToPrimitive({ type: 'number', number: null })).toBeNull();
    expect(notionPropertyToPrimitive({ type: 'checkbox', checkbox: true })).toBe(true);
    expect(notionPropertyToPrimitive({ type: 'checkbox', checkbox: false })).toBe(false);
  });

  it('reads url / email / phone_number', () => {
    expect(notionPropertyToPrimitive({ type: 'url', url: 'https://x' })).toBe('https://x');
    expect(notionPropertyToPrimitive({ type: 'url', url: null })).toBeNull();
    expect(notionPropertyToPrimitive({ type: 'email', email: 'a@b' })).toBe('a@b');
    expect(notionPropertyToPrimitive({ type: 'email' })).toBeNull();
    expect(
      notionPropertyToPrimitive({ type: 'phone_number', phone_number: '+1' }),
    ).toBe('+1');
    expect(notionPropertyToPrimitive({ type: 'phone_number' })).toBeNull();
  });

  it('reads people via person.email', () => {
    expect(
      notionPropertyToPrimitive({
        type: 'people',
        people: [{ person: { email: 'a@b' } }, { person: {} }, {}],
      }),
    ).toEqual(['a@b']);
    expect(notionPropertyToPrimitive({ type: 'people' })).toEqual([]);
  });

  it('reads created_time / last_edited_time as ISO strings', () => {
    expect(
      notionPropertyToPrimitive({ type: 'created_time', created_time: '2026-01-01T00:00:00Z' }),
    ).toBe('2026-01-01T00:00:00Z');
    expect(notionPropertyToPrimitive({ type: 'created_time' })).toBeNull();
    expect(
      notionPropertyToPrimitive({
        type: 'last_edited_time',
        last_edited_time: '2026-01-02T00:00:00Z',
      }),
    ).toBe('2026-01-02T00:00:00Z');
    expect(notionPropertyToPrimitive({ type: 'last_edited_time' })).toBeNull();
  });

  it('returns undefined for unknown / formula / rollup / files types', () => {
    expect(notionPropertyToPrimitive({ type: 'formula' })).toBeUndefined();
    expect(notionPropertyToPrimitive({ type: 'rollup' })).toBeUndefined();
    expect(notionPropertyToPrimitive({ type: 'files' })).toBeUndefined();
    expect(notionPropertyToPrimitive({ type: 'unique_id' })).toBeUndefined();
  });

  it('returns undefined for non-object inputs', () => {
    expect(notionPropertyToPrimitive(null)).toBeUndefined();
    expect(notionPropertyToPrimitive(undefined)).toBeUndefined();
    expect(notionPropertyToPrimitive('a string')).toBeUndefined();
    expect(notionPropertyToPrimitive(42)).toBeUndefined();
  });
});

describe('getInverseMapping', () => {
  it('translates a Notion properties block back into PM fields by property name', () => {
    const mapping: NotionMapping = {
      fields: {
        subject: { propertyId: 'A', propertyName: 'Title', propertyType: 'title' },
        dueDate: { propertyId: 'B', propertyName: 'Due', propertyType: 'date' },
        // unmapped — never appears in output
        status: null,
      },
    };
    const out = getInverseMapping(PM_FIELDS, mapping, {
      Title: { id: 'A', type: 'title', title: [{ plain_text: 'Hi' }] },
      Due: { id: 'B', type: 'date', date: { start: '2026-06-01' } },
    });
    expect(out).toEqual({ subject: 'Hi', dueDate: '2026-06-01' });
  });

  it('falls back to property id when the name has been renamed in Notion', () => {
    const mapping: NotionMapping = {
      fields: {
        subject: { propertyId: 'A', propertyName: 'OldName', propertyType: 'title' },
      },
    };
    const out = getInverseMapping(PM_FIELDS, mapping, {
      RenamedNow: { id: 'A', type: 'title', title: [{ plain_text: 'Hi' }] },
    });
    expect(out).toEqual({ subject: 'Hi' });
  });

  it('skips fields whose primitive translator returns undefined', () => {
    const mapping: NotionMapping = {
      fields: {
        subject: { propertyId: 'A', propertyName: 'Formula', propertyType: 'formula' },
        dueDate: { propertyId: 'B', propertyName: 'Due', propertyType: 'date' },
      },
    };
    const out = getInverseMapping(PM_FIELDS, mapping, {
      Formula: { id: 'A', type: 'formula', formula: { number: 1 } },
      Due: { id: 'B', type: 'date', date: { start: '2026-06-01' } },
    });
    expect(out).toEqual({ dueDate: '2026-06-01' });
  });

  it('skips fields whose Notion property is absent from the payload', () => {
    const mapping: NotionMapping = {
      fields: {
        subject: { propertyId: 'A', propertyName: 'Title', propertyType: 'title' },
      },
    };
    const out = getInverseMapping(PM_FIELDS, mapping, {
      Untouched: { id: 'Z', type: 'rich_text', rich_text: [] },
    });
    expect(out).toEqual({});
  });

  it('handles a non-object raw property entry without crashing the id-index', () => {
    const mapping: NotionMapping = {
      fields: {
        subject: { propertyId: 'A', propertyName: 'Title', propertyType: 'title' },
      },
    };
    const out = getInverseMapping(PM_FIELDS, mapping, {
      Stray: null as unknown as Record<string, unknown>,
      Title: { id: 'A', type: 'title', title: [{ plain_text: 'Hi' }] },
    });
    expect(out).toEqual({ subject: 'Hi' });
  });
});
