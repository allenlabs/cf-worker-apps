/** A search broker for per-bot plus common Cloudflare Agent Memory profiles. */
export type MemorySearchScope = 'default' | 'selected' | 'all';
export type MemorySearchOptions = { scope?: MemorySearchScope; botIds?: string[] };
export type BotMemoryReference = { id: string; name: string; archived: boolean };
export type MemorySearchSource = { kind: 'bot' | 'common' | 'standard'; botId: string | null; label: string };
export type MemorySearchResponse = { scope: MemorySearchScope; complete: boolean; sources: Array<MemorySearchSource & {
  count?: number; answer?: string; candidates?: Array<{id: string; summary: string; sessionId: string | null; score: number}>; error?: string;
}> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SOURCES = 64;
const utf8 = new TextEncoder();

/** The available bot catalog MUST originate from the currently authenticated owner's User DO. */
export function selectMemorySources(currentBotId: string | null, bots: BotMemoryReference[], options: MemorySearchOptions = {}): MemorySearchSource[] {
  const scope = options.scope ?? 'default';
  if (!['default', 'selected', 'all'].includes(scope)) throw new Error('Invalid memory search scope');
  if (!Array.isArray(bots) || bots.some(bot => !bot || typeof bot.name !== 'string' || !UUID.test(bot.id) || typeof bot.archived !== 'boolean')) {
    throw new Error('Invalid authorized bot catalog');
  }
  if (currentBotId !== null && !UUID.test(currentBotId)) throw new Error('Invalid current bot');
  if (options.botIds !== undefined && (!Array.isArray(options.botIds) || options.botIds.some(id => typeof id !== 'string' || !UUID.test(id)) || options.botIds.length > MAX_SOURCES)) {
    throw new Error('Invalid selected bot identifiers');
  }
  if (scope !== 'selected' && (options.botIds?.length ?? 0) > 0) throw new Error('Selected bot IDs require selected scope');
  if (scope === 'selected' && !options.botIds?.length) throw new Error('Select at least one bot');
  const catalog = new Map<string, BotMemoryReference>();
  for (const bot of bots) {
    if (catalog.has(bot.id)) throw new Error('Duplicate bot identifier in authorized catalog');
    catalog.set(bot.id, bot);
  }
  const sources: MemorySearchSource[] = [];
  const seen = new Set<string>();
  const append = (kind: MemorySearchSource['kind'], botId: string | null, label: string) => {
    const key = kind === 'common' ? 'common' : botId === null ? 'standard' : `bot:${botId}`;
    if (seen.has(key)) return;
    if (sources.length >= MAX_SOURCES) throw new Error('Too many bot profiles for one lookup; choose specific bots. Nothing was omitted silently.');
    seen.add(key); sources.push({ kind, botId, label });
  };
  append(currentBotId === null ? 'standard' : 'bot', currentBotId, currentBotId ? catalog.get(currentBotId)?.name ?? 'Current bot' : 'Standard assistant');
  append('common', null, 'Common memory');
  if (scope === 'selected') {
    for (const id of options.botIds!) {
      const bot = catalog.get(id);
      if (!bot) throw new Error('Selected bot is not available in your account');
      append('bot', id, bot.name);
    }
  } else if (scope === 'all') {
    for (const bot of bots) append('bot', bot.id, bot.name);
    append('standard', null, 'Standard assistant');
  }
  return sources;
}

type RecallResult = { count: number; answer: string; candidates: Array<{id: string; summary: string; sessionId: string | null; score: number}> };
export interface MemoryProfileBinding { getProfile(name: string): Promise<{ recall(query: string, opts: {thinkingLevel:'low';responseLength:'short'}): Promise<RecallResult> }> }

export async function searchMemoryProfiles(input: {
  principal: string; currentBotId: string | null; bots: BotMemoryReference[]; query: string;
  options?: MemorySearchOptions; profileName: (id: string | null) => Promise<string> | string;
  commonName: () => Promise<string> | string; binding: MemoryProfileBinding;
}): Promise<MemorySearchResponse> {
  if (typeof input.query !== 'string' || !input.query.isWellFormed()) throw new Error('Memory query requires valid Unicode');
  const size = utf8.encode(input.query).byteLength;
  if (size < 1 || size > 1024 || !input.query.trim()) throw new Error('Memory query must be 1–1024 UTF-8 bytes; it was not shortened');
  if (typeof input.principal !== 'string' || !input.principal.trim()) throw new Error('No verified memory owner');
  const scope = input.options?.scope ?? 'default';
  const sources = selectMemorySources(input.currentBotId,input.bots,input.options);
  const results: MemorySearchResponse['sources'] = new Array(sources.length);
  let index = 0;
  const worker = async () => {
    for (;;) {
      const n = index++;
      if (n >= sources.length) return;
      const source = sources[n];
      try {
        const name = source.kind === 'common' ? await input.commonName() : await input.profileName(source.botId);
        const profile = await input.binding.getProfile(name);
        const { count, answer, candidates } = await profile.recall(input.query,{thinkingLevel:'low',responseLength:'short'});
        results[n] = { ...source, count, answer, candidates };
      } catch {
        results[n] = { ...source, error: 'Memory lookup failed' };
      }
    }
  };
  await Promise.all(Array.from({length:Math.min(4,sources.length)},()=>worker()));
  return { scope, complete: results.every(item => !item.error), sources: results };
}
