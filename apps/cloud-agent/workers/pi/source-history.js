const encoder = new TextEncoder();
export const sourceId = value => typeof value === "string" && /^[A-Za-z0-9_:-]{1,255}$/.test(value);
export class SourceHistoryError extends Error { constructor(code) { super(code); this.name = "SourceHistoryError"; } }
const requireValue = (ok, code) => { if (!ok) throw new SourceHistoryError(code); };
export function commandGroups(env) {
  let groups; try { groups = JSON.parse(env.COMMAND_GROUP_IDS || "[]"); } catch { throw new SourceHistoryError("command_configuration_invalid"); }
  requireValue(Array.isArray(groups) && groups.length <= 100 && groups.every(sourceId) && new Set(groups).size === groups.length, "command_configuration_invalid");
  return groups;
}
export function commandAllowed(target, env) {
  requireValue(target && target.channelId === env.ALLOWED_CHANNEL_ID && commandGroups(env).includes(target.groupId) && sourceId(target.managerId) && (target.rootMessageId === undefined || sourceId(target.rootMessageId)), "command_target_denied");
  let memberships; try { memberships = JSON.parse(env.COMMAND_PRIVATE_MANAGERS || "{}"); } catch { throw new SourceHistoryError("command_configuration_invalid"); }
  requireValue(memberships && typeof memberships === "object" && !Array.isArray(memberships) && Object.entries(memberships).every(([group, managers]) => sourceId(group) && Array.isArray(managers) && managers.every(sourceId)), "command_configuration_invalid");
  if (target.groupId !== env.ALLOWED_CHAT_ID || Object.hasOwn(memberships, target.groupId)) requireValue(memberships[target.groupId]?.includes(target.managerId), "command_manager_denied");
  return target;
}
export async function sourceThreadKey(target) {
  requireValue([target.channelId, target.groupId, target.rootMessageId].every(sourceId), "command_thread_required");
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify([target.channelId, target.groupId, target.rootMessageId])));
  return `channel-${[...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("")}`;
}

const cursorValid = value => typeof value === "string" && value.length > 0 && encoder.encode(value).length <= 2048 && !/[\x00-\x1f]/.test(value);
async function api(path, env, budget) {
  requireValue(typeof env.CHANNEL_OPEN_API_ACCESS_KEY === "string" && env.CHANNEL_OPEN_API_ACCESS_KEY && typeof env.CHANNEL_OPEN_API_ACCESS_SECRET === "string" && env.CHANNEL_OPEN_API_ACCESS_SECRET, "source_history_not_configured");
  const remaining = budget.deadline - Date.now();
  requireValue(remaining > 0, "time_limit");
  let response;
  try { response = await fetch(`https://api.channel.io/open/${path}`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(remaining), headers: { "Channel-Version": "2026-06-01", "x-access-key": env.CHANNEL_OPEN_API_ACCESS_KEY, "x-access-secret": env.CHANNEL_OPEN_API_ACCESS_SECRET } }); }
  catch { throw new SourceHistoryError(Date.now() >= budget.deadline ? "time_limit" : "source_history_network_error"); }
  requireValue(response.ok, response.status === 401 || response.status === 403 ? "source_history_api_denied" : `source_history_http_${response.status}`);
  const reader = response.body?.getReader(); requireValue(reader, "source_history_response_invalid");
  const chunks = []; let bytes = 0;
  while (true) {
    let part; try { part = await reader.read(); } catch { throw new SourceHistoryError(Date.now() >= budget.deadline ? "time_limit" : "source_history_network_error"); } if (part.done) break;
    bytes += part.value.length;
    if (budget.bytes + bytes > 1048576) { await reader.cancel(); throw new SourceHistoryError("byte_limit"); }
    chunks.push(part.value);
  }
  budget.bytes += bytes; const body = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { throw new SourceHistoryError("source_history_response_invalid"); }
}
function normalize(message, target, root, names) {
  requireValue(message && sourceId(message.id) && message.channelId === target.channelId && message.chatId === target.groupId && message.chatType === "group", "source_history_identity_mismatch");
  if (root) requireValue(message.id === target.rootMessageId && !message.threadMsg && (message.rootMessageId == null || message.rootMessageId === target.rootMessageId), "source_history_root_mismatch");
  else requireValue(message.id !== target.rootMessageId && message.rootMessageId === target.rootMessageId && message.threadMsg === true, "source_history_root_mismatch");
  if (message.thread) requireValue((message.thread.chatId == null || message.thread.chatId === target.groupId) && (message.thread.rootMessageId == null || message.thread.rootMessageId === target.rootMessageId) && (message.thread.chatType == null || message.thread.chatType === "group"), "source_history_root_mismatch");
  requireValue(typeof message.createdAt === "string" && Number.isFinite(Date.parse(message.createdAt)), "source_history_response_invalid");
  if (message.removedAt || message.state === "removed") return null;
  requireValue(["manager", "bot"].includes(message.personType) && sourceId(message.personId), "source_history_writer_invalid");
  const text = typeof message.plainText === "string" ? message.plainText : Array.isArray(message.blocks) ? message.blocks.filter(block => block?.type === "text" && typeof block.value === "string").map(block => block.value).join("\n") : "";
  return { id: message.id, ...(root ? {} : { rootMessageId: target.rootMessageId }), personType: message.personType, personId: message.personId, name: names.get(`${message.personType}:${message.personId}`) || message.personId, createdAt: message.createdAt, text, fileCount: Array.isArray(message.files) ? message.files.length : 0 };
}
function namesFrom(envelope) {
  const names = new Map();
  for (const [type, rows] of [["manager", envelope.managers], ["bot", envelope.bots]]) if (Array.isArray(rows)) for (const row of rows) if (sourceId(row?.id) && typeof row.name === "string" && row.name.trim() && encoder.encode(row.name).length <= 256 && !/[\x00-\x1f]/.test(row.name)) names.set(`${type}:${row.id}`, row.name);
  return names;
}
export async function readSourceThread(target, env, args = {}) {
  requireValue(args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).every(key => ["cursor", "limit"].includes(key)) && (args.cursor === undefined || cursorValid(args.cursor)) && (args.limit === undefined || Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 1000), "source_history_arguments_invalid");
  requireValue([target?.channelId, target?.groupId, target?.rootMessageId].every(sourceId) && target.channelId === env.ALLOWED_CHANNEL_ID, "source_history_target_invalid");
  if (target.managerId) commandAllowed(target, env); else requireValue(target.groupId === env.ALLOWED_CHAT_ID, "source_history_target_invalid");
  const budget = { deadline: Date.now() + 15000, bytes: 0 }, path = `groups/${encodeURIComponent(target.groupId)}`, groupEnvelope = await api(path, env, budget), group = groupEnvelope.group;
  requireValue(group?.id === target.groupId && group.channelId === target.channelId && ["all", "public", "private"].includes(group.scope), "source_history_identity_mismatch");
  if (group.scope === "private") requireValue(target.managerId && Array.isArray(group.managerIds) && group.managerIds.includes(target.managerId), "source_history_membership_denied");
  const result = { rootObserved: false, complete: false, incompleteReason: null, messages: [], nextCursor: args.cursor || null, observedAt: new Date().toISOString(), untrustedData: true };
  const seen = new Set(), cursors = new Set(args.cursor ? [args.cursor] : []), limit = args.limit ?? 1000; let outputBytes = 0, cursor = args.cursor;
  const append = (message, root, names) => {
    requireValue(!seen.has(message?.id), "source_history_duplicate_message"); seen.add(message.id);
    const normalized = normalize(message, target, root, names); if (!normalized) return;
    outputBytes += encoder.encode(JSON.stringify(normalized)).length;
    requireValue(outputBytes <= 262144, "output_limit"); result.messages.push(normalized); if (root) result.rootObserved = true;
  };
  try {
    const root = await api(`${path}/threads/${encodeURIComponent(target.rootMessageId)}`, env, budget);
    append(root.message, true, namesFrom(root));
    for (let page = 0; page < 10; page++) {
      const remaining = limit - result.messages.length;
      if (remaining <= 0) { result.incompleteReason = "message_limit"; return result; }
      const params = new URLSearchParams({ sortOrder: "asc", limit: String(Math.min(100, remaining)) }); if (cursor) params.set("cursor", cursor);
      const envelope = await api(`${path}/threads/${encodeURIComponent(target.rootMessageId)}/messages?${params}`, env, budget);
      requireValue(Array.isArray(envelope.messages) && envelope.messages.length <= Math.min(100, remaining) && typeof envelope.hasNext === "boolean" && (envelope.hasNext ? cursorValid(envelope.nextCursor) : envelope.nextCursor == null), "source_history_response_invalid");
      requireValue(!envelope.hasNext || !cursors.has(envelope.nextCursor), "source_history_cursor_cycle");
      const before = result.messages.length, beforeBytes = outputBytes;
      try { const names = namesFrom(envelope); for (const message of envelope.messages) append(message, false, names); }
      catch (error) { if (error.message === "output_limit") { result.messages.length = before; outputBytes = beforeBytes; } throw error; }
      if (!envelope.hasNext) { result.complete = true; result.nextCursor = null; return result; }
      cursor = envelope.nextCursor; cursors.add(cursor); result.nextCursor = cursor;
    }
    result.incompleteReason = "page_limit"; return result;
  } catch (error) {
    if (["time_limit", "byte_limit", "output_limit"].includes(error.message)) { result.incompleteReason = error.message; return result; }
    throw error;
  }
}
