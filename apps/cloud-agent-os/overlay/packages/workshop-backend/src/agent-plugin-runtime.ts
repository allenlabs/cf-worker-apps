import { Type, validateToolArguments } from '@earendil-works/pi-ai';
import type { JsonObject } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AgentResource } from '@gadgets/workshop-shared/api';
import { z } from 'zod';
import { createPortablePluginRuntime, portablePluginWorkerSource } from './agent-plugin-adapter';
import { pluginDigest, pluginInstallationId, readPluginArtifact, readPluginResult, samePluginSource } from './agent-plugin-artifacts';
import { installedAgentPlugins } from './installed-agent-plugins';

/** Dependencies remain in the authenticated OS; a dynamic plugin receives only its JSON options. */
export type AgentPluginServices = { bucket: R2Bucket; loader: WorkerLoader; principal: string };
const toolDescriptors = z.array(z.object({ name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  description: z.string().max(4_000), input: z.record(z.string(), z.unknown()).refine(value => value.type === 'object'),
}).strict()).max(16);
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** Resolve only approved, published packages and recheck the live policy before every tool or hook. */
export async function resolvePackagePluginResources(args: {
  resources: readonly AgentResource[];
  loadResource?: (id: string) => Promise<AgentResource | undefined>;
  services: AgentPluginServices;
}): Promise<{ tools: AgentTool[]; prompt: string }> {
  const tools: AgentTool[] = [];
  const prompts: string[] = [];
  for (const resource of args.resources) {
    if (!resource.enabled || resource.kind !== 'plugin' || resource.pluginId !== 'package' || resource.execution === 'pending') continue;
    try {
      const resourceTools: AgentTool[] = [];
      const snapshotOptions = resource.options;
      const selected = { id: resource.id, source: resource.source, execution: resource.execution };
      const installationId = await pluginInstallationId(selected);
      const authorize = async () => {
        const current = await args.loadResource?.(resource.id);
        if (!current || !current.enabled || current.kind !== 'plugin' || current.pluginId !== 'package'
          || current.execution !== resource.execution || current.options !== snapshotOptions
          || await pluginInstallationId({ id: current.id, source: current.source, execution: selected.execution }) !== installationId) throw new Error('Plugin unavailable, changed, or access revoked; retry the turn');
        const result = await readPluginResult(args.services.bucket, selected);
        if ((result.status !== 'ready' && result.status !== 'active') || !result.artifactDigest) throw new Error('Plugin installation is not ready');
        return result.artifactDigest;
      };
      // Absence of an installer result means queued; it must not prevent unrelated OS tools from running.
      const initial = await readPluginResult(args.services.bucket, selected);
      if ((initial.status !== 'ready' && initial.status !== 'active') || !initial.artifactDigest) continue;
      const digest = await authorize();
      const artifact = await readPluginArtifact(args.services.bucket, digest);
      if (!samePluginSource(artifact.source, resource.source)) throw new Error('Plugin artifact source mismatch');
      let invoke: (operation: 'describe' | 'context' | 'execute', input?: { name: string; args: unknown; callId: string }) => Promise<unknown>;
      if (resource.execution === 'host') {
        const load = installedAgentPlugins[digest];
        if (!load) continue;
        const runtime = await createPortablePluginRuntime(await load(), resource.options);
        invoke = async (operation, input) => {
          if (operation === 'describe') return runtime.describe();
          if (operation === 'context') return runtime.context();
          if (!input) throw new Error('Plugin execution input missing');
          return runtime.execute(input.name, input.args, input.callId);
        };
      } else {
        const identity = await pluginDigest(JSON.stringify({ principal: args.services.principal, resourceId: resource.id, digest, options: resource.options }));
        const worker = args.services.loader.get(`agent-plugin-v1:${identity}`, () => ({
          compatibilityDate: '2026-02-01', mainModule: 'main.js',
          modules: { 'main.js': portablePluginWorkerSource(), 'plugin.js': artifact.module },
          env: { options: resource.options }, globalOutbound: null, limits: { cpuMs: 50, subRequests: 0 },
        }));
        invoke = async (operation, input) => {
          const body = JSON.stringify({ operation, ...input });
          if (bytes(body) > 64_000) throw new Error('Plugin request exceeds its size limit');
          const response = await worker.getEntrypoint().fetch('https://plugin.invalid/', { method: 'POST', body });
          if (!response.ok) throw new Error('Portable plugin failed or uses an unsupported API');
          const declaredLength = response.headers.get('Content-Length');
          if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > 64_000)) throw new Error('Plugin response exceeds its size limit');
          if (!response.body) throw new Error('Plugin response is empty');
          const reader = response.body.getReader();
          const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
          let text = '', size = 0;
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > 64_000) {
                await reader.cancel();
                throw new Error('Plugin response exceeds its size limit');
              }
              text += decoder.decode(chunk.value, { stream: true });
            }
            text += decoder.decode();
          } finally { reader.releaseLock(); }
          return JSON.parse(text);
        };
      }
      const descriptors = toolDescriptors.parse(await invoke('describe'));
      if (bytes(JSON.stringify(descriptors)) > 64_000) throw new Error('Plugin tool descriptors exceed their size limit');
      const prefix = `plugin_${(await pluginDigest(resource.id)).slice(0, 16)}_`;
      const names = new Set<string>();
      for (const descriptor of descriptors) {
        const parameters = Type.Unsafe<JsonObject>(descriptor.input);
        const suffix = descriptor.name.length <= 40 ? descriptor.name
          : `${descriptor.name.slice(0, 31)}_${(await pluginDigest(descriptor.name)).slice(0, 8)}`;
        const name = `${prefix}${suffix}`;
        if (names.has(name)) throw new Error('Plugin tool identity conflict');
        names.add(name);
        const tool: AgentTool<typeof parameters> = { name, label: `${resource.name}: ${descriptor.name}`,
          description: descriptor.description, parameters,
          async execute(callId, input, signal) {
            if (signal?.aborted) throw new Error('Plugin execution aborted');
            if (await authorize() !== digest) throw new Error('Plugin installation changed; retry the turn');
            const validated = validateToolArguments(tool, { type: 'toolCall', id: callId, name, arguments: input });
            const text = await invoke('execute', { name: descriptor.name, args: validated, callId });
            if (typeof text !== 'string' || bytes(text) > 64_000) throw new Error('Plugin tool result exceeds its size limit');
            return { content: [{ type: 'text', text }], details: { output: text, pluginResourceId: resource.id } };
          },
        };
        resourceTools.push(tool);
      }
      if (await authorize() !== digest) throw new Error('Plugin installation changed; retry the turn');
      const prompt = await invoke('context');
      if (typeof prompt !== 'string' || bytes(prompt) > 16_000) throw new Error('Plugin context exceeds its size limit');
      if (tools.length + resourceTools.length > 128 || bytes([...prompts, prompt].join('\n\n')) > 64_000) {
        throw new Error('Installed plugins exceed the agent resource limit');
      }
      tools.push(...resourceTools);
      if (prompt) prompts.push(prompt);
    } catch {
      const hint = `Plugin ${JSON.stringify({ id: resource.id, name: resource.name })} is unavailable. Review its installation and portable API compatibility in Agent settings.`;
      if (bytes([...prompts, hint].join('\n\n')) <= 64_000) prompts.push(hint);
    }
  }
  const prompt = prompts.join('\n\n');
  return { tools, prompt };
}
