/** Account-owned default bot pointer. It does not change stored chat snapshots. */
export type MainBotSelection = { key: 'main'; botId: string | null; revision: number };
export interface MainBotStore { get(key: 'main'): MainBotSelection | undefined; put(value: MainBotSelection): void }
export type AvailableMainBot = { id: string; archived: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function readMainBot(store: MainBotStore): MainBotSelection {
  return store.get('main') ?? { key: 'main', botId: null, revision: 0 };
}
export function setMainBot(store: MainBotStore, bots: Map<string, AvailableMainBot>, botId: string | null, expectedRevision: number): MainBotSelection {
  if (botId !== null && (typeof botId !== 'string' || !UUID.test(botId))) throw new Error('Invalid main bot identifier');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('Invalid main bot revision');
  const current = readMainBot(store);
  if (current.revision !== expectedRevision) {
    // Network retries may repeat an already committed request. Do not undo a later change.
    if (current.revision === expectedRevision + 1 && current.botId === botId) return current;
    throw new Error('Main bot changed in another session. Reload before saving.');
  }
  if (botId !== null) {
    const bot = bots.get(botId);
    if (!bot) throw new Error('Main bot is unavailable to this account');
    if (bot.archived) throw new Error('Archived bots cannot become the main bot');
  }
  if (current.botId === botId) return current;
  const updated = { key: 'main' as const, botId, revision: current.revision + 1 };
  store.put(updated);
  return updated;
}
export function clearArchivedMainBot(store: MainBotStore, archivedBotId: string): MainBotSelection {
  const current = readMainBot(store);
  if (current.botId !== archivedBotId) return current;
  const cleared = { key: 'main' as const, botId: null, revision: current.revision + 1 };
  store.put(cleared);
  return cleared;
}
