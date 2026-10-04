import { describe, expect, it } from 'vitest';
import {
  ACTION_KINDS,
  CLIENT_ACTION_KINDS,
  SERVER_ACTION_KINDS,
  isClientAction,
  describeAction,
  parseAction,
  parseActions,
  type ButtonAction,
} from '../src/lib/actions';
import {
  blockTemplateToNodes,
  runButtonActions,
} from '../src/extensions/button';
import { makeButtonSlashItem } from '../src/lib/slash-items';

describe('action kind sets', () => {
  it('partitions kinds into client + server with no overlap', () => {
    expect(ACTION_KINDS).toEqual(
      expect.arrayContaining([
        'insert_blocks',
        'add_page_to_db',
        'edit_pages',
        'open_page',
        'show_confirm',
        'send_notification',
        'send_webhook',
      ]),
    );
    for (const k of CLIENT_ACTION_KINDS) expect(SERVER_ACTION_KINDS.has(k)).toBe(false);
    expect([...CLIENT_ACTION_KINDS].sort()).toEqual(
      ['insert_blocks', 'open_page', 'show_confirm'].sort(),
    );
  });

  it('isClientAction matches the client set', () => {
    expect(isClientAction({ kind: 'open_page', pageId: 'p' })).toBe(true);
    expect(isClientAction({ kind: 'send_webhook', url: 'https://x' })).toBe(false);
  });
});

describe('describeAction', () => {
  it('renders a label per kind, counting where relevant', () => {
    expect(describeAction({ kind: 'insert_blocks', blocks: [{ type: 'paragraph' }] })).toContain('(1)');
    expect(describeAction({ kind: 'add_page_to_db', databaseId: 'd', databaseTitle: 'Tasks' })).toContain('Tasks');
    expect(describeAction({ kind: 'edit_pages', propertyId: 'p', value: 1 })).toBe('Edit pages');
    expect(describeAction({ kind: 'open_page', pageId: 'p' })).toBe('Open page');
    expect(describeAction({ kind: 'show_confirm', message: 'Sure?' })).toContain('Sure?');
    expect(describeAction({ kind: 'send_notification', recipients: ['a', 'b'], body: 'x' })).toContain('(2)');
    expect(describeAction({ kind: 'send_webhook', url: 'https://x' })).toBe('Send webhook');
  });

  it('uses the t map when it returns a real translation', () => {
    const t = (k: string) => (k === 'action.open_page' ? '열기' : k);
    expect(describeAction({ kind: 'open_page', pageId: 'p' }, t)).toBe('열기');
  });
});

describe('parseAction / parseActions', () => {
  it('narrows valid actions and drops invalid ones', () => {
    expect(parseAction({ kind: 'open_page', pageId: 'p' })).toEqual({ kind: 'open_page', pageId: 'p' });
    expect(parseAction({ kind: 'open_page' })).toBeNull(); // missing pageId
    expect(parseAction({ kind: 'edit_pages' })).toBeNull(); // missing propertyId
    expect(parseAction({ kind: 'add_page_to_db' })).toBeNull();
    expect(parseAction({ kind: 'send_webhook' })).toBeNull();
    expect(parseAction({ kind: 'bogus' })).toBeNull();
    expect(parseAction(null)).toBeNull();
    expect(parseAction('x')).toBeNull();
  });

  it('coerces send_notification recipients to strings', () => {
    const a = parseAction({ kind: 'send_notification', recipients: ['a', 2, 'b'], body: 'hi' });
    expect(a).toEqual({ kind: 'send_notification', recipients: ['a', 'b'], body: 'hi' });
  });

  it('parseActions filters an array, keeping only valid actions', () => {
    const out = parseActions([
      { kind: 'open_page', pageId: 'p' },
      { kind: 'open_page' },
      'garbage',
      { kind: 'show_confirm', message: 'ok' },
    ]);
    expect(out.map((a) => a.kind)).toEqual(['open_page', 'show_confirm']);
  });

  it('parseActions returns [] for non-arrays', () => {
    expect(parseActions(null)).toEqual([]);
    expect(parseActions({})).toEqual([]);
  });
});

describe('blockTemplateToNodes', () => {
  it('maps templates to tiptap doc nodes', () => {
    const nodes = blockTemplateToNodes([
      { type: 'heading', level: 1, text: 'Title' },
      { type: 'todo', text: 'Do it' },
      { type: 'paragraph', text: 'body' },
      { type: 'paragraph' },
    ]);
    expect(nodes[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    expect(nodes[1]).toMatchObject({ type: 'taskList' });
    expect(nodes[2]).toMatchObject({ type: 'paragraph' });
    // Empty paragraph has no content array entries.
    expect((nodes[3] as { content: unknown[] }).content).toEqual([]);
  });

  it('defaults heading level to 2', () => {
    const [n] = blockTemplateToNodes([{ type: 'heading', text: 'x' }]);
    expect(n).toMatchObject({ attrs: { level: 2 } });
  });
});

describe('runButtonActions', () => {
  it('runs client actions inline + delegates data actions in order', async () => {
    const calls: string[] = [];
    const actions: ButtonAction[] = [
      { kind: 'insert_blocks', blocks: [{ type: 'paragraph', text: 'a' }] },
      { kind: 'add_page_to_db', databaseId: 'd' },
      { kind: 'open_page', pageId: 'p' },
    ];
    await runButtonActions(actions, {
      insertBelow: () => calls.push('insert'),
      openPage: () => calls.push('open'),
      runDataAction: async (a) => {
        calls.push(`data:${a.kind}`);
      },
    });
    expect(calls).toEqual(['insert', 'data:add_page_to_db', 'open']);
  });

  it('aborts remaining actions when a confirm is declined', async () => {
    const calls: string[] = [];
    const actions: ButtonAction[] = [
      { kind: 'show_confirm', message: '?' },
      { kind: 'open_page', pageId: 'p' },
    ];
    await runButtonActions(actions, {
      insertBelow: () => calls.push('insert'),
      openPage: () => calls.push('open'),
      confirm: () => false,
    });
    expect(calls).toEqual([]); // confirm declined → open never runs
  });

  it('continues past an accepted confirm', async () => {
    const calls: string[] = [];
    await runButtonActions(
      [
        { kind: 'show_confirm', message: '?' },
        { kind: 'open_page', pageId: 'p' },
      ],
      { insertBelow: () => {}, openPage: () => calls.push('open'), confirm: () => true },
    );
    expect(calls).toEqual(['open']);
  });
});

describe('makeButtonSlashItem', () => {
  it('builds a Button slash item that inserts a button node', () => {
    const item = makeButtonSlashItem();
    expect(item.title).toBe('Button');
    expect(item.keywords).toContain('action');
    const ran: string[] = [];
    const editor = {
      chain: () => {
        const c = {
          focus: () => c,
          deleteRange: () => c,
          setButton: () => {
            ran.push('setButton');
            return c;
          },
          run: () => true,
        };
        return c;
      },
    };
    item.command({ editor: editor as never, range: { from: 0, to: 1 } as never });
    expect(ran).toEqual(['setButton']);
  });

  it('honors translated title/hint', () => {
    const item = makeButtonSlashItem({ title: '버튼', hint: '클릭' });
    expect(item.title).toBe('버튼');
    expect(item.hint).toBe('클릭');
  });
});
