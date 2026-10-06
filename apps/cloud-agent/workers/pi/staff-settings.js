import { configuredModels, thinkingChoices } from "./command-settings.js";
import { commandAllowed, sourceId } from "./source-history.js";
import { tenantId } from "./conversation-store.js";
import { workflowHash } from "./workflow.js";
const requireValue = (ok, code) => { if (!ok) throw Error(code); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
export async function staffKey(owner, target) {
  commandAllowed(target, owner.env);
  requireValue(owner.ctx.id.toString() === owner.env.Credentials.idFromName("owner").toString(), "staff_settings_actor_denied");
  return "staff-settings:" + await workflowHash(JSON.stringify([tenantId(owner.env), target.channelId, target.managerId]));
}
export function permittedSettings(env, preference) {
  return { modelId: configuredModels(env).some(row => row.id === preference?.modelId) ? preference.modelId : env.OPENAI_MODEL, thinkingLevel: thinkingChoices.some(row => row.value === preference?.thinkingLevel) ? preference.thinkingLevel : "low" };
}
export async function staffSettings(owner, target) { return permittedSettings(owner.env, await owner.ctx.storage.get(await staffKey(owner, target))); }
export async function staffPatchKeys(owner, target, operationId, patch) {
  const key = await staffKey(owner, target);
  requireValue(typeof operationId === "string" && /^(?:start-[a-f0-9-]{36}|cmd-[a-f0-9-]{36}|ctm-[a-f0-9]{64})$/.test(operationId) && object(patch) && Object.keys(patch).length > 0 && Object.keys(patch).every(field => ["modelId", "thinkingLevel"].includes(field)), "staff_settings_input_invalid");
  requireValue(patch.modelId === undefined || configuredModels(owner.env).some(row => row.id === patch.modelId), "model_not_permitted");
  requireValue(patch.thinkingLevel === undefined || thinkingChoices.some(row => row.value === patch.thinkingLevel), "thinking_invalid");
  return { key, receiptKey: "staff-setting-operation:" + await workflowHash(JSON.stringify([key, operationId])), digest: await workflowHash(JSON.stringify([target.channelId, target.groupId, target.rootMessageId ?? null, Object.entries(patch).sort(([left], [right]) => left.localeCompare(right))])) };
}
export async function patchStaffTransaction(transaction, keys, patch) {
  const previous = await transaction.get(keys.receiptKey);
  requireValue(!previous || previous.digest === keys.digest, "staff_settings_operation_conflict");
  if (previous) return;
  // ponytail: 2,000 retained setting operations per tenant require explicit archival before more changes; pruning would make old replays unsafe.
  requireValue((await transaction.list({ prefix: "staff-setting-operation:", limit: 2001 })).size < 2000, "staff_settings_receipt_limit");
  await transaction.put(keys.key, { ...await transaction.get(keys.key), ...patch });
  await transaction.put(keys.receiptKey, { digest: keys.digest });
}
export async function patchStaffSettings(owner, { target, operationId, patch }) {
  const keys = await staffPatchKeys(owner, target, operationId, patch);
  requireValue(sourceId(target.rootMessageId), "staff_settings_target_denied");
  return owner.ctx.storage.transaction(async transaction => {
    await patchStaffTransaction(transaction, keys, patch);
    return permittedSettings(owner.env, await transaction.get(keys.key));
  });
}
