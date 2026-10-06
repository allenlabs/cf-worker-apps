import { startInput, selectedSkill } from "../../../cloud-agent/workers/pi/command-settings.js";
import { workflowHash, workflowInput, workflowPrefill, workflowRender, workflowSource } from "../../../cloud-agent/workers/pi/workflow.js";
import { commandAllowed, sourceId, sourceThreadKey } from "../../../cloud-agent/workers/pi/source-history.js";
import { aiPanel } from "./command-view.js";
import { visitErrors, visitInput, visitJson, visitOutputSize, visitResult } from "../../../cloud-agent/workers/visit/contract.js";
const encoder = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const unb64 = text => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), value => value.charCodeAt(0));
const requireValue = (ok, code) => { if (!ok) throw new Error(code); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const actionSchema = { type: "object", properties: { chat: { type: "object", properties: { type: { type: "string" }, id: { type: "string" } }, required: ["type", "id"] }, trigger: { type: "object", additionalProperties: true }, input: { type: "object", additionalProperties: true }, language: { type: "string" } }, additionalProperties: false };
const suggestSchema = { type: "object", properties: { chat: actionSchema.properties.chat, input: { type: "array", maxItems: 2, items: { type: "object", properties: { name: { type: "string", enum: ["mode", "workflow"] }, value: { type: "string", maxLength: 100 }, focused: { type: "boolean" } }, required: ["name", "value", "focused"], additionalProperties: false } }, language: { type: "string" } }, required: ["chat", "input"], additionalProperties: false };
const bindSchema = { type: "object", properties: { targetCapability: { type: "string" }, rootMessageId: { type: "string", maxLength: 255 } }, required: ["targetCapability", "rootMessageId"], additionalProperties: false };
const startSchema = { type: "object", properties: { targetCapability: { type: "string" }, action: { type: "string", enum: ["options", "create", "status"] }, operationId: { type: "string", format: "uuid" }, confirmed: { type: "boolean" }, intent: { type: "object", additionalProperties: false, properties: { modelId: { type: "string", maxLength: 128 }, thinkingLevel: { type: "string" }, workflow: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, revision: { type: "string" } }, required: ["name", "revision"] } }, required: ["modelId", "thinkingLevel"] } }, required: ["targetCapability", "action"], additionalProperties: false };
const operationSchema = { type: "object", properties: { targetCapability: { type: "string" }, operationId: { type: "string", format: "uuid" }, action: { type: "string", enum: ["help", "model", "thinking", "ask", "history", "image"] }, args: { type: "string", maxLength: 8000 }, contextSource: { type: "string", enum: ["api", "shared"] }, sharedContext: { type: "string", maxLength: 32768 }, skill: { type: "object", properties: { name: { type: "string", maxLength: 64 }, revision: { type: "string" } }, required: ["name", "revision"], additionalProperties: false } }, required: ["targetCapability", "operationId", "action", "args"], additionalProperties: false };
const visitSchema = { type: "object", properties: { targetCapability: { type: "string" }, action: { type: "string", enum: ["patientSearch", "visitSelect", "draft"] }, query: { type: "string", maxLength: 64 }, patientId: { type: "string", format: "uuid" }, visitId: { type: ["string", "null"], format: "uuid" }, fields: { type: "object", properties: { kind: { type: "string", enum: ["arrival", "treatment"] }, concernArea: { type: "string", maxLength: 200 }, revision: { type: "string", enum: ["unknown", "yes", "no"] }, schedulingExceptions: { type: "string", maxLength: 500 }, externalNameChecked: { type: "string", enum: ["unknown", "yes", "no"] } }, required: ["kind", "concernArea", "revision", "schedulingExceptions", "externalNameChecked"], additionalProperties: false } }, required: ["targetCapability", "action"], additionalProperties: false };
const workflowSchema = { type: "object", properties: { targetCapability: { type: "string" }, action: { type: "string", enum: ["catalog", "prefill", "prepare", "send", "status"] }, name: { type: "string" }, revision: { type: "string" }, selection: { type: "object", additionalProperties: false, properties: { patientId: { type: "string", format: "uuid" }, visitId: { type: "string", format: "uuid" } }, required: ["patientId", "visitId"] }, values: { type: "object", additionalProperties: { type: "string", maxLength: 1000 }, maxProperties: 20 }, operationId: { type: "string", format: "uuid" }, draftToken: { type: "string", maxLength: 4096 }, confirmed: { type: "boolean" }, confirmations: { type: "array", items: { type: "string" }, maxItems: 10 } }, required: ["targetCapability", "action"], additionalProperties: false };
export const commandFunctions = [
  { name: "extension.command.metadata.getCommands", inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema: { type: "object", properties: { commands: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["commands"] } },
  { name: "commands.ai.open", inputSchema: actionSchema, outputSchema: { type: "object", properties: { type: { type: "string" }, attributes: { type: "object", additionalProperties: true } }, required: ["type"] } },
  { name: "commands.ai.suggest", inputSchema: suggestSchema, outputSchema: { type: "object", properties: { choices: { type: "array", maxItems: 10, items: { type: "object", properties: { name: { type: "string" }, value: { type: "string" } }, required: ["name", "value"], additionalProperties: false } } }, required: ["choices"], additionalProperties: false } },
  { name: "commands.ai.start", inputSchema: startSchema, outputSchema: { type: "object", additionalProperties: true } },
  { name: "commands.ai.bindThread", inputSchema: bindSchema, outputSchema: { type: "object", additionalProperties: true } },
  { name: "commands.ai.workflow", inputSchema: workflowSchema, outputSchema: { type: "object", additionalProperties: true } },
  { name: "commands.ai.visit", inputSchema: visitSchema, outputSchema: { type: "object", additionalProperties: true } },
  ...["execute", "status"].map(name => ({ name: `commands.ai.${name}`, inputSchema: operationSchema, outputSchema: { type: "object", additionalProperties: true } }))
];
function caller(context, env) {
  requireValue(context?.channel?.id === env.ALLOWED_CHANNEL_ID && context.caller?.type === "manager" && sourceId(context.caller.id), "command_caller_denied");
  return context.caller.id;
}
async function key(env) {
  requireValue(typeof env.CHANNEL_APP_SIGNING_KEY === "string" && /^(?:[a-fA-F0-9]{2}){16,64}$/.test(env.CHANNEL_APP_SIGNING_KEY), "command_signing_unavailable");
  return crypto.subtle.importKey("raw", Uint8Array.from(env.CHANNEL_APP_SIGNING_KEY.match(/../g), value => parseInt(value, 16)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function capability(target, env) {
  const payload = b64(encoder.encode(JSON.stringify(target)));
  return `${payload}.${b64(new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), encoder.encode(`channel-command-target/v1:${payload}`))))}`;
}
async function verify(value, context, env) {
  requireValue(typeof value === "string" && value.length <= 4096 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value), "command_capability_invalid");
  const [payload, signature] = value.split(".");
  requireValue(await crypto.subtle.verify("HMAC", await key(env), unb64(signature), encoder.encode(`channel-command-target/v1:${payload}`)), "command_capability_invalid");
  const target = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(unb64(payload)));
  requireValue(target.version === 1 && Number.isSafeInteger(target.expiresAt) && target.expiresAt > Date.now() && target.expiresAt <= Date.now() + 1200000 && /^[a-f0-9-]{36}$/.test(target.nonce) && target.managerId === caller(context, env), "command_capability_expired_or_mismatched");
  return commandAllowed(target, env);
}
async function readVisit(target, visit, env) {
  requireValue(env.VISIT_API && typeof env.VISIT_SERVICE_TOKEN === "string" && env.VISIT_SERVICE_TOKEN.length >= 32, "visit_not_configured");
  let response;
  try { response = await env.VISIT_API.fetch("https://visit.internal/read", { method: "POST", redirect: "manual", signal: AbortSignal.timeout(15000), headers: { "content-type": "application/json", authorization: "Bearer " + env.VISIT_SERVICE_TOKEN }, body: JSON.stringify({ target, input: visit }) }); }
  catch { throw Error("visit_backend_unavailable"); }
  const result = await visitJson(response);
  if (!response.ok) throw Error(visitErrors.includes(result?.error) ? result.error : "visit_backend_unavailable");
  return visitOutputSize(visitResult(result, visit));
}
async function draftToken(payload, env) {
  const value = b64(encoder.encode(JSON.stringify(payload)));
  return `${value}.${b64(new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), encoder.encode(`channel-workflow-draft/v1:${value}`))))}`;
}
async function verifyDraft(token, target, operationId, env, fresh) {
  requireValue(typeof token === "string" && token.length <= 4096 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token), "workflow_draft_invalid");
  const [value, signature] = token.split(".");
  requireValue(await crypto.subtle.verify("HMAC", await key(env), unb64(signature), encoder.encode(`channel-workflow-draft/v1:${value}`)), "workflow_draft_invalid");
  let payload; try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(unb64(value))); } catch { throw Error("workflow_draft_invalid"); }
  requireValue(payload.version === 1 && payload.operationId === operationId && payload.targetHash === await workflowHash(JSON.stringify(target)) && Number.isSafeInteger(payload.expiresAt) && (!fresh || payload.expiresAt > Date.now()) && payload.expiresAt <= Date.now() + 600000, "workflow_draft_expired_or_mismatched");
  return payload;
}
const workflowValuesHash = values => workflowHash(JSON.stringify(Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)))));
async function workflowFunction(value, target, assistant, env) {
  if (value.action === "catalog") return assistant.workflowCatalog(target);
  if (value.action === "status") {
    const payload = await verifyDraft(value.draftToken, target, value.operationId, env, false);
    return await assistant.workflowStatus(target, value.operationId, await workflowHash(JSON.stringify(payload))) ?? { operationId: value.operationId, status: "unknown" };
  }
  let reviewed;
  if (value.action === "send") {
    reviewed = await verifyDraft(value.draftToken, target, value.operationId, env, true);
    requireValue(reviewed.name === value.name && reviewed.revision === value.revision && reviewed.selectionHash === await workflowHash(JSON.stringify(value.selection ?? null)) && reviewed.valuesHash === await workflowValuesHash(value.values), "workflow_draft_changed");
    requireValue(reviewed.confirmationsHash === await workflowHash(JSON.stringify([...value.confirmations].sort())), "workflow_confirmation_required");
    const previous = await assistant.workflowStatus(target, value.operationId, await workflowHash(JSON.stringify(reviewed)));
    if (previous) return previous;
  }
  const { definition, scope } = await assistant.workflowDefinition(target, value.name, value.revision);
  requireValue(definition.source === "visit-context" ? value.selection : value.selection === undefined, "workflow_selection_required");
  const context = definition.source === "visit-context" ? await readVisit(target, visitInput({ action: "visitSelect", ...value.selection }), env) : null;
  const source = context ? workflowSource(context) : null;
  if (value.action === "prefill") return { kind: "prefill", name: value.name, revision: value.revision, values: workflowPrefill(definition, source), ...(context ? { mode: context.mode } : {}) };
  const rendered = workflowRender(definition, value.values, source);
  const fields = { version: 1, scope, targetHash: await workflowHash(JSON.stringify(target)), name: value.name, revision: value.revision, selectionHash: await workflowHash(JSON.stringify(value.selection ?? null)), valuesHash: await workflowValuesHash(rendered.values), confirmationsHash: await workflowHash(JSON.stringify(definition.confirmations.map(check => check.id).sort())), textHash: await workflowHash(rendered.text), sourceHash: await workflowHash(JSON.stringify(source)) };
  if (value.action === "prepare") {
    const payload = { ...fields, operationId: crypto.randomUUID(), expiresAt: Date.now() + 600000 };
    return { kind: "draft", name: value.name, revision: value.revision, operationId: payload.operationId, expiresAt: payload.expiresAt, draftToken: await draftToken(payload, env), text: rendered.text, ...(context ? { mode: context.mode } : {}) };
  }
  requireValue(Object.entries(fields).every(([key, value]) => reviewed[key] === value), "workflow_draft_changed");
  const checks = definition.confirmations.map(check => check.id);
  requireValue(value.confirmations.length === checks.length && new Set(value.confirmations).size === checks.length && checks.every(id => value.confirmations.includes(id)), "workflow_confirmation_required");
  return assistant.workflowSend({ target, operationId: value.operationId, requestDigest: await workflowHash(JSON.stringify(reviewed)), name: value.name, revision: value.revision, values: rendered.values, source, textHash: fields.textHash, confirmed: true });
}

export function commandPage() {
  return new Response(aiPanel(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors https://*.channel.io https://channel.works https://*.channel.works" } });
}
export async function commandFunction(input, env) {
  const params = input.params;
  requireValue(object(params), "command_parameters_invalid");
  if (input.method === "extension.command.metadata.getCommands") {
    requireValue(Object.keys(params).length === 0, "command_parameters_invalid");
    return { commands: [{ name: "ai", scope: "desk", description: "이 스레드의 AI 질문·이미지·대화 이력·모델·생각 수준", actionFunctionName: "commands.ai.open", autoCompleteFunctionName: "commands.ai.suggest", paramDefinitions: [{ name: "mode", type: "string", required: false, description: "단축어로 업무 양식 열기", choices: [{ name: "단축어", value: "shortcut" }] }, { name: "workflow", type: "string", required: false, description: "업무 단축어 선택", autoComplete: true }], systemVersion: "v1", alfMode: "disable", enabledByDefault: true }] };
  }
  if (input.method === "commands.ai.suggest") {
    requireValue(Object.keys(params).every(name => Object.hasOwn(suggestSchema.properties, name)) && ["group", "groupChat"].includes(params.chat?.type) && sourceId(params.chat.id) && Array.isArray(params.input) && params.input.length <= 2 && params.input.every(row => object(row) && Object.keys(row).length === 3 && Object.keys(row).every(key => ["name", "value", "focused"].includes(key)) && ["mode", "workflow"].includes(row.name) && typeof row.value === "string" && row.value.length <= 100 && !/[\x00-\x1f]/.test(row.value) && typeof row.focused === "boolean") && new Set(params.input.map(row => row.name)).size === params.input.length && params.input.filter(row => row.focused).length <= 1, "command_shortcut_invalid");
    const target = commandAllowed({ channelId: input.context.channel?.id, groupId: params.chat.id, managerId: caller(input.context, env) }, env), focused = params.input.find(row => row.focused);
    if (!focused) return { choices: [] };
    if (focused.name === "mode") return { choices: "단축어 shortcut".includes(focused.value.trim()) ? [{ name: "단축어", value: "shortcut" }] : [] };
    requireValue(env.PI_CREDENTIALS, "command_start_not_configured");
    return env.PI_CREDENTIALS.get(env.PI_CREDENTIALS.idFromName("owner")).suggestShortcuts(target, focused.value);
  }
  if (input.method === "commands.ai.open") {
    requireValue(Object.keys(params).every(name => Object.hasOwn(actionSchema.properties, name)) && ["group", "groupChat"].includes(params.chat?.type) && sourceId(params.chat.id), "command_group_required");
    const rootMessageId = params.trigger?.attributes?.rootMessageId;
    requireValue(rootMessageId === undefined || sourceId(rootMessageId), "command_root_invalid");
    const target = commandAllowed({ version: 1, channelId: input.context.channel?.id, groupId: params.chat.id, ...(rootMessageId === undefined ? {} : { rootMessageId }), managerId: caller(input.context, env), expiresAt: Date.now() + 1200000, nonce: crypto.randomUUID() }, env);
    const typed = params.input ?? {};
    requireValue(object(typed) && Object.keys(typed).every(key => ["mode", "workflow"].includes(key)) && Object.values(typed).every(value => typeof value === "string" && value.length <= 100 && !/[\x00-\x1f]/.test(value)) && (!typed.mode || ["shortcut", "단축어"].includes(typed.mode)), "command_shortcut_invalid");
    let selectedWorkflow;
    if (typed.workflow?.trim()) { requireValue(env.PI_CREDENTIALS, "command_start_not_configured"); selectedWorkflow = await env.PI_CREDENTIALS.get(env.PI_CREDENTIALS.idFromName("owner")).resolveShortcut(target, typed.workflow.trim()); }
    return { type: "wam", attributes: { appId: env.CHANNEL_APP_ID, name: "ai", wamArgs: { targetCapability: await capability(target, env), rootAvailable: rootMessageId !== undefined, ...(selectedWorkflow ? { selectedWorkflow } : {}) } } };
  }
  if (input.method === "commands.ai.start") {
    const { targetCapability, ...raw } = params, value = startInput(raw), target = await verify(targetCapability, input.context, env);
    requireValue(!target.rootMessageId, "command_start_target_denied"); requireValue(env.PI_CREDENTIALS, "command_start_not_configured");
    const owner = env.PI_CREDENTIALS.get(env.PI_CREDENTIALS.idFromName("owner"));
    const result = value.action === "options" ? await owner.commandStartOptions(target) : value.action === "status" ? await owner.commandStartStatus(target, value.operationId) : await owner.commandStart({ target, operationId: value.operationId, intent: value.intent, confirmed: value.confirmed });
    return result.status === "ready" ? { ...result, targetCapability: await capability({ ...target, rootMessageId: result.rootMessageId }, env), rootAvailable: true } : result;
  }
  if (input.method === "commands.ai.bindThread") {
    requireValue(Object.keys(params).every(name => Object.hasOwn(bindSchema.properties, name)) && sourceId(params.rootMessageId), "command_root_invalid");
    const target = await verify(params.targetCapability, input.context, env);
    requireValue(target.rootMessageId === undefined || target.rootMessageId === params.rootMessageId, "command_root_retarget_denied");
    return { targetCapability: await capability({ ...target, rootMessageId: params.rootMessageId }, env), rootAvailable: true, rootSource: target.rootMessageId === undefined ? "wam-selection" : "bound" };
  }
  if (input.method === "commands.ai.workflow") {
    const { targetCapability, ...raw } = params, value = workflowInput(raw), target = await verify(targetCapability, input.context, env);
    requireValue(target.rootMessageId, "command_thread_required"); requireValue(env.PI_ASSISTANT, "command_assistant_unavailable");
    const resolved = { channelId: target.channelId, groupId: target.groupId, rootMessageId: target.rootMessageId, managerId: target.managerId };
    const assistant = env.PI_ASSISTANT.get(env.PI_ASSISTANT.idFromName(await sourceThreadKey(resolved)));
    return workflowFunction(value, resolved, assistant, env);
  }
  if (input.method === "commands.ai.visit") {
    const { targetCapability, ...value } = params, visit = visitInput(value);
    const target = await verify(targetCapability, input.context, env);
    requireValue(target.rootMessageId, "command_thread_required");
    return readVisit({ channelId: target.channelId, groupId: target.groupId, rootMessageId: target.rootMessageId, managerId: target.managerId }, visit, env);
  }
  requireValue(Object.keys(params).every(name => Object.hasOwn(operationSchema.properties, name)) && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(params.operationId) && ["help", "model", "thinking", "ask", "history", "image"].includes(params.action) && typeof params.args === "string" && encoder.encode(params.args).length <= 8000 && !params.args.includes("\0"), "command_operation_invalid");
  if (params.skill !== undefined) { selectedSkill(params.skill); requireValue(params.action === "ask", "command_skill_invalid"); }
  const target = await verify(params.targetCapability, input.context, env);
  if (!target.rootMessageId) {
    requireValue(params.action === "help" && !params.args, "command_thread_required");
    return { operationId: params.operationId, status: "done", message: "업무·모델·생각 수준을 고르고 새 업무 시작을 누르면 새 스레드에서 이어갈 수 있습니다." };
  }
  requireValue(env.PI_ASSISTANT, "command_assistant_unavailable");
  const threadKey = await sourceThreadKey(target), assistant = env.PI_ASSISTANT.get(env.PI_ASSISTANT.idFromName(threadKey));
  const operation = { target: { channelId: target.channelId, groupId: target.groupId, rootMessageId: target.rootMessageId, managerId: target.managerId }, operationId: params.operationId, action: params.action, args: params.args, ...(params.skill ? { skill: params.skill } : {}), ...(params.contextSource === undefined ? {} : { contextSource: params.contextSource }), ...(params.sharedContext === undefined ? {} : { sharedContext: params.sharedContext }) };
  return input.method === "commands.ai.status" ? assistant.commandStatus(operation) : assistant.executeCommand(operation);
}
