import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { UserDurableObject } from '../src/user';

const input = (id = crypto.randomUUID()) => ({ id, name: 'Research partner', description: 'Evidence and sources',
  instructions: '  Keep exact identifiers.\n한글 🌿 and trailing space  ', icon: 'search' as const,
  starterPrompts: ['Review the attached evidence.'], memory: 'connected' as const, archived: false });
let serial = 0;
async function withUser<T>(action: (user: UserDurableObject, state: DurableObjectState) => Promise<T>) {
  return runInDurableObject(env.TEST_USER.getByName(`bot-profiles-${++serial}`), async (user, state) => {
    await user.loginOrCreateViaGatekeeper('bot-owner@example.invalid', true);
    return action(user, state);
  });
}
describe('personal bot profiles', () => {
  it('persists exact instructions, survives a storage reopen and keeps users separate', async () => {
    const draft = input();
    await withUser(async (user, state) => {
      const saved = await user.saveBotProfile(draft, 0);
      expect(saved).toMatchObject({ ...draft, revision: 1 });
      expect(saved.createdAt).toBe(saved.updatedAt);
      const { makeUserStorage } = await import('../src/storage-schema/user-storage');
      expect(makeUserStorage(state.storage).botProfiles.get(draft.id)).toEqual(saved);
      expect(await user.listBotProfiles()).toEqual([saved]);
    });
    await withUser(async user => {
      expect(await user.listBotProfiles()).toEqual([]);
      await expect(user.getBotForChat({ id: draft.id, revision: 1 })).rejects.toThrow(/unavailable/i);
    });
  });

  it('rejects oversized input and stale edits without losing the saved configuration', () => withUser(async user => {
    const draft = input();
    const saved = await user.saveBotProfile(draft, 0);
    await expect(user.saveBotProfile({ ...draft, instructions: '🌿'.repeat(8001) }, 1)).rejects.toThrow(/16000/);
    expect(await user.listBotProfiles()).toEqual([saved]);
    const changed = await user.saveBotProfile({ ...draft, instructions: 'Updated full instructions' }, 1);
    await expect(user.saveBotProfile({ ...draft, name: 'Stale edit' }, 1)).rejects.toThrow(/changed|revision/i);
    expect(await user.listBotProfiles()).toEqual([changed]);
    await expect(user.getBotForChat({ id: draft.id, revision: 1 })).rejects.toThrow(/changed|revision/i);
  }));

  it('supports retrying an identical save and reversible archive without deleting the bot', () => withUser(async user => {
    const draft = input();
    const saved = await user.saveBotProfile(draft, 0);
    expect(await user.saveBotProfile(draft, 0)).toEqual(saved);
    const snapshot = await user.getBotForChat({ id: draft.id, revision: 1 });
    const archived = await user.saveBotProfile({ ...draft, archived: true }, 1);
    expect(await user.saveBotProfile({ ...draft, archived: true }, 1)).toEqual(archived);
    await expect(user.getBotForChat({ id: draft.id, revision: 2 })).rejects.toThrow(/archived/i);
    expect(snapshot.instructions).toBe(draft.instructions);
    expect((await user.listBotProfiles())[0].archived).toBe(true);
    await user.saveBotProfile(draft, 2);
    expect((await user.getBotForChat({ id: draft.id, revision: 3 })).instructions).toBe(draft.instructions);
  }));

  it('validates identifiers, revisions, enums and every field without silent trimming', () => withUser(async user => {
    for (const patch of [{ id: '../other-user' }, { name: '' }, { name: 'n'.repeat(81) },
      { description: 'd'.repeat(321) }, { instructions: '\ud800' }, { icon: 'unknown' },
      { memory: 'shared-global' }, { starterPrompts: Array(7).fill('a') },
      { starterPrompts: ['a'.repeat(2001)] }, { archived: 'true' }]) {
      await expect(user.saveBotProfile({ ...input(), ...patch } as never, 0)).rejects.toThrow();
    }
    await expect(user.saveBotProfile(input(), -1)).rejects.toThrow(/revision/i);
    expect(await user.listBotProfiles()).toEqual([]);
  }));
});
