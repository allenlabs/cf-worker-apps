import { OpenCodeWorkerd } from '@opencode/sdk/workerd';
import { Agent, Model, Plugin, Provider } from '@opencode/plugin';
import { Message as NativeMessage, Media } from '@opencode/ai';
import type { ContentPart } from '@opencode/ai';
import type { LanguageModelV3, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { getSystemMessageText, validateToolArguments } from '@earendil-works/pi-ai';
import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai';
import type { AgentContext, AgentEvent, FinishTurn } from '@earendil-works/pi-agent-core';
import type { ModelHandle } from './ai-models';
import { prefixTables } from './opencode-prefix-tables';
import { zeroUsage } from './ai-invoke';

type NativeEntry = Awaited<ReturnType<OpenCodeWorkerd.Interface['sessions']['context']>>[number];
type NativeAssistant = Extract<NativeEntry, { type: 'assistant' }>;
const providerID = Provider.ID.make('cloud-agent-os');
const modelID = Model.ID.make('canonical-transport');
const carrier = 'aisdk:@ai-sdk/vercel';
const prefixPattern = /^os_native_[a-f0-9]{32}_$/;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const gate = <T>() => Promise.withResolvers<T>();

// OS owns persistence. Native session tables are disposable, never reused on restart.
async function cleanOwned(storage: DurableObjectStorage, key: string) {
  const prefixes = await storage.get<string[]>(key) ?? [];
  if (!Array.isArray(prefixes) || prefixes.some(prefix => !prefixPattern.test(prefix))) {
    throw new Error('Invalid native loop ownership registry');
  }
  storage.transactionSync(() => {
    storage.sql.exec('PRAGMA defer_foreign_keys = ON');
    for (const prefix of prefixes) {
      const tables = storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .toArray().filter(({ name }) => name.startsWith(prefix));
      for (const { name } of tables) storage.sql.exec(`DROP TABLE ${quote(name)}`);
    }
  });
  await storage.delete(key);
}

/** Native projection only; transport retains the complete OS DTO, including provider signatures. */
export function nativeHistory(messages: readonly Message[]): NativeMessage[] {
  return messages.flatMap(message => {
    if (message.role === 'system') return [];
    if (message.role === 'toolResult') return [NativeMessage.tool({
      id: message.toolCallId, name: message.toolName,
      result: { content: message.content, details: message.details },
      resultType: message.isError ? 'error' : 'json',
    })];
    const content: ContentPart[] = typeof message.content === 'string'
      ? [NativeMessage.text(message.content)]
      : message.content.flatMap((part): ContentPart[] => {
        switch (part.type) {
          case 'text': return [NativeMessage.text(part.text)];
          case 'thinking': return [{ type: 'reasoning', text: part.redacted ? '' : part.thinking,
            ...(part.thinkingSignature ? { encrypted: part.thinkingSignature } : {}) }];
          case 'toolCall': return [{ type: 'tool-call', id: part.id, name: part.name, input: part.arguments }];
          case 'image': return [NativeMessage.media(Media.base64(part.data, part.mimeType))];
          default: return [];
        }
      });
    return [message.role === 'assistant' ? NativeMessage.assistant(content) : NativeMessage.user(content)];
  });
}

/** OpenCode schedules the real loop; pi types remain the existing inference/storage protocol. */
export async function runOpenCodeLoop(args: {
  storage: DurableObjectStorage; chatId: number; context: AgentContext; handle: ModelHandle;
  maxTokens: number | undefined; emit: (event: AgentEvent) => Promise<void>; finishTurn: FinishTurn;
  signal: AbortSignal;
}): Promise<void> {
  const { storage, chatId, context, handle, emit, finishTurn, signal } = args;
  const key = `os:opencode-loop:owned:${chatId}`;
  await cleanOwned(storage, key);
  signal.throwIfAborted();
  const prefix = `os_native_${crypto.randomUUID().replaceAll('-', '')}_`;
  // SDK creation starts a suspended-session sweep, so ownership must be durable first.
  await storage.put(key, [prefix]);
  let native: OpenCodeWorkerd.Interface | undefined;
  let active = true;
  let phase: 'provider' | 'tools' | 'boundary' = 'provider';
  let current: AssistantMessage | undefined;
  let providerComplete = false;
  let committed = false;
  let stopped = false;
  let fatal: unknown;
  let requests = 0;
  let results: ToolResultMessage[] = [];
  let tail = Promise.resolve();
  const slots = new Map<string, { previous: Promise<void>; done: ReturnType<typeof gate<void>> }>();
  const never = gate<void>();
  const transportMessages: Message[] = context.messages.filter((message): message is Message =>
      message.role === 'system' || message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult');
  const tools = new Map((context.tools ?? []).map(tool => [tool.name, tool]));
  const fail = (error: unknown) => { fatal ??= error; };
  const publish = async (event: AgentEvent) => { try { await emit(event); } catch (error) { fail(error); throw error; } };

  const commit = async (assistant: NativeAssistant) => {
    if (committed) return false;
    if (!current || !providerComplete || assistant.time.completed === undefined || assistant.error || !assistant.finish ||
        assistant.content.some(part => part.type === 'tool' && part.state.status !== 'completed' && part.state.status !== 'error')) {
      throw new Error('Native loop attempted to commit an incomplete step');
    }
    // Native rejects unknown tools before callback dispatch. Keep an honest result for replay.
    for (const block of current.content) {
      if (block.type === 'toolCall' && !results.some(result => result.toolCallId === block.id)) {
        const part = assistant.content.find(part => part.type === 'tool' && part.id === block.id);
        const error = part?.type === 'tool' && part.state.status === 'error' ? part.state.error.message : 'Operation aborted';
        results.push({ role: 'toolResult', toolCallId: block.id, toolName: block.name,
          content: [{ type: 'text', text: error }], isError: true, timestamp: Date.now() });
        await publish({ type: 'tool_execution_end', toolCallId: block.id, toolName: block.name,
          result: results.at(-1), isError: true });
      }
    }
    const order = new Map(current.content.filter(part => part.type === 'toolCall').map((part, index) => [part.id, index]));
    results.sort((left, right) => (order.get(left.toolCallId) ?? 0) - (order.get(right.toolCallId) ?? 0));
    phase = 'boundary';
    const decision = await finishTurn({ message: current, toolResults: results, context, newMessages: [current, ...results] }, signal);
    await publish({ type: 'turn_end', message: current, toolResults: results });
    committed = true;
    transportMessages.push(current, ...results);
    return decision?.action === 'end';
  };

  const language: LanguageModelV3 = {
    specificationVersion: 'v3', provider: providerID, modelId: modelID, supportedUrls: {},
    async doGenerate() { throw new Error('OS uses streaming inference only'); },
    async doStream(options) {
      signal.throwIfAborted();
      // A server-owned bound stops runaway native passes without altering provider token policy.
      if (++requests > 64) {
        const error = new Error('OS native pass exceeded 64 model steps'); fail(error); throw error;
      }
      phase = 'provider'; current = undefined; providerComplete = false; committed = false; results = [];
      tail = Promise.resolve(); slots.clear();
      const stream = handle.stream(handle.model, { messages: transportMessages }, {
        maxTokens: args.maxTokens, signal: AbortSignal.any([signal, ...(options.abortSignal ? [options.abortSignal] : [])]),
      });
      const iterator = stream[Symbol.asyncIterator]();
      const pending: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      let ended = false;
      let failureEmitted = false;
      const open = new Map<number, 'text' | 'reasoning'>();
      return { stream: new ReadableStream<LanguageModelV3StreamPart>({
        async pull(controller) {
          try {
            while (!pending.length && !ended) {
              const item = await iterator.next();
              if (item.done) {
                ended = true;
                if (!current) throw new Error('Provider ended without a completed assistant response');
                if (signal.aborted) current = { ...current, stopReason: 'aborted',
                  errorMessage: signal.reason instanceof Error ? signal.reason.message : 'Operation aborted' };
                if (current.stopReason === 'error' || current.stopReason === 'aborted') {
                  await publish({ type: 'turn_end', message: current, toolResults: [] }); failureEmitted = true;
                  throw new Error(current.errorMessage ?? 'Model request aborted');
                }
                providerComplete = true; phase = 'tools';
                for (const [index, kind] of open) pending.push({ type: kind === 'text' ? 'text-end' : 'reasoning-end', id: String(index) });
                for (const part of current.content) {
                  if (part.type !== 'toolCall') continue;
                  if (slots.has(part.id)) throw new Error('Provider reused a tool call ID');
                  const done = gate<void>();
                  const previous = tail;
                  slots.set(part.id, { previous, done }); tail = done.promise;
                  if (!tools.has(part.name)) void previous.then(() => done.resolve());
                  pending.push({ type: 'tool-call', toolCallId: part.id, toolName: part.name, input: JSON.stringify(part.arguments) });
                }
                pending.push({ type: 'response-metadata', id: current.responseId,
                  modelId: current.model, timestamp: new Date(current.timestamp) });
                pending.push({ type: 'finish', finishReason: {
                  unified: current.stopReason === 'toolUse' ? 'tool-calls' : current.stopReason === 'length' ? 'length' : 'stop',
                  raw: current.stopReason }, usage: {
                    inputTokens: { total: current.usage.input + current.usage.cacheRead + current.usage.cacheWrite,
                      noCache: current.usage.input, cacheRead: current.usage.cacheRead, cacheWrite: current.usage.cacheWrite },
                    outputTokens: { total: current.usage.output, text: undefined, reasoning: undefined },
                  } });
                break;
              }
              if (!active) { ended = true; break; }
              const event = item.value;
              if (event.type === 'done') current = event.message;
              else if (event.type === 'error') current = event.error;
              else {
                await publish({ type: 'message_update', message: event.partial, assistantMessageEvent: event });
                const index = 'contentIndex' in event ? event.contentIndex : -1;
                if (event.type === 'text_start' || event.type === 'thinking_start') {
                  const kind = event.type === 'text_start' ? 'text' : 'reasoning'; open.set(index, kind);
                  pending.push({ type: kind === 'text' ? 'text-start' : 'reasoning-start', id: String(index) });
                } else if (event.type === 'text_delta' || event.type === 'thinking_delta') {
                  const kind = event.type === 'text_delta' ? 'text' : 'reasoning';
                  if (!open.has(index)) { open.set(index, kind); pending.push({ type: kind === 'text' ? 'text-start' : 'reasoning-start', id: String(index) }); }
                  pending.push({ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', id: String(index), delta: event.delta });
                }
              }
            }
            const part = pending.shift();
            if (part) controller.enqueue(part); else controller.close();
          } catch (error) {
            providerComplete = false;
            if (active && !failureEmitted) {
              current = { ...(current ?? { role: 'assistant', content: [], api: handle.model.api,
                provider: handle.model.provider, model: handle.model.id, usage: zeroUsage(), timestamp: Date.now() }),
                stopReason: signal.aborted ? 'aborted' : 'error',
                errorMessage: error instanceof Error ? error.message : String(error) };
              await publish({ type: 'turn_end', message: current, toolResults: [] });
            }
            controller.error(error);
          }
        },
        async cancel() { providerComplete = false; await iterator.return?.(); },
      }) };
    },
  };

  const plugin: Plugin.Plugin = { id: 'cloud-agent-os.native-loop', async setup(ctx) {
    await ctx.provider.transform(editor => editor.add({ info: { id: providerID, name: 'OS transport', activation: 'enabled',
      package: carrier, settings: { baseURL: 'https://transport.invalid/v1', apiKey: 'unused' } },
      models: [{ ...Model.Info.default(providerID, modelID), package: carrier,
        limit: { context: handle.model.contextWindow, output: args.maxTokens ?? handle.model.maxTokens } }] }));
    await ctx.aisdk.hook('language', event => { event.language = language; }, { providerID });
    await ctx.agent.transform(editor => editor.update('build', agent => {
      agent.permissions = [
        { action: '*', resource: '*', effect: 'allow' },
        // SDK synthesizes CodeMode execute even after builtin registrations are removed.
        { action: 'execute', resource: '*', effect: 'deny' },
      ];
    }));
    await ctx.session.hook('title', event => { event.result = 'OS turn'; });
    await ctx.session.hook('retry', event => { event.decision = { retry: false }; });
    await ctx.session.hook('context', async event => {
      try {
        if (fatal) throw fatal;
        if (!native) throw new Error('Native context before initialization');
        const entries = await native.sessions.context({ sessionID: event.sessionID });
        const assistant = entries.filter((entry): entry is NativeAssistant => entry.type === 'assistant').at(-1);
        if (assistant && !committed && await commit(assistant)) {
          stopped = true;
          await ctx.session.interrupt({ sessionID: event.sessionID, resume: false });
          await never.promise;
        }
        // Keep upstream prompts, compaction and exact tool history authoritative.
        event.system = transportMessages.filter(message => message.role === 'system')
            .map(message => ({ type: 'text', text: getSystemMessageText(message) }));
        event.messages = nativeHistory(transportMessages);
      } catch (error) { fail(error); throw error; }
    });
    await ctx.tool.transform(editor => {
      for (const tool of editor.list()) editor.remove(tool.id);
      for (const tool of context.tools ?? []) editor.add({ name: tool.name, description: tool.description,
        // Keep the existing OS tool argument validation before authorized callbacks.
        input: {}, options: { codemode: false },
        async execute(_input, nativeContext) {
          const slot = slots.get(nativeContext.id);
          if (!slot || !current || !providerComplete) throw new Error('Tool outside completed OS provider step');
          try {
            await slot.previous;
            let result: ToolResultMessage;
            try {
              if (!active || signal.aborted || nativeContext.signal.aborted) throw new Error('Operation aborted');
              const call = current.content.find(part => part.type === 'toolCall' && part.id === nativeContext.id);
              if (!call || call.type !== 'toolCall' || call.name !== tool.name) throw new Error('Tool call identity mismatch');
              const params = validateToolArguments(tool, call);
              const output = await tool.execute(nativeContext.id, params, signal);
              result = { role: 'toolResult', toolCallId: nativeContext.id, toolName: tool.name,
                content: output.content, details: output.details, isError: output.isError ?? false,
                ...(output.usage ? { usage: output.usage } : {}), timestamp: Date.now() };
            } catch (error) {
              result = { role: 'toolResult', toolCallId: nativeContext.id, toolName: tool.name,
                content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
                isError: true, timestamp: Date.now() };
            }
            results.push(result);
            await publish({ type: 'tool_execution_end', toolCallId: result.toolCallId, toolName: result.toolName,
              result, isError: result.isError });
            // Exact content/details travel in the OS DTO; native needs the execution outcome.
            if (result.isError) throw new Error(result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join(''));
            return { content: JSON.stringify({ content: result.content, details: result.details }) };
          } finally { slot.done.resolve(); }
        },
      });
    });
  } };
  let sessionID: Parameters<OpenCodeWorkerd.Interface['sessions']['wait']>[0]['sessionID'] | undefined;
  const abort = () => { if (phase === 'provider' && native && sessionID) void native.sessions.interrupt({ sessionID, resume: false }).catch(fail); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    native = await OpenCodeWorkerd.create({ storage: prefixTables(storage, prefix), models: { fetch: false }, plugins: [plugin], config: { compaction: { auto: false } },
      log: { level: 'error', emit() {} } });
    signal.throwIfAborted();
    const session = await native.sessions.create({ location: { directory: '/os' }, title: 'OS turn',
      model: { providerID, id: modelID }, agent: Agent.ID.make('build') });
    sessionID = session.id;
    await native.sessions.prompt({ sessionID, text: 'Continue the canonical OS conversation.' });
    await native.sessions.wait({ sessionID });
    if (fatal) throw fatal;
    const entries = await native.sessions.context({ sessionID });
    const terminal = entries.at(-1);
    const assistant = entries.filter((entry): entry is NativeAssistant => entry.type === 'assistant').at(-1);
    const transportFailed = current?.stopReason === 'error' || current?.stopReason === 'aborted';
    if (!stopped && !signal.aborted && !transportFailed &&
        (terminal?.type !== 'idle' || terminal.outcome !== 'succeeded' || !assistant ||
          assistant.error || assistant.time.completed === undefined ||
          (assistant.finish !== 'stop' && assistant.finish !== 'length'))) {
      throw new Error('Native loop ended without a successful completed assistant');
    }
    if (!stopped && providerComplete && !committed && assistant) await commit(assistant);
    // Transport failures were delivered to the existing OS retry/error policy above.

  } finally {
    signal.removeEventListener('abort', abort);
    active = false;
    if (native) await native.close();
    await cleanOwned(storage, key);
  }
}
