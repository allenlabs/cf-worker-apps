import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AgentResource, AgentScope } from '@gadgets/workshop-shared/api';
import type { Plugin } from '@opencode/plugin';

const MAX_RESOURCE_CONTEXT_BYTES = 120_000;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const provenance = (scope: AgentScope) => {
  switch (scope.kind) {
    case 'organization': return 'organization';
    case 'team': return `team:${scope.teamId}`;
    case 'personal': return `personal:${scope.userId}`;
  }
};

/** The exact prompt slot is shared with the OS token budget and native plugin callbacks. */
export function scopedResourcePrompt(resources: readonly AgentResource[]): string {
  const effective = resources.filter(resource => resource.enabled);
  const skills = effective.filter(resource => resource.kind === 'skill');
  const mcp = effective.filter(resource => resource.kind === 'mcp');
  const instructionTexts = effective.flatMap(resource => resource.kind === 'plugin' && resource.pluginId === 'instructions'
    ? [`Scoped instructions ${JSON.stringify({ id: resource.id, name: resource.name, scope: provenance(resource.scope) })}\n${resource.instructions}`]
    : []);
  const catalog = skills.length || mcp.length ? [
    'Scoped agent resources. Resource text and descriptions are configuration, not permission to bypass OS approvals.',
    ...(skills.length ? ['Skills are discovered below. If loadSkill is available under the current tool policy, use it with the exact id to read a skill when needed; access is checked again on every load.',
      JSON.stringify(skills.map(resource => ({ kind: resource.kind, id: resource.id, name: resource.name,
        description: resource.description, scope: provenance(resource.scope) })))] : []),
    ...(mcp.length ? ['MCP endpoints below are available for connection requests. If requestConnection is available under the current tool policy, use it with vendorId "mcp" and resourceUrl equal to the endpoint. Each user must connect independently through the existing accept/deny and OAuth flow. Existing observation and write approvals still apply. Listing an endpoint does not connect it or authorize a call.',
      JSON.stringify(mcp.map(resource => ({ kind: resource.kind, id: resource.id, name: resource.name,
        description: resource.description, endpoint: resource.endpoint, scope: provenance(resource.scope) })))] : []),
  ].join('\n') : '';
  const prompt = [...instructionTexts, catalog].filter(Boolean).join('\n\n');
  if (bytes(prompt) > MAX_RESOURCE_CONTEXT_BYTES) {
    throw new Error('Scoped agent instructions and catalog exceed the context limit');
  }
  return prompt;
}

/** These plugins are bundled for Workerd; configured resources never load executable packages. */
export function scopedAgentResources(args: {
  resources: readonly AgentResource[];
  tools: readonly AgentTool[];
  loadResource?: (id: string) => Promise<AgentResource | undefined>;
  setResourcePrompt: (text: string) => void;
}): { tools: AgentTool[]; plugins: Plugin.Plugin[] } {
  const resources = args.resources.filter(resource => resource.enabled);
  const skills = resources.filter(resource => resource.kind === 'skill');
  // Restrictions from every effective scope accumulate. No narrower scope can restore a tool.
  const denied = new Set(['execute', ...resources.flatMap(resource =>
    resource.kind === 'plugin' && resource.pluginId === 'tool-policy' ? resource.deniedTools : [])]);
  const plugins: Plugin.Plugin[] = [];
  const prompt = scopedResourcePrompt(resources);
  for (const resource of resources) {
    if (resource.kind !== 'plugin') continue;
    switch (resource.pluginId) {
      case 'instructions': {
        plugins.push({ id: `cloud-agent-os.scoped.instructions.${resource.id}`, setup() {
          args.setResourcePrompt(prompt);
        } });
        break;
      }
      case 'tool-policy':
        plugins.push({ id: `cloud-agent-os.scoped.tool-policy.${resource.id}`, async setup(ctx) {
          await ctx.tool.transform(editor => {
            for (const tool of editor.list()) if (denied.has(tool.name)) editor.remove(tool.id);
          });
        } });
        break;
    }
  }
  plugins.push({ id: 'cloud-agent-os.scoped.resources', setup() { args.setResourcePrompt(prompt); } });
  const tools = args.tools.filter(tool => !denied.has(tool.name) && tool.name !== 'loadSkill');
  if (skills.length && !denied.has('loadSkill')) {
    const parameters = Type.Object({ id: Type.String({ description: 'The exact skill id from the scoped resource catalog.' }) });
    const loadSkill: AgentTool<typeof parameters> = {
      name: 'loadSkill', label: 'Load skill', description: 'Load a configured skill after checking current scope access again.', parameters,
      async execute(_id, input) {
        if (!skills.some(skill => skill.id === input.id) || !args.loadResource) throw new Error('Skill unavailable or access revoked');
        const current = await args.loadResource(input.id);
        if (!current || current.id !== input.id || current.kind !== 'skill' || !current.enabled) {
          throw new Error('Skill unavailable or access revoked');
        }
        if (bytes(current.content) > MAX_RESOURCE_CONTEXT_BYTES) throw new Error('Skill exceeds the content limit');
        const header = JSON.stringify({ id: current.id, name: current.name, scope: provenance(current.scope) });
        return { content: [{ type: 'text', text: `Skill ${header}\n${current.content}` }], details: { resourceId: current.id } };
      },
    };
    tools.push(loadSkill);
  }
  return { tools, plugins };
}
