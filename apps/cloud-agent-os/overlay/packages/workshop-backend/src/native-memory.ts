/** Native Agent Memory transport. Canonical text stays in the workspace, not in this queue. */
export type NativeMemoryConfig = { principal: string; namespace: string };
export type MemoryMessage = { role: 'user' | 'assistant' | 'system'; content: string; timestamp: Date };
export type MemoryRecall = { count: number; answer: string; candidates: Array<{ id: string; summary: string; sessionId: string | null; score: number }> };
/** Structural facade over the documented Workers binding; no account API token enters the runtime. */
export interface NativeMemoryBinding {
  getProfile(name: string): Promise<{
    ingest(messages: MemoryMessage[], options: { sessionId: string }): Promise<void>;
    recall(query: string, options?: { thinkingLevel: 'low'; responseLength: 'short' }): Promise<MemoryRecall>;
  }>;
}
export type MemorySourceRef = { id: string; label: string; startCursor?: string };
export type MemorySnapshot = { sequence: number; role: MemoryMessage['role']; timestamp: string; sources: MemorySourceRef[] };
export type MemoryPage = { artifactId: string; sha256: string; start: number; end: number; totalChars: number;
  totalBytes: number; content: string; nextCursor: string | null; eof: boolean };
type Position = { sequence: number; snapshot?: MemorySnapshot; sourceIndex: number; cursor?: string; offset?: number };
type FrozenBatch = { id: string; snapshots: MemorySnapshot[]; messages: Array<Omit<MemoryMessage, 'timestamp'> & { timestamp: string }>; after: Position };
export type NativeMemoryState = {
  chatId: number; principal: string; namespace: string; botId: string | null; generation: string;
  highWater: number; position: Position; dueAt: number | null; firstPendingAt?: number;
  pending?: FrozenBatch; attempts: number; lastError?: string; lastAcceptedAt?: number;
  /** Legacy automatic common copies are retained for explicit migration, never replayed. */
  commonPosition?: Position; commonPending?: FrozenBatch;
};
export interface NativeMemoryStore {
  get(chatId: number): NativeMemoryState | undefined;
  put(state: NativeMemoryState): void;
  delete(chatId: number): void;
  list(): NativeMemoryState[];
  transaction<T>(fn: () => T): T;
}
export interface NativeMemorySource {
  load(chatId: number, sequence: number, principal: string): Promise<MemorySnapshot | null>;
  page(chatId: number, source: MemorySourceRef, cursor: string | undefined, principal: string): Promise<MemoryPage>;
  authorize(chatId: number, snapshot: MemorySnapshot, principal: string): Promise<void>;
}
export type NativeMemoryStatus = {
  state: 'not-enrolled' | 'pending' | 'retrying' | 'caught-up';
  botId?: string | null; namespace?: string; acknowledgedThrough: number; highWater: number;
  dueAt?: number | null; attempts?: number; error?: string; lastAcceptedAt?: number;
  commonAcknowledgedThrough?: number; commonBacklog?: number; commonSharing?: 'paused';
};
const utf8 = new TextEncoder();
const IDLE_MS = 30_000;
const MAX_WAIT_MS = 300_000;
const MAX_BATCH_PAGES = 8;
const MAX_CONTENT_BYTES = 32_768;
const NATURAL = (value: number) => Number.isSafeInteger(value) && value >= 0;
const requiredText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.isWellFormed();

export function readNativeMemoryConfig(env: unknown): NativeMemoryConfig | undefined {
  const input = env as Record<string, unknown>;
  if (input.AUTO_MEMORY_OWNER === undefined && input.AUTO_MEMORY_NAMESPACE === undefined) return;
  if (!requiredText(input.AUTO_MEMORY_OWNER) || !requiredText(input.AUTO_MEMORY_NAMESPACE) ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(input.AUTO_MEMORY_NAMESPACE)) throw new Error('Invalid native memory configuration');
  return { principal: input.AUTO_MEMORY_OWNER, namespace: input.AUTO_MEMORY_NAMESPACE };
}
async function digest(parts: unknown[]): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', utf8.encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function memoryProfileName(principal: string, botId: string | null): Promise<string> {
  if (!requiredText(principal) || botId !== null && !requiredText(botId)) throw new Error('Invalid memory identity');
  return `bot-${await digest(['cloud-agent-os-memory-v1', principal, botId])}`;
}
/** Standard assistant conversations are the owner's common context; bot transcripts stay separate. */
export async function commonMemoryProfileName(principal: string): Promise<string> {
  return memoryProfileName(principal, null);
}

export async function memorySessionId(workspaceId: string, chatId: number): Promise<string> {
  if (!requiredText(workspaceId) || !NATURAL(chatId)) throw new Error('Invalid memory session');
  return `s-${(await digest(['cloud-agent-os-chat-v1', workspaceId, chatId])).slice(0, 60)}`;
}

function frame(state: NativeMemoryState, snapshot: MemorySnapshot, index: number, page: MemoryPage): string {
  if (!page.content.isWellFormed() || page.artifactId !== snapshot.sources[index].id || page.sha256 !== page.artifactId ||
      !NATURAL(page.start) || !NATURAL(page.end) || !NATURAL(page.totalChars) ||
      page.end - page.start !== page.content.length || page.end > page.totalChars ||
      page.eof !== (page.end === page.totalChars) || page.eof !== (page.nextCursor === null) ||
      !page.eof && (page.end <= page.start || typeof page.nextCursor !== 'string')) {
    throw new Error('Invalid canonical memory page');
  }
  // Every API content is valid JSON. The `content` field is a fragment of an archived original;
  // reassemble in offset order before parsing that original (which may itself be JSON).
  const content = JSON.stringify({ format: 'cloud-agent-os-transcript-v1', botId: state.botId,
    chatId: state.chatId, sequence: snapshot.sequence, source: snapshot.sources[index].label,
    artifactId: page.artifactId, sha256: page.sha256, start: page.start, end: page.end,
    totalChars: page.totalChars, eof: page.eof, content: page.content });
  if (utf8.encode(content).byteLength > MAX_CONTENT_BYTES) throw new Error('Canonical memory page exceeds API content limit');
  return content;
}

/** Reject hung I/O without discarding its frozen batch. A late remote success is safe to retry. */
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Agent Memory request timed out')), 90_000);
    })]);
  } finally { clearTimeout(timer); }
}

export class NativeMemoryQueue {
  private readonly deps: NativeMemoryConfig & { workspaceId: string; store: NativeMemoryStore;
    source: NativeMemorySource; binding?: NativeMemoryBinding; now?: () => number };
  private running?: Promise<void>;
  constructor(deps: NativeMemoryQueue['deps']) { this.deps = deps; }
  private now() { return this.deps.now?.() ?? Date.now(); }
  private validateIdentity(state: NativeMemoryState) {
    if (state.principal !== this.deps.principal || state.namespace !== this.deps.namespace) {
      throw new Error('Memory queue identity changed; migration requires explicit action');
    }
  }
  private incomplete(state: NativeMemoryState): boolean {
    return state.position.sequence < state.highWater || !!state.pending;
  }
  enroll(chatId: number, botId: string | null, highWater = 0): void {
    if (!NATURAL(chatId) || !NATURAL(highWater) || botId !== null && !requiredText(botId)) throw new Error('Invalid memory enrollment');
    this.deps.store.transaction(() => {
      const old = this.deps.store.get(chatId);
      if (old) {
        this.validateIdentity(old);
        if (old.botId !== botId) throw new Error('Memory bot identity cannot change inside an existing chat');
        return;
      }
      const now = this.now();
      this.deps.store.put({ chatId, botId, principal: this.deps.principal, namespace: this.deps.namespace,
        generation: crypto.randomUUID(), highWater, position: { sequence: 0, sourceIndex: 0 },
        dueAt: highWater ? now + IDLE_MS : null, ...(highWater ? { firstPendingAt: now } : {}), attempts: 0 });
    });
  }
  append(chatId: number, sequence: number): void {
    if (!NATURAL(sequence)) throw new Error('Invalid memory sequence');
    const current = this.deps.store.get(chatId);
    if (!current) return;
    this.validateIdentity(current);
    if (!this.incomplete(current)) {
      current.attempts = 0; delete current.lastError; delete current.firstPendingAt;
    }
    const now = this.now();
    current.highWater = Math.max(current.highWater, sequence + 1);
    current.firstPendingAt ??= now;
    if (!current.attempts) current.dueAt = Math.min(now + IDLE_MS, current.firstPendingAt + MAX_WAIT_MS);
    this.deps.store.put(current);
  }
  checkpoint(chatId: number): void {
    const state = this.deps.store.get(chatId);
    if (!state || !this.incomplete(state) || state.attempts) return;
    state.dueAt = this.now(); this.deps.store.put(state);
  }
  remove(chatId: number): void { this.deps.store.delete(chatId); }
  nextAlarm(): number | null {
    const times = this.deps.store.list().flatMap(state => state.dueAt === null ? [] : [state.dueAt]);
    return times.length ? Math.min(...times) : null;
  }
  status(chatId: number): NativeMemoryStatus {
    const state = this.deps.store.get(chatId);
    if (!state) return { state: 'not-enrolled', acknowledgedThrough: -1, highWater: 0 };
    const incomplete = this.incomplete(state);
    return { state: incomplete ? state.lastError ? 'retrying' : 'pending' : 'caught-up',
      botId: state.botId, namespace: state.namespace, acknowledgedThrough: state.position.sequence - 1,
      ...(state.commonPosition || state.commonPending ? {
        commonSharing: 'paused' as const,
        commonAcknowledgedThrough: (state.commonPosition?.sequence ?? 0) - 1,
        commonBacklog: Math.max(0, state.highWater - (state.commonPosition?.sequence ?? 0)),
      } : {}),
      highWater: state.highWater, dueAt: state.dueAt, attempts: state.attempts,
      ...(state.lastError ? { error: state.lastError } : {}),
      ...(state.lastAcceptedAt !== undefined ? { lastAcceptedAt: state.lastAcceptedAt } : {}) };
  }
  drain(maxBatches = 8): Promise<void> {
    if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 32) throw new Error('Invalid drain batch limit');
    return this.running ??= this.run(maxBatches).finally(() => { this.running = undefined; });
  }
  private async run(limit: number): Promise<void> {
    for (let i = 0; i < limit; i++) {
      const due = this.deps.store.list().filter(state => state.dueAt !== null && state.dueAt <= this.now())
        .toSorted((a,b) => a.dueAt! - b.dueAt! || a.chatId - b.chatId)[0];
      if (!due) return;
      try { await this.send(due); }
      catch {
        this.deps.store.transaction(() => {
          const current = this.deps.store.get(due.chatId);
          if (!current || current.generation !== due.generation) return;
          current.attempts = Math.min(current.attempts + 1, 64);
          current.lastError = 'Agent Memory sync failed. Original text and unacknowledged pages are retained; retry is scheduled.';
          current.dueAt = this.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(current.attempts - 1, 7));
          this.deps.store.put(current);
        });
      }
    }
  }
  private async prepare(state: NativeMemoryState): Promise<FrozenBatch> {
    const position = structuredClone(state.position);
    const messages: FrozenBatch['messages'] = [];
    const snapshots: MemorySnapshot[] = [];
    for (let count = 0; count < MAX_BATCH_PAGES && position.sequence < state.highWater; count++) {
      const snapshot = position.snapshot ?? await this.deps.source.load(state.chatId, position.sequence, state.principal);
      if (!snapshot || snapshot.sequence !== position.sequence || !snapshot.sources.length ||
          !['user', 'assistant', 'system'].includes(snapshot.role) ||
          !Number.isFinite(Date.parse(snapshot.timestamp))) throw new Error('Canonical source record missing or invalid');
      position.snapshot = snapshot;
      if (!snapshots.some(saved => saved.sequence === snapshot.sequence)) snapshots.push(snapshot);
      const ref = snapshot.sources[position.sourceIndex];
      if (!ref) throw new Error('Invalid memory source position');
      const page = await this.deps.source.page(state.chatId, ref, position.cursor ?? ref.startCursor, state.principal);
      if (page.start !== (position.offset ?? 0)) throw new Error('Canonical memory pages are not contiguous');
      messages.push({ role: snapshot.role, timestamp: snapshot.timestamp, content: frame(state,snapshot,position.sourceIndex,page) });
      if (page.eof) {
        position.sourceIndex++;
        delete position.cursor;
        delete position.offset;
        if (position.sourceIndex === snapshot.sources.length) {
          position.sequence++;
          position.sourceIndex = 0;
          delete position.snapshot;
        }
      } else { position.cursor = page.nextCursor!; position.offset = page.end; }
    }
    if (!messages.length) throw new Error('No canonical memory pages available');
    return { id: crypto.randomUUID(), snapshots, messages, after: position };
  }

  private async send(state: NativeMemoryState): Promise<void> {
    this.validateIdentity(state);
    if (!this.incomplete(state)) {
      // Stale alarm after a successful commit: clear without reporting a remote success.
      this.deps.store.transaction(() => {
        const live = this.deps.store.get(state.chatId);
        if (live && live.generation === state.generation && !this.incomplete(live)) {
          live.dueAt = null; live.attempts = 0; delete live.lastError;
          delete live.firstPendingAt; this.deps.store.put(live);
        }
      });
      return;
    }
    if (!this.deps.binding) throw new Error('Native Agent Memory binding missing');
    const pending = state.pending ?? await this.prepare(state);
    // Freeze before remote calls, including the exact timestamp/UTF-8 fragments.
    const retained = this.deps.store.transaction(() => {
      const current = this.deps.store.get(state.chatId);
      if (!current || current.generation !== state.generation) return false;
      current.pending ??= pending;
      if (current.pending?.id !== pending.id) throw new Error('Memory batch changed concurrently');
      this.deps.store.put(current);
      return true;
    });
    if (!retained) return;
    for (const snapshot of pending.snapshots) await this.deps.source.authorize(state.chatId, snapshot, state.principal);
    const profileName = await memoryProfileName(state.principal, state.botId);
    const sessionId = await memorySessionId(this.deps.workspaceId, state.chatId);
    const profile = await bounded(this.deps.binding.getProfile(profileName));
    const live = this.deps.store.get(state.chatId);
    if (!live || live.generation !== state.generation) return;
    for (const snapshot of pending.snapshots) await this.deps.source.authorize(state.chatId, snapshot, state.principal);
    await bounded(profile.ingest(pending.messages.map(message => ({ ...message, timestamp: new Date(message.timestamp) })), { sessionId }));
    // An ambiguous response or failed ACK keeps the same frozen batch for idempotent retry.
    this.deps.store.transaction(() => {
      const current = this.deps.store.get(state.chatId);
      if (!current || current.generation !== state.generation || current.pending?.id !== pending.id) return;
      current.position = pending.after;
      delete current.pending; delete current.lastError;
      current.attempts = 0; current.lastAcceptedAt = this.now();
      const remaining = this.incomplete(current);
      current.dueAt = remaining ? this.now() + 1000 : null;
      if (!remaining) delete current.firstPendingAt;
      this.deps.store.put(current);
    });
  }
  async recall(chatId: number, query: string): Promise<MemoryRecall> {
    if (!requiredText(query) || utf8.encode(query).byteLength > 1024) throw new Error('Memory query must be 1–1024 UTF-8 bytes; it was not shortened');
    const state = this.deps.store.get(chatId);
    if (!state) throw new Error('Chat is not enrolled in native memory');
    this.validateIdentity(state);
    if (!this.deps.binding) throw new Error('Native Agent Memory binding missing');
    const profile = await bounded(this.deps.binding.getProfile(await memoryProfileName(state.principal,state.botId)));
    return bounded(profile.recall(query,{thinkingLevel:'low',responseLength:'short'}));
  }
}
