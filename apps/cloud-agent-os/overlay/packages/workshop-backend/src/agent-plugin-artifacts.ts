import { z } from 'zod';
import type { AgentPluginArtifact, AgentPluginInstallation, AgentPluginSource, AgentResource, AgentSettingsView } from '@gadgets/workshop-shared/agent-settings';

export const AGENT_PLUGIN_PREFIX = 'agent-plugins/v1/';
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('npm'), name: z.string().max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/),
    version: z.string().max(128).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
      .refine(value => !(value.split('+')[0].match(/^[\d.]+-(.*)$/)?.[1].split('.').some(part => /^0\d+$/.test(part)))) }).strict(),
  z.object({ kind: z.literal('bundle'), digest: digestSchema }).strict(),
]);
function validIntegrity(value: string): boolean {
  const match = /^sha(256|384|512)-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length !== 4 * Math.ceil(Number(match[1]) / 8 / 3)) return false;
  const bytes = atob(match[2]);
  return bytes.length === Number(match[1]) / 8 && btoa(bytes) === match[2];
}
const artifactSchema = z.object({ apiVersion: z.literal(1), source: sourceSchema,
  module: z.string().min(1).max(MAX_ARTIFACT_BYTES), packageIntegrity: z.string().max(1024).nullable(), lockDigest: digestSchema.nullable() }).strict()
  .refine(value => value.source.kind === 'bundle'
    ? value.packageIntegrity === null && value.lockDigest === null
    : value.packageIntegrity !== null && validIntegrity(value.packageIntegrity) && value.lockDigest !== null,
  'Plugin artifact provenance does not match its source.');
const resultSchema = z.object({ apiVersion: z.literal(1), id: digestSchema, status: z.enum(['queued', 'building', 'verifying', 'deploying', 'ready', 'failed']),
  artifactDigest: digestSchema.nullable(), error: z.string().max(1000).nullable(), updatedAt: z.string().datetime() }).strict()
  .refine(value => value.status !== 'ready' || value.artifactDigest !== null, 'Ready installation has no artifact.');
export type PackageAgentPlugin = Extract<AgentResource, { pluginId: 'package' }>;
type ApprovedPlugin = PackageAgentPlugin & { execution: 'host' | 'dynamic' };
export type AgentPluginDesired = { apiVersion: 1; revision: number; plugins: PackageAgentPlugin[] };
type PluginSelection = Pick<ApprovedPlugin, 'id' | 'source' | 'execution'>;
const encoder = new TextEncoder();

export async function pluginDigest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalPluginSource(source: AgentPluginSource): AgentPluginSource {
  const parsed = sourceSchema.parse(source);
  return parsed.kind === 'npm' ? { kind: 'npm', name: parsed.name, version: parsed.version } : { kind: 'bundle', digest: parsed.digest };
}

export function samePluginSource(left: AgentPluginSource, right: AgentPluginSource): boolean {
  return JSON.stringify(canonicalPluginSource(left)) === JSON.stringify(canonicalPluginSource(right));
}

export async function pluginInstallationId(resource: PluginSelection): Promise<string> {
  if (resource.execution !== 'host' && resource.execution !== 'dynamic') throw new Error('Plugin execution requires organization approval.');
  return pluginDigest(JSON.stringify({ resourceId: resource.id, source: canonicalPluginSource(resource.source), execution: resource.execution }));
}

async function boundedObject(bucket: R2Bucket, key: string, maximum = MAX_ARTIFACT_BYTES): Promise<string | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size > maximum) throw new Error('Plugin object exceeds the size limit.');
  const text = await object.text();
  if (encoder.encode(text).byteLength > maximum) throw new Error('Plugin object exceeds the size limit.');
  return text;
}

export async function readPluginArtifact(bucket: R2Bucket, digest: string): Promise<AgentPluginArtifact> {
  digestSchema.parse(digest);
  const raw = await boundedObject(bucket, `${AGENT_PLUGIN_PREFIX}artifacts/${digest}.json`);
  if (raw === null) throw new Error('Installed plugin artifact is unavailable.');
  if (await pluginDigest(raw) !== digest) throw new Error('Installed plugin artifact failed its integrity check.');
  return artifactSchema.parse(JSON.parse(raw));
}

export async function readPluginResult(bucket: R2Bucket, resource: PluginSelection): Promise<AgentPluginInstallation> {
  const id = await pluginInstallationId(resource);
  const raw = await boundedObject(bucket, `${AGENT_PLUGIN_PREFIX}results/${id}.json`, 4096);
  const base = { id, resourceId: resource.id, execution: resource.execution };
  if (raw === null) return { ...base, status: 'queued', artifactDigest: null, error: null, updatedAt: null };
  const result = resultSchema.parse(JSON.parse(raw));
  if (result.id !== id) throw new Error('Plugin installation result does not match the request.');
  return { ...base, status: result.status, artifactDigest: result.artifactDigest, error: result.error, updatedAt: result.updatedAt };
}

export class AgentPluginInstallations {
  #publication: Promise<void> = Promise.resolve();
  #publishedRevision = -1;
  #requests = new Set<string>();

  constructor(private readonly bucket: R2Bucket, private readonly hostInventory: Readonly<Record<string, unknown>>) {}

  async sync(readDesired: () => Promise<AgentPluginDesired>): Promise<void> {
    const publication = this.#publication.catch(() => {}).then(async () => {
      const current = await readDesired();
      const desired = { ...current, plugins: current.plugins.filter(plugin => plugin.enabled && plugin.execution !== 'pending').toSorted((left, right) => left.id.localeCompare(right.id)) };
      if (desired.revision === this.#publishedRevision) return;
      for (const plugin of desired.plugins) {
        if (plugin.execution === 'pending') continue;
        const selected: PluginSelection = { id: plugin.id, source: plugin.source, execution: plugin.execution };
        const id = await pluginInstallationId(selected);
        if (this.#requests.has(id)) continue;
        const key = `${AGENT_PLUGIN_PREFIX}requests/${id}.json`;
        const raw = JSON.stringify({ apiVersion: 1, id, resourceId: plugin.id,
          source: canonicalPluginSource(plugin.source), execution: plugin.execution });
        const written = await this.bucket.put(key, raw, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
        if (!written && await boundedObject(this.bucket, key, 4096) !== raw) throw new Error('Plugin installation request failed its identity check.');
        this.#requests.add(id);
      }
      await this.bucket.put(`${AGENT_PLUGIN_PREFIX}desired.json`, JSON.stringify(desired), { httpMetadata: { contentType: 'application/json' } });
      this.#publishedRevision = desired.revision;
    });
    this.#publication = publication;
    return publication;
  }

  async view(view: AgentSettingsView, queueError: string | null = null): Promise<AgentSettingsView> {
    const selections = new Map<string, Pick<PackageAgentPlugin, 'id' | 'source' | 'execution'>>();
    for (const resource of [...view.resources, ...view.effectiveResources]) {
      if (resource.kind === 'plugin' && resource.pluginId === 'package') selections.set(resource.id, resource);
    }
    for (const review of view.pluginReviews) selections.set(review.id, review);
    const pluginInstallations: AgentPluginInstallation[] = [];
    let pluginInstallerError = queueError;
    for (const resource of selections.values()) {
      if (resource.execution === 'pending') continue;
      try {
        const result = await readPluginResult(this.bucket, { id: resource.id, source: resource.source, execution: resource.execution });
        const active = result.status === 'ready' && result.execution === 'host' && result.artifactDigest !== null && Object.hasOwn(this.hostInventory, result.artifactDigest);
        pluginInstallations.push(active ? { ...result, status: 'active' } : result);
      } catch {
        pluginInstallerError ??= 'Plugin installation status is unavailable. Reload to retry.';
      }
    }
    return { ...view, pluginInstallations, pluginInstallerError };
  }
}
