import { commandAllowed, sourceId, sourceThreadKey } from "../../../cloud-agent/workers/pi/source-history.js";
import { aiPanel } from "./command-view.js";
const encoder = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const unb64 = text => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), value => value.charCodeAt(0));
const requireValue = (ok, code) => { if (!ok) throw new Error(code); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const actionSchema = { type: "object", properties: { chat: { type: "object", properties: { type: { type: "string" }, id: { type: "string" } }, required: ["type", "id"] }, trigger: { type: "object", additionalProperties: true }, input: { type: "object", additionalProperties: true }, language: { type: "string" } }, additionalProperties: false };
const operationSchema = { type: "object", properties: { targetCapability: { type: "string" }, operationId: { type: "string", format: "uuid" }, action: { type: "string", enum: ["help", "model", "thinking", "ask", "history"] }, args: { type: "string", maxLength: 8000 }, contextSource: { type: "string", enum: ["api", "shared"] }, sharedContext: { type: "string", maxLength: 32768 } }, required: ["targetCapability", "operationId", "action", "args"], additionalProperties: false };
export const commandFunctions = [
  { name: "extension.command.metadata.getCommands", inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema: { type: "object", properties: { commands: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["commands"] } },
  { name: "commands.ai.open", inputSchema: actionSchema, outputSchema: { type: "object", properties: { type: { type: "string" }, attributes: { type: "object", additionalProperties: true } }, required: ["type"] } },
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
export function commandPage() {
  return new Response(aiPanel(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors https://*.channel.io https://channel.works https://*.channel.works" } });
}
export async function commandFunction(input, env) {
  const params = input.params;
  requireValue(object(params), "command_parameters_invalid");
  if (input.method === "extension.command.metadata.getCommands") {
    requireValue(Object.keys(params).length === 0, "command_parameters_invalid");
    return { commands: [{ name: "ai", scope: "desk", description: "이 스레드의 AI 질문·대화 이력·모델·생각 수준", actionFunctionName: "commands.ai.open", systemVersion: "v1", alfMode: "disable", enabledByDefault: true }] };
  }
  if (input.method === "commands.ai.open") {
    requireValue(Object.keys(params).every(name => Object.hasOwn(actionSchema.properties, name)) && ["group", "groupChat"].includes(params.chat?.type) && sourceId(params.chat.id), "command_group_required");
    const rootMessageId = params.trigger?.attributes?.rootMessageId;
    requireValue(rootMessageId === undefined || sourceId(rootMessageId), "command_root_invalid");
    const target = commandAllowed({ version: 1, channelId: input.context.channel?.id, groupId: params.chat.id, ...(rootMessageId === undefined ? {} : { rootMessageId }), managerId: caller(input.context, env), expiresAt: Date.now() + 1200000, nonce: crypto.randomUUID() }, env);
    return { type: "wam", attributes: { appId: env.CHANNEL_APP_ID, name: "ai", wamArgs: { targetCapability: await capability(target, env), rootAvailable: rootMessageId !== undefined } } };
  }
  requireValue(Object.keys(params).every(name => Object.hasOwn(operationSchema.properties, name)) && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(params.operationId) && ["help", "model", "thinking", "ask", "history"].includes(params.action) && typeof params.args === "string" && encoder.encode(params.args).length <= 8000 && !params.args.includes("\0"), "command_operation_invalid");
  const target = await verify(params.targetCapability, input.context, env);
  if (!target.rootMessageId) {
    requireValue(params.action === "help" && !params.args, "command_thread_required");
    return { operationId: params.operationId, status: "done", message: "질문·이력·모델·생각 수준은 스레드 댓글 입력창에서 /ai를 실행해 주세요. 채널 본문에서는 스레드가 선택되지 않습니다." };
  }
  requireValue(env.PI_ASSISTANT, "command_assistant_unavailable");
  const threadKey = await sourceThreadKey(target), assistant = env.PI_ASSISTANT.get(env.PI_ASSISTANT.idFromName(threadKey));
  const operation = { target: { channelId: target.channelId, groupId: target.groupId, rootMessageId: target.rootMessageId, managerId: target.managerId }, operationId: params.operationId, action: params.action, args: params.args, ...(params.contextSource === undefined ? {} : { contextSource: params.contextSource }), ...(params.sharedContext === undefined ? {} : { sharedContext: params.sharedContext }) };
  return input.method === "commands.ai.status" ? assistant.commandStatus(operation) : assistant.executeCommand(operation);
}
