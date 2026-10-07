import { staffSettings, staffPatchKeys, patchStaffTransaction } from "./staff-settings.js";
import { commandAllowed, sourceId, sourceThreadKey } from "./source-history.js";
import { configuredModels, thinkingChoices, startInput } from "./command-settings.js";
import { workflowFromSkill, workflowHash, workflowRender, workflowFinalText } from "./workflow.js";
import { tenantId } from "./conversation-store.js";
import { visitJson } from "../visit/contract.js";
const requireValue = (ok, code) => { if (!ok) throw Error(code); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
function targetFor(owner, target) {
  commandAllowed(target, owner.env);
  requireValue(target.rootMessageId === undefined && uuid(target.nonce) && owner.ctx.id.toString() === owner.env.Credentials.idFromName("owner").toString(), "command_start_target_denied");
  return target;
}
const groupKey = target => workflowHash(JSON.stringify([target.channelId, target.groupId])).then(hash => "command-start-group:" + hash);
export async function workflows(owner) {
  const rows = await owner.skillCatalog(), result = [];
  for (const row of rows.filter(row => row.enabled)) {
    const definition = workflowFromSkill(await owner.publishedSkill(row.name, row.revision));
    if (definition) result.push({ name: row.name, revision: row.revision, definition });
  }
  return result;
}
export async function startOptions(owner, target) {
  targetFor(owner, target);
  const preferred = await staffSettings(owner, target);
  return { kind: "start-options", workflows: await workflows(owner), settings: { models: configuredModels(owner.env).map(({ id, label }) => ({ id, label })), model: { id: preferred.modelId }, thinkingChoices, thinking: { value: preferred.thinkingLevel } } };
}
export async function rootWorkflowDefinition(owner, target, name, revision) {
  targetFor(owner, target);
  requireValue(typeof name === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64 && /^[a-f0-9]{64}$/.test(revision ?? ""), "workflow_input_invalid");
  const definition = workflowFromSkill(await owner.publishedSkill(name, revision));
  requireValue(definition, "workflow_skill_unavailable");
  return { definition, scope: await workflowHash(JSON.stringify([tenantId(owner.env), owner.ctx.id.toString(), target])) };
}
export async function rootWorkflowStatus(owner, target, operationId, reviewDigest) {
  requireValue(/^[a-f0-9]{64}$/.test(reviewDigest ?? ""), "workflow_input_invalid");
  const row = await receipt(owner, target, operationId);
  requireValue(!row || row.reviewDigest === reviewDigest, "workflow_operation_conflict");
  return row ? project(await finish(owner, row)) : null;
}
async function receipt(owner, target, operationId) {
  targetFor(owner, target); requireValue(uuid(operationId), "command_start_input_invalid");
  const row = await owner.ctx.storage.get("command-start:" + operationId);
  requireValue(!row || JSON.stringify(row.target) === JSON.stringify(target), "command_start_operation_conflict");
  return row;
}
async function finish(owner, row) {
  if (row.state !== "created") return row;
  const threadKey = await sourceThreadKey({ ...row.target, rootMessageId: row.rootMessageId }), barrier = await groupKey(row.target), patch = { modelId: row.intent.modelId, thinkingLevel: row.intent.thinkingLevel };
  const preferenceKeys = await staffPatchKeys(owner, row.target, "start-" + row.operationId, patch);
  return owner.ctx.storage.transaction(async transaction => {
    const current = await transaction.get("command-start:" + row.operationId);
    if (current.state !== "created") return current;
    const old = await transaction.get("threadStart:" + threadKey), index = await transaction.get("threadIndex") || [];
    requireValue(!index.some(item => item.threadKey === threadKey) && (!old || old.operationId === row.operationId), "command_start_root_active");
    if (!current.recovery) await patchStaffTransaction(transaction, preferenceKeys, patch);
    const next = { ...current, state: "ready" };
    await transaction.put("threadStart:" + threadKey, { operationId: row.operationId, target: { channelId: row.target.channelId, groupId: row.target.groupId, rootMessageId: row.rootMessageId }, intent: row.intent });
    await transaction.put("command-start:" + row.operationId, next);
    if ((await transaction.get(barrier))?.operationId === row.operationId) await transaction.delete(barrier);
    return next;
  });
}
const project = row => row ? { operationId: row.operationId, status: row.state === "creating" ? "uncertain" : row.state, ...(row.rootMessageId ? { rootMessageId: row.rootMessageId, intent: row.intent } : {}) } : null;
export async function startStatus(owner, target, operationId) {
  const row = await receipt(owner, target, operationId);
  return project(row ? await finish(owner, row) : null) ?? { operationId, status: "unknown" };
}
export async function createThread(owner, input) {
  const { target, operationId, intent } = input; startInput({ action: "create", operationId, intent, confirmed: input.confirmed }); targetFor(owner, target);
  const reviewed = input.reviewedWorkflow;
  requireValue(intent.workflow ? keys(reviewed, ["reviewDigest", "textHash", "values", "source", "finalText"]) && /^[a-f0-9]{64}$/.test(reviewed.reviewDigest ?? "") && /^[a-f0-9]{64}$/.test(reviewed.textHash ?? "") : reviewed === undefined, "workflow_confirmation_required");
  if (reviewed?.finalText !== undefined) requireValue(await workflowHash(workflowFinalText(reviewed.finalText)) === reviewed.textHash, "workflow_draft_changed");
  const requestDigest = await workflowHash(JSON.stringify([tenantId(owner.env), target, intent, ...(reviewed ? [reviewed.reviewDigest, reviewed.textHash, ...(reviewed.finalText === undefined ? [] : [await workflowHash(reviewed.finalText)])] : [])]));
  const previous = await receipt(owner, target, operationId);
  if (previous) { requireValue(previous.requestDigest === requestDigest, "command_start_operation_conflict"); return project(await finish(owner, previous)); }
  requireValue(owner.env.CHANNEL_REPLY_ENABLED === "true" && target.groupId === owner.env.ALLOWED_CHAT_ID, "command_start_delivery_denied");
  requireValue(configuredModels(owner.env).some(row => row.id === intent.modelId), "command_start_model_not_permitted");
  let plainText = "새 AI 업무를 시작합니다.";
  if (intent.workflow) {
    requireValue(target.groupId === owner.env.VISIT_MCP_GROUP_ID, "workflow_delivery_denied");
    const { definition } = await rootWorkflowDefinition(owner, target, intent.workflow.name, intent.workflow.revision);
    requireValue(definition.source === "none" ? reviewed.source === null : object(reviewed.source), "workflow_input_invalid");
    plainText = workflowRender(definition, reviewed.values, reviewed.source, reviewed.finalText).text;
    requireValue(await workflowHash(plainText) === reviewed.textHash, "workflow_draft_changed");
  }
  const nonceKey = "command-start-nonce:" + await workflowHash(JSON.stringify([tenantId(owner.env), target.nonce])), barrier = await groupKey(target), key = "command-start:" + operationId;
  const claimed = await owner.ctx.storage.transaction(async transaction => {
    const existing = await transaction.get(key);
    if (existing) { requireValue(existing.requestDigest === requestDigest, "command_start_operation_conflict"); return false; }
    requireValue(!await transaction.get(nonceKey), "command_start_launch_used");
    requireValue(!await transaction.get(barrier), "command_start_group_uncertain");
    requireValue((await transaction.list({ prefix: "command-start:", limit: 2001 })).size < 2000, "command_start_receipt_limit");
    await transaction.put(key, { operationId, nonce: target.nonce, requestDigest, target, intent, ...(reviewed ? { reviewDigest: reviewed.reviewDigest, textHash: reviewed.textHash } : {}), state: "creating" });
    await transaction.put(nonceKey, operationId); await transaction.put(barrier, { operationId }); return true;
  });
  if (!claimed) return startStatus(owner, target, operationId);
  owner.activeStarts ||= new Set(); owner.activeStarts.add(operationId);
  let result, issued = false;
  try {
    const access = await owner.channelAccess(); issued = true;
    const response = await fetch("https://app-store-api.channel.io/general/v1/native/functions", { method: "PUT", redirect: "manual", signal: AbortSignal.timeout(15000), headers: { "content-type": "application/json", "x-access-token": access }, body: JSON.stringify({ method: "writeGroupMessage", params: { channelId: target.channelId, groupId: target.groupId, broadcast: false, dto: { plainText, botName: owner.env.PRODUCT_NAME || "Cloud Agent", requestId: "start-" + operationId } } }) });
    const envelope = await visitJson(response, 262144);
    result = !response.ok || envelope.error ? { state: [400, 401, 403, 404, 422].includes(response.status) ? "failed" : "uncertain" } : validRoot(envelope.result?.message, target) ? { state: "created", rootMessageId: envelope.result.message.id } : { state: "uncertain" };
  } catch { result = { state: issued ? "uncertain" : "failed" }; }
  try {
    const row = await owner.ctx.storage.transaction(async transaction => {
      const current = await transaction.get(key);
      if (current.state !== "creating") return current;
      const next = { ...current, ...result };
      await transaction.put(key, next);
      if (result.state === "failed" && (await transaction.get(barrier))?.operationId === operationId) await transaction.delete(barrier);
      return next;
    });
    return project(await finish(owner, row));
  } finally { owner.activeStarts.delete(operationId); }
}
function validRoot(message, target) {
  return object(message) && sourceId(message.id) && (message.channelId === undefined || message.channelId === target.channelId) && (message.chatId === undefined || message.chatId === target.groupId) && (message.chatType === undefined || ["group", "groupChat"].includes(message.chatType)) && (message.threadMsg == null || message.threadMsg === false) && (message.rootMessageId == null || message.rootMessageId === message.id);
}
export async function startReceipts(owner) {
  const rows = [...(await owner.ctx.storage.list({ prefix: "command-start:", limit: 2000 })).values()];
  return rows.filter(row => ["creating", "created", "uncertain"].includes(row.state)).slice(-50).map(row => ({ operationId: row.operationId, status: row.state, channelId: row.target.channelId, groupId: row.target.groupId, rootMessageId: row.rootMessageId, inFlight: owner.activeStarts?.has(row.operationId) === true }));
}
export async function recoverStart(owner, input) {
  requireValue(keys(input, ["operationId", "action", "rootMessageId", "confirmed"]) && uuid(input.operationId) && ["bind", "abandon"].includes(input.action) && input.confirmed === true && (input.action === "bind" ? sourceId(input.rootMessageId) : input.rootMessageId === undefined), "command_start_recovery_invalid");
  requireValue(!owner.activeStarts?.has(input.operationId), "command_start_in_flight");
  const key = "command-start:" + input.operationId, prior = await owner.ctx.storage.get(key);
  const recovery = { action: input.action, ...(input.action === "bind" ? { rootMessageId: input.rootMessageId } : {}) };
  requireValue(prior && (!prior.recovery || JSON.stringify(prior.recovery) === JSON.stringify(recovery)), "command_start_recovery_denied");
  if (["ready", "abandoned"].includes(prior.state)) { requireValue(prior.recovery, "command_start_recovery_denied"); return project(prior); }
  requireValue(["creating", "created", "uncertain"].includes(prior.state), "command_start_recovery_denied");
  requireValue(input.action !== "bind" || prior.rootMessageId === undefined || prior.rootMessageId === input.rootMessageId, "command_start_operation_conflict");
  const barrier = await groupKey(prior.target);
  const row = await owner.ctx.storage.transaction(async transaction => {
    const current = await transaction.get(key);
    if (["ready", "abandoned"].includes(current.state) && JSON.stringify(current.recovery) === JSON.stringify(recovery)) return current;
    requireValue(["creating", "created", "uncertain"].includes(current.state) && (!current.recovery || JSON.stringify(current.recovery) === JSON.stringify(recovery)) && (await transaction.get(barrier))?.operationId === input.operationId && !owner.activeStarts?.has(input.operationId), "command_start_recovery_denied");
    const next = { ...current, recovery, state: input.action === "bind" ? "created" : "abandoned", ...(input.action === "bind" ? { rootMessageId: input.rootMessageId } : {}) };
    await transaction.put(key, next);
    if (input.action === "abandon") await transaction.delete(barrier);
    return next;
  });
  return project(await finish(owner, row));
}
export async function threadStartPreferences(owner, target) {
  requireValue(keys(target, ["channelId", "groupId", "rootMessageId"]) && target.channelId === owner.env.ALLOWED_CHANNEL_ID && [target.channelId, target.groupId, target.rootMessageId].every(sourceId), "command_start_target_denied");
  const threadKey = await sourceThreadKey(target), preferences = await owner.ctx.storage.get("threadStart:" + threadKey);
  if (preferences) { requireValue(["channelId", "groupId", "rootMessageId"].every(key => preferences.target[key] === target[key]), "command_start_target_denied"); return preferences; }
  // ponytail: an unknown native root holds new roots in its group until explicit recovery; provider root receipts would permit narrower holds.
  const registered = (await owner.threads()).some(row => row.threadKey === threadKey);
  requireValue(registered || !await owner.ctx.storage.get(await groupKey(target)), "command_start_group_uncertain");
  return null;
}
