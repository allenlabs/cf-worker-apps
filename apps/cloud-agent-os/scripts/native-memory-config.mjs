import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/** The explicit deployment opt-in is the consent to automatic transcript capture. */
export function validateNativeMemory(config) {
  if (config.agentMemory === undefined) return;
  const memory = config.agentMemory;
  assert(memory && typeof memory === 'object' && !Array.isArray(memory), 'agentMemory must be an object');
  assert(Object.keys(memory).every(key => ['namespace', 'capture'].includes(key)), 'Unsupported agentMemory field');
  assert(typeof memory.namespace === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(memory.namespace), 'agentMemory.namespace must be a lowercase name of at most 32 characters');
  assert(memory.capture === 'all-conversations', 'agentMemory.capture must explicitly be all-conversations');
  const allowed = config.auth.mode === 'access' ? config.auth.allowedEmails : config.auth.allowedIdentities?.map(identity => identity.email);
  assert(Array.isArray(allowed) && allowed.length === 1 && typeof allowed[0] === 'string' && allowed[0].trim(), 'Native memory requires exactly one allowed user');
  assert(config.siteLaunch === undefined, 'Native personal memory is not enabled for embedded site deployments');
  return { namespace: memory.namespace, principal: allowed[0] };
}

export function configureNativeMemory(result, config) {
  const memory = validateNativeMemory(config);
  if (!memory) return;
  const existing = result.workshop.agent_memory ?? [];
  assert(!existing.some(binding => binding.binding === 'OS_AGENT_MEMORY'), 'OS_AGENT_MEMORY binding already exists');
  result.workshop.agent_memory = [...existing, { binding: 'OS_AGENT_MEMORY', namespace: memory.namespace }];
  Object.assign(result.workshop.vars, { AUTO_MEMORY_OWNER: memory.principal, AUTO_MEMORY_NAMESPACE: memory.namespace });
}

/** Only the deployment process calls this. Workers use their native binding, not this token. */
export async function ensureNativeMemoryNamespace(config, token = process.env.CLOUDFLARE_API_TOKEN, fetchImpl = fetch) {
  const memory = validateNativeMemory(config);
  if (!memory) return;
  assert(/^[a-f0-9]{32}$/.test(config.accountId), 'Invalid Cloudflare account ID');
  assert(typeof token === 'string' && token.trim() && !/[\r\n]/.test(token), 'Namespace provisioning requires CLOUDFLARE_API_TOKEN with Agent Memory permissions');
  const root = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/agent-memory/namespaces`;
  const url = `${root}/${encodeURIComponent(memory.namespace)}`;
  const request = async (target, method, body) => {
    try {
      return await fetchImpl(target, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(20_000) });
    } catch { throw new Error('Agent Memory namespace request failed; no credentials or response body were logged'); }
  };
  const verify = async response => {
    assert(response.ok, `Agent Memory namespace verification failed (HTTP ${response.status})`);
    let body;
    try { body = await response.json(); } catch { throw new Error('Invalid Agent Memory namespace response'); }
    assert(body?.success === true && body.result?.name === memory.namespace, 'Agent Memory namespace read-back did not match');
  };
  const existing = await request(url, 'GET');
  if (existing.status !== 404) { await verify(existing); return; }
  const created = await request(root, 'POST', { name: memory.namespace });
  assert(created.ok || created.status === 409, `Agent Memory namespace creation failed (HTTP ${created.status})`);
  // Also read back after 409: a race is not proof that the desired namespace is usable.
  await verify(await request(url, 'GET'));
}

/** Provision only from the deployment bytes already sealed by the artifact manifest. */
export async function provisionFrozenNativeMemory({ bytes, expectedDigest, accountId, token, fetchImpl }) {
  assert(createHash('sha256').update(bytes).digest('hex') === expectedDigest, 'ARTIFACT_DEPLOYMENT_CONFIG_CHANGED');
  const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (config.agentMemory === undefined) return;
  assert(config.accountId === accountId, 'ARTIFACT_ACCOUNT_INVALID');
  await ensureNativeMemoryNamespace(config, token, fetchImpl);
}
