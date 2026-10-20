/** JSON-only tools exposed by the portable OpenCode v2 plugin profile. */
export type PortablePluginTool = { name: string; description: string; input: Record<string, unknown> };

/** The same adapter is called directly for trusted host code and serialized into isolated Workers. */
export async function createPortablePluginRuntime(module: unknown, options: string) {
  // Keep this function self-contained: Worker Loader receives its compiled source, never eval().
  const maxBytes = 64_000;
  const plain = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (typeof options !== 'string' || new TextEncoder().encode(options).byteLength > 16_384) throw new Error('Portable plugin options exceed their size limit');
  const parsedOptions: unknown = JSON.parse(options);
  let optionNodes = 0;
  const validateOptions = (value: unknown, depth: number): boolean => {
    if (++optionNodes > 2048 || depth > 16) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    return Array.isArray(value) ? value.every(item => validateOptions(item, depth + 1))
      : plain(value) && Object.values(value).every(item => validateOptions(item, depth + 1));
  };
  if (!plain(parsedOptions) || !validateOptions(parsedOptions, 0)) throw new Error('Portable plugin options must be a bounded JSON object');
  const boundedJson = (value: unknown, limit = maxBytes): unknown => {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > limit) {
      throw new Error('Portable plugin JSON exceeds its size limit');
    }
    return JSON.parse(serialized);
  };
  const unsupported = () => { throw new Error('Unsupported portable OpenCode plugin API'); };
  const limited = <T extends object>(value: T): T => new Proxy(value, {
    get(target, property, receiver) {
      if (property === 'then') return undefined;
      if (!Reflect.has(target, property)) return unsupported();
      return Reflect.get(target, property, receiver);
    },
  });
  type Tool = PortablePluginTool & { id: string; execute: (input: unknown, context: object) => unknown };
  const tools = new Map<string, Tool>();
  const hooks: Array<(event: { system: Array<{ type: 'text'; text: string }> }) => unknown> = [];
  const parseTool = (value: unknown): Tool => {
    if (!plain(value) || typeof value.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value.name)
      || typeof value.description !== 'string' || typeof value.execute !== 'function' || !plain(value.input)) {
      throw new Error('Portable plugin requires named JSON Schema tools');
    }
    const schema = boundedJson(value.input, 16_000);
    if (!plain(schema) || schema.type !== 'object') throw new Error('Portable plugin tool input must be an object schema');
    // Codecs and Standard Schema adapters cannot cross the isolate boundary. Only JSON Schema is portable.
    if (JSON.stringify(value.input) !== JSON.stringify(schema)) throw new Error('Portable plugin tool schema must be JSON');
    const description = value.description;
    if (new TextEncoder().encode(description).byteLength > 4_000) throw new Error('Portable plugin tool description exceeds its size limit');
    const execute = value.execute;
    return { id: value.name, name: value.name, description, input: schema,
      execute: (input, context) => execute(input, context) };
  };
  const editor = limited({
    list: () => [...tools.values()],
    get: (id: string) => tools.get(id),
    add(value: unknown) {
      const tool = parseTool(value);
      if (tools.has(tool.id) || tools.size >= 16) throw new Error('Portable plugin tool count or identity conflict');
      tools.set(tool.id, tool);
    },
    update(id: string, update: (tool: Tool) => void) {
      const tool = tools.get(id);
      if (tool) {
        update(tool);
        const validated = parseTool(tool);
        if (validated.id !== id && tools.has(validated.id)) throw new Error('Portable plugin tool identity conflict');
        tools.delete(id); tools.set(validated.id, validated);
      }
    },
    remove(id: string) { tools.delete(id); },
  });
  const context = limited({
    options: parsedOptions,
    tool: limited({ async transform(transform: (registeredEditor: typeof editor) => unknown) { await transform(editor); } }),
    session: limited({ async hook(name: string, callback: (event: { system: Array<{ type: 'text'; text: string }> }) => unknown) {
      if (name !== 'context' || typeof callback !== 'function' || hooks.length >= 8) return unsupported();
      hooks.push(callback);
    } }),
  });
  if (!plain(module)) throw new Error('Portable plugin module must export an OpenCode v2 Plugin');
  const plugin = module.default ?? module.Plugin;
  if (!plain(plugin) || typeof plugin.id !== 'string' || plugin.id.length > 128 || typeof plugin.setup !== 'function') {
    throw new Error('Portable plugin module must export an OpenCode v2 Plugin');
  }
  if (await plugin.setup(context) !== undefined) {
    throw new Error('Portable plugin setup must return void; cleanup lifecycle is unsupported');
  }
  for (const [id, tool] of tools) {
    const checked = parseTool(tool);
    if (checked.id !== id) throw new Error('Portable plugin tools must be renamed through editor.update');
    tools.set(id, checked);
  }
  return {
    describe(): PortablePluginTool[] {
      const descriptors = [...tools.values()].map(({ name, description, input }) => ({ name, description, input }));
      boundedJson(descriptors);
      return descriptors;
    },
    async execute(name: string, input: unknown, callId: string) {
      const tool = tools.get(name);
      if (!tool) throw new Error('Portable plugin tool unavailable');
      const result = await tool.execute(boundedJson(input), limited({ id: callId,
        signal: new AbortController().signal, async progress() { return unsupported(); } }));
      const output = boundedJson(result);
      if (!plain(output)) throw new Error('Portable plugin tool result must be an object');
      const content = output.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content) && content.every(part => plain(part) && part.type === 'text' && typeof part.text === 'string')) {
        return content.map(part => part.text).join('\n');
      }
      if (output.output !== undefined) return JSON.stringify(output.output);
      throw new Error('Portable plugin tool result requires text content or JSON output');
    },
    async context() {
      const system: Array<{ type: 'text'; text: string }> = [];
      const event = limited({ system });
      for (const hook of hooks) await hook(event);
      if (event.system !== system || !system.every(part => plain(part) && part.type === 'text' && typeof part.text === 'string')) {
        throw new Error('Portable plugin context may only append system text');
      }
      const prompt = system.map(part => part.text).join('\n\n');
      if (new TextEncoder().encode(prompt).byteLength > 16_000) throw new Error('Portable plugin context exceeds its size limit');
      return prompt;
    },
  };
}

/** Loader entry uses the exact compiled host adapter without a second implementation. */
export function portablePluginWorkerSource(): string {
  return `import * as plugin from './plugin.js';
const initialize = ${createPortablePluginRuntime.toString()};
let pending;
export default { async fetch(request, env) {
  try {
    if (request.method !== 'POST') return new Response(null, {status:405});
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 64000) return new Response(null, {status:413});
    const input = JSON.parse(text);
    const runtime = await (pending ??= initialize(plugin, env.options));
    let result;
    if (input.operation === 'describe') result = runtime.describe();
    else if (input.operation === 'context') result = await runtime.context();
    else if (input.operation === 'execute' && typeof input.name === 'string' && typeof input.callId === 'string') result = await runtime.execute(input.name,input.args,input.callId);
    else return new Response(null,{status:400});
    const body = JSON.stringify(result);
    if (new TextEncoder().encode(body).byteLength > 64000) return new Response(null,{status:413});
    return new Response(body,{headers:{'Content-Type':'application/json'}});
  } catch { return new Response('Portable plugin failed or uses an unsupported API',{status:422}); }
} };`;
}
