import schema from "./conversation-schema.sql";
import { MANAGER_DIRECTORY_SCHEMA } from "./manager-directory.js";
import { D1PiStorage, STORAGE_METHODS, checksum, byteLength, legacyCommits, verifyLegacy, MAX_STORE_BYTES, storageError, materializationStatements } from "./pi-journal.js";

const initialized = new WeakMap();
const nativeTables = ["conversations", "entries", "tasks", "submissions", "documents", "document_revisions"];
const insist = (value, code) => { if (!value) throw new Error(code); };
export function tenantId(env) { const value = env.TENANT_ID || "default"; insist(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value), "tenant_configuration_invalid"); return value; }
export async function pinTenant(ctx, env) {
  const id = tenantId(env), old = await ctx.storage.get("conversationTenant");
  insist(old === undefined || old === id, "tenant_identity_immutable");
  if (old === undefined) await ctx.storage.put("conversationTenant", id);
  return id;
}
export async function conversationDatabase(env) {
  insist(env.CONVERSATIONS?.prepare && env.CONVERSATIONS?.withSession, "conversation_database_missing");
  if (!initialized.has(env.CONVERSATIONS)) initialized.set(env.CONVERSATIONS, env.CONVERSATIONS.batch((schema + MANAGER_DIRECTORY_SCHEMA).split(";").filter(sql => sql.trim()).map(sql => env.CONVERSATIONS.prepare(sql))).catch(error => { initialized.delete(env.CONVERSATIONS); throw error; }));
  await initialized.get(env.CONVERSATIONS);
  return env.CONVERSATIONS.withSession("first-primary");
}
export const objectKey = (kind, id) => `${kind}:${id}`;

export function nativeSnapshot(sql) {
  const result = { metadata: sql.exec("SELECT next_id,next_seq FROM pi_durable_metadata ORDER BY singleton").toArray(), record_ids: sql.exec("SELECT * FROM pi_record_ids ORDER BY id").toArray() };
  let bytes = byteLength(result);
  for (const table of nativeTables) {
    result[table] = [];
    for (const row of sql.exec(`SELECT * FROM pi_${table} ORDER BY ${table === "document_revisions" ? "document_id,seq" : "id"}`)) {
      bytes += byteLength(row); insist(bytes <= MAX_STORE_BYTES, "conversation_legacy_limit"); result[table].push(row);
    }
  }
  return result;
}

export async function attachConversationStore(native, ctx, env, metadata, context) {
  const tenant = await pinTenant(ctx, env), key = objectKey(metadata.kind === "github" ? "github" : "assistant", ctx.id.toString());
  const db = await conversationDatabase(env), store = new D1PiStorage(db, tenant, key);
  const existing = await store.statement("SELECT * FROM ca_streams WHERE tenant_id=? AND object_key=?").first();
  if (!existing || existing.state !== "ready") {
    const snapshot = nativeSnapshot(ctx.storage.sql), payload = JSON.stringify(snapshot), hash = await checksum(payload);
    insist(!existing || existing.bootstrap_hash === hash, "conversation_legacy_changed_during_import");
    await store.statement("INSERT OR IGNORE INTO ca_streams(tenant_id,object_key,kind,actor,metadata,created_at,updated_at,bootstrap_hash) VALUES(?,?,?,?,?,?,?,?)", metadata.kind, metadata.actor || "", JSON.stringify(metadata), Date.now(), Date.now(), hash).run();
    await store.replay(); store.nextId = Math.max(store.nextId, Number(snapshot.metadata[0]?.next_id ?? 2));
    // ponytail: import admits at most 100 writes plus bounded replay/audit queries (paid D1 required); retry resumes before any model submission.
    let budget = 100;
    const parts = await store.statement("SELECT ordinal,payload,checksum FROM ca_bootstrap WHERE tenant_id=? AND object_key=? ORDER BY ordinal").all();
    for (const [ordinal, row] of parts.results.entries()) insist(row.ordinal === ordinal && row.payload === payload.slice(row.ordinal * 100000, (row.ordinal + 1) * 100000) && await checksum(row.payload) === row.checksum, "conversation_bootstrap_corrupt");
    const missing = [];
    for (let ordinal = parts.results.length; ordinal * 100000 < payload.length && budget > 0; ordinal++, budget--) {
      const part = payload.slice(ordinal * 100000, (ordinal + 1) * 100000);
      missing.push(store.statement("INSERT INTO ca_bootstrap(tenant_id,object_key,ordinal,payload,checksum) VALUES(?,?,?,?,?)", ordinal, part, await checksum(part)));
    }
    if (missing.length) await db.batch(missing);
    if ((parts.results.length + missing.length) * 100000 < payload.length) throw storageError("conversation_migration_pending");
    const batches = legacyCommits(snapshot), after = store.nextSeq - 1;
    for (const batch of batches) {
      if (batch.seq <= after) continue;
      const statements = materializationStatements(batch.writes);
      if (statements > budget) throw storageError("conversation_migration_pending");
      budget -= statements; store.nextSeq = batch.seq; await store.commit(batch.writes);
    }
    const roundtrip = new D1PiStorage(db, tenant, key); await roundtrip.replay();
    await verifyLegacy(native, roundtrip, snapshot, context);
    const restored = await store.statement("SELECT ordinal,payload,checksum FROM ca_bootstrap WHERE tenant_id=? AND object_key=? ORDER BY ordinal").all();
    for (const [ordinal, row] of restored.results.entries()) insist(row.ordinal === ordinal && await checksum(row.payload) === row.checksum, "conversation_bootstrap_corrupt");
    insist(await checksum(restored.results.map(row => row.payload).join("")) === hash, "conversation_bootstrap_corrupt");
    await store.statement("UPDATE ca_streams SET state='ready' WHERE tenant_id=? AND object_key=?").run();
    await ctx.storage.put("conversationMigration", { tenantId: tenant, objectKey: key, checksum: hash, verifiedAt: Date.now(), legacyBackup: true });
  } else {
    await store.replay();
    if (!await ctx.storage.get("conversationMigration")) await ctx.storage.put("conversationMigration", { tenantId: tenant, objectKey: key, checksum: existing.bootstrap_hash, verifiedAt: Date.now(), legacyBackup: true });
  }
  const nativeFloor = existing?.state === "ready" ? existing : await store.statement("SELECT next_id,next_seq FROM ca_streams WHERE tenant_id=? AND object_key=?").first();
  store.nextId = Math.max(store.nextId, nativeFloor.next_id); store.nextSeq = Math.max(store.nextSeq, nativeFloor.next_seq);
  for (const name of STORAGE_METHODS) native[name] = store[name].bind(store);
  return store;
}

export async function updateConversation(env, key, metadata, names = {}) {
  const db = await conversationDatabase(env), tenant = tenantId(env);
  await db.prepare("UPDATE ca_streams SET kind=?,actor=?,metadata=?,updated_at=? WHERE tenant_id=? AND object_key=?").bind(metadata.kind, metadata.actor || "", JSON.stringify(metadata), Date.now(), tenant, key).run();
  if (Object.keys(names).length) await db.prepare(`UPDATE ca_sessions SET name=COALESCE(json_extract(?, '$."' || session_id || '"'),name) WHERE tenant_id=? AND object_key=?`).bind(JSON.stringify(names), tenant, key).run();
}
export async function recordChannelEvent(env, key, event, seq = 0) {
  const db = await conversationDatabase(env);
  await db.prepare("INSERT INTO ca_channel_messages(tenant_id,object_key,message_id,operation_id,event,native_seq,observed_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,object_key,message_id) DO UPDATE SET native_seq=MAX(ca_channel_messages.native_seq,excluded.native_seq)").bind(tenantId(env), key, event.data.message_id, event.operationId, JSON.stringify(event), seq, Date.now()).run();
}
export async function recordChannelReceipt(env, key, row) {
  const db = await conversationDatabase(env), tenant = tenantId(env);
  const receipt = { seq: row.seq, messageId: row.messageId, eventId: row.eventId, operationId: row.operationId, state: row.state, answer: row.answer, replyId: row.replyId, error: row.error, updatedAt: row.updatedAt, snapshot: row.snapshot ? JSON.parse(row.snapshot) : null };
  const old = await db.prepare("SELECT receipt FROM ca_channel_messages WHERE tenant_id=? AND object_key=? AND operation_id=?").bind(tenant, key, row.operationId).first();
  if (row.data !== "{}") await recordChannelEvent(env, key, { ...JSON.parse(row.data), operationId: row.operationId }, row.seq);
  else if (old?.receipt) return;
  await db.prepare("UPDATE ca_channel_messages SET receipt=? WHERE tenant_id=? AND object_key=? AND operation_id=?").bind(JSON.stringify(receipt), tenant, key, row.operationId).run();
  const confirmed = await db.prepare("SELECT receipt FROM ca_channel_messages WHERE tenant_id=? AND object_key=? AND operation_id=?").bind(tenant, key, row.operationId).first();
  insist(confirmed?.receipt === JSON.stringify(receipt), "conversation_receipt_unconfirmed");
}
export async function channelReceipts(env, key, limit = 50) {
  const db = await conversationDatabase(env);
  const rows = await db.prepare("SELECT event,receipt FROM ca_channel_messages WHERE tenant_id=? AND object_key=? ORDER BY native_seq DESC,message_id DESC LIMIT ?").bind(tenantId(env), key, limit).all();
  let managers = new Map();
  try { managers = new Map((await env.Credentials.getByName("owner").resolveObservedManagers(key)).map(item => [item.managerId, item])); } catch { /* A directory outage leaves explicit fallback names and never blocks inference. */ }
  return rows.results.reverse().map(row => {
    const event = JSON.parse(row.event), id = event.data.sender_id ?? null;
    const manager = managers.get(id) || { managerId: id, displayName: id ? `직원 ${id}` : "직원", state: "fallback" };
    return { ...(row.receipt ? JSON.parse(row.receipt) : { operationId: event.operationId, messageId: event.data.message_id, state: "accepted" }), manager, text: event.data.text, senderId: id, sourceTimestamp: event.timestamp };
  });
}

export async function recordAuthoringAsk(env, key, operationId, requestHash, prompt) {
  const db = await conversationDatabase(env), tenant = tenantId(env);
  await db.prepare("INSERT OR IGNORE INTO ca_asks(tenant_id,object_key,operation_id,request_hash,prompt) VALUES(?,?,?,?,?)").bind(tenant, key, operationId, requestHash, prompt).run();
  const row = await db.prepare("SELECT request_hash,prompt FROM ca_asks WHERE tenant_id=? AND object_key=? AND operation_id=?").bind(tenant, key, operationId).first();
  insist(row?.request_hash === requestHash, "github_ask_receipt_mismatch"); return row.prompt;
}

export async function storedHistory(env, key, sessionId, { before, limit = 50 } = {}) {
  const db = await conversationDatabase(env), tenant = tenantId(env);
  insist(/^[1-9]\d{0,15}$/.test(String(sessionId)) && Number.isSafeInteger(Number(sessionId)), "session_invalid");
  insist(Number.isInteger(limit) && limit >= 1 && limit <= 200 && (before === undefined || Number.isSafeInteger(before) && before >= 1), "history_cursor_invalid");
  const sessions = await db.prepare("SELECT session_id,record,name FROM ca_sessions WHERE tenant_id=? AND object_key=? ORDER BY session_id").bind(tenant, key).all();
  const records = new Map(sessions.results.map(row => [row.session_id, JSON.parse(row.record)]));
  let current = records.get(Number(sessionId)), upper = before === undefined ? Number.MAX_SAFE_INTEGER : before - 1;
  insist(current, "session_unknown"); const seen = new Set();
  while (current) {
    insist(!seen.has(current.id), "conversation_ancestry_corrupt"); seen.add(current.id);
    if (!current.parent) break;
    current = records.get(current.parent.conversationId); insist(current, "conversation_ancestry_corrupt");
  }
  const result = await db.prepare(`WITH RECURSIVE lineage(session_id,upper) AS (
    SELECT ?,? UNION ALL
    SELECT json_extract(s.record,'$.parent.conversationId'),MIN(lineage.upper,json_extract(s.record,'$.parent.at'))
      FROM lineage JOIN ca_sessions s ON s.tenant_id=? AND s.object_key=? AND s.session_id=lineage.session_id
      WHERE json_extract(s.record,'$.parent.conversationId') IS NOT NULL
  ) SELECT e.entry FROM ca_entries e JOIN lineage l ON e.session_id=l.session_id AND e.entry_id<=l.upper
    WHERE e.tenant_id=? AND e.object_key=? ORDER BY e.entry_id DESC LIMIT ?`).bind(Number(sessionId), upper, tenant, key, tenant, key, limit + 1).all();
  const entries = []; let bytes = 2;
  for (const row of result.results.slice(0, limit)) {
    const size = byteLength(row.entry) + 1;
    insist(size <= 1048576, "thread_history_entry_too_large");
    if (bytes + size > 1048576) break;
    bytes += size; entries.unshift(JSON.parse(row.entry));
  }
  const hasMore = result.results.length > entries.length;

  return { entries, sessions: sessions.results.map(row => ({ id: String(row.session_id), name: row.name, ...(records.get(row.session_id).parent ? { parent: String(records.get(row.session_id).parent.conversationId) } : {}) })), displayLimits: { entries: limit }, pagination: { before: before ?? null, nextBefore: hasMore ? entries[0].id : null, hasMore }, storage: { backend: "d1", tenantId: tenant } };
}

export async function listConversations(env, { before, limit = 50, kind = "channel" } = {}) {
  insist(Number.isInteger(limit) && limit >= 1 && limit <= 100 && ["channel", "manual"].includes(kind), "conversation_query_invalid");
  let cursor; try { cursor = before ? JSON.parse(before) : null; } catch { throw new Error("conversation_cursor_invalid"); }
  insist(!cursor || Array.isArray(cursor) && cursor.length === 2 && Number.isSafeInteger(cursor[0]) && typeof cursor[1] === "string" && cursor[1].length <= 80, "conversation_cursor_invalid");
  const db = await conversationDatabase(env), rows = await db.prepare("SELECT object_key,metadata,updated_at FROM ca_streams WHERE tenant_id=? AND kind=? AND state='ready' AND (updated_at<? OR (updated_at=? AND object_key>?)) ORDER BY updated_at DESC,object_key LIMIT ?").bind(tenantId(env), kind, cursor?.[0] ?? Number.MAX_SAFE_INTEGER, cursor?.[0] ?? Number.MAX_SAFE_INTEGER, cursor?.[1] ?? "", limit + 1).all();
  const selected = rows.results.slice(0, limit), last = selected.at(-1);
  return { tenant: { id: tenantId(env), name: env.TENANT_NAME || "Cloud Agent" }, conversations: selected.map(row => ({ ...JSON.parse(row.metadata), updatedAt: row.updated_at })), nextCursor: rows.results.length > limit ? JSON.stringify([last.updated_at, last.object_key]) : null };
}
