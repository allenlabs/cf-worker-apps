import { MemoryStorage, StorageRejected } from "@earendil-works/pi-durable";

const encoder = new TextEncoder();
export const byteLength = value => encoder.encode(typeof value === "string" ? value : JSON.stringify(value)).length;
export const checksum = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(typeof value === "string" ? value : JSON.stringify(value))))].map(byte => byte.toString(16).padStart(2, "0")).join("");
export const STORAGE_METHODS = ["commit", "mintId", "conversation", "scanConversations", "entry", "findLatestHeadMarker", "scanEntries", "task", "scanTasks", "submission", "scanSubmissions", "submissionByRequest", "findDocument", "document", "scanDocuments", "close"];
export const MAX_STORE_BYTES = 8 * 1048576;
export const MAX_COMMIT_BYTES = 1048576;
export const MAX_STORE_COMMITS = 2000;
export const materializationStatements = writes => 2 + Math.ceil(writes.filter(write => write.type === "conversation").length / 24) + Math.ceil(writes.filter(write => write.type === "entry").length / 16);
export const storageError = (code, cause) => Object.assign(new Error(code, { cause }), { name: "LoginError", retryable: true });
const insist = (value, code) => { if (!value) throw new Error(code); };

export class D1PiStorage {
  constructor(db, tenantId, objectKey) {
    this.db = db; this.tenantId = tenantId; this.objectKey = objectKey;
    this.memory = new MemoryStorage(); this.nextId = 2; this.nextSeq = 1; this.bytes = 0; this.commits = 0; this.closed = false;
    this.tail = Promise.resolve();
    for (const name of STORAGE_METHODS.filter(name => !["commit", "mintId", "close"].includes(name))) this[name] = (...args) => { this.usable(); return this.memory[name](...args); };
  }
  statement(sql, ...args) { return this.db.prepare(sql).bind(this.tenantId, this.objectKey, ...args); }
  usable() { insist(!this.closed && !this.poisoned, this.poisoned ? "conversation_storage_reopen_required" : "conversation_storage_closed"); }
  async mintId() { this.usable(); insist(Number.isSafeInteger(this.nextId), "ID space is exhausted"); return this.nextId++; }
  async close(context) { this.closed = true; return this.memory.close(context); }
  async replay() {
    // ponytail: cold starts replay at most 8 MiB/2,000 commits in 22 D1 queries; add verified checkpoints before raising either ceiling.
    const totals = await this.statement("SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM ca_commits WHERE tenant_id=? AND object_key=?").first();
    insist(totals.count <= MAX_STORE_COMMITS && totals.bytes <= MAX_STORE_BYTES, "conversation_storage_limit");
    let after = 0;
    for (;;) {
      const page = await this.statement("SELECT seq,payload,checksum,next_id FROM ca_commits WHERE tenant_id=? AND object_key=? AND seq>? ORDER BY seq LIMIT 100", after).all();
      for (const row of page.results) {
        insist(row.seq > after && await checksum(row.payload) === row.checksum, "conversation_journal_corrupt");
        this.memory.prepareCommit(JSON.parse(row.payload), row.seq).apply(); after = row.seq; this.nextId = Math.max(this.nextId, row.next_id); this.nextSeq = row.seq + 1;
      }
      if (page.results.length < 100) break;
    }
    this.bytes = totals.bytes; this.commits = totals.count;
  }
  commit(writes) {
    const pending = this.tail.then(() => this.persist(writes)); this.tail = pending.catch(() => undefined); return pending;
  }
  async persist(writes) {
    this.usable(); let prepared;
    try { prepared = this.memory.prepareCommit(writes, this.nextSeq); }
    catch (error) { throw new StorageRejected(error.message, { cause: error }); }
    const payload = JSON.stringify(prepared.writes), bytes = byteLength(payload), hash = await checksum(payload);
    if (bytes > MAX_COMMIT_BYTES || this.bytes + bytes > MAX_STORE_BYTES || this.commits >= MAX_STORE_COMMITS) throw new StorageRejected("conversation_storage_limit");
    for (const write of prepared.writes) {
      const id = write.value?.id ?? write.record?.id;
      if (id !== undefined) this.nextId = Math.max(this.nextId, id + 1);
    }
    const statements = [this.statement("INSERT INTO ca_commits(tenant_id,object_key,seq,payload,checksum,bytes,next_id) VALUES(?,?,?,?,?,?,?)", prepared.seq, payload, hash, bytes, this.nextId)];
    for (const [type, width, sql, values] of [
      ["conversation", 24, "INSERT INTO ca_sessions(tenant_id,object_key,session_id,record) VALUES", write => [this.tenantId, this.objectKey, write.value.id, JSON.stringify(write.value)]],
      ["entry", 16, "INSERT INTO ca_entries(tenant_id,object_key,entry_id,session_id,commit_seq,entry) VALUES", write => [this.tenantId, this.objectKey, write.value.id, write.value.conversationId, prepared.seq, JSON.stringify(write.value)]]
    ]) {
      const selected = prepared.writes.filter(write => write.type === type);
      for (let offset = 0; offset < selected.length; offset += width) {
        const rows = selected.slice(offset, offset + width).map(values);
        statements.push(this.db.prepare(sql + rows.map(row => "(" + row.map(() => "?").join(",") + ")").join(",")).bind(...rows.flat()));
      }
    }
    statements.push(this.db.prepare("UPDATE ca_streams SET updated_at=?,next_seq=?,next_id=? WHERE tenant_id=? AND object_key=?").bind(Date.now(), prepared.seq + 1, this.nextId, this.tenantId, this.objectKey));
    if (statements.length > 100) throw new StorageRejected("conversation_commit_statement_limit");
    try { await this.db.batch(statements); }
    catch (error) {
      try {
        const found = await this.statement("SELECT checksum,payload FROM ca_commits WHERE tenant_id=? AND object_key=? AND seq=?", prepared.seq).first();
        if (!found || found.checksum !== hash || found.payload !== payload) throw error;
      } catch (failure) { this.poisoned = true; throw storageError("conversation_storage_reopen_required", failure); }
    }
    const seq = prepared.apply(); this.nextSeq = seq + 1; this.bytes += bytes; this.commits++; return seq;
  }
}

export function legacyCommits(snapshot) {
  const batches = new Map();
  const add = (seq, write) => { insist(Number.isSafeInteger(seq) && seq >= 1, "conversation_legacy_seq_invalid"); if (!batches.has(seq)) batches.set(seq, []); batches.get(seq).push(write); };
  for (const [table, type] of [["conversations", "conversation"], ["tasks", "task"], ["submissions", "submission"]]) for (const row of snapshot[table]) add(1, { type, value: JSON.parse(row.record) });
  for (const row of snapshot.entries) add(row.commit_seq, { type: "entry", value: JSON.parse(row.record) });
  for (const row of snapshot.documents) {
    const { createdAt, retiredAt, ...record } = JSON.parse(row.record);
    const revisions = snapshot.document_revisions.filter(revision => revision.document_id === row.id);
    const first = revisions[0];
    const currentOnly = record.scope.kind !== "conversation" || record.history === "latest";
    insist(first?.kind === "base" || currentOnly && retiredAt !== undefined, "conversation_legacy_base_missing");
    const content = first ? { kind: "base", version: first.version, value: JSON.parse(first.content) } : { kind: "base", version: 1, value: {} };
    add(createdAt, { type: "document.create", record, content });
    for (const revision of revisions) {
      if (revision.seq === createdAt) continue;
      add(revision.seq, { type: "document.change", id: row.id, content: revision.kind === "base" ? { kind: "base", version: revision.version, value: JSON.parse(revision.content) } : { kind: "delta", version: revision.version, ops: JSON.parse(revision.content) } });
    }
    if (retiredAt !== undefined) add(retiredAt, { type: "document.retire", id: row.id });
  }
  const floor = snapshot.metadata[0]?.next_seq ?? 1;
  if (floor > 1 && !batches.has(floor - 1)) batches.set(floor - 1, []);
  return [...batches].sort(([a], [b]) => a - b).map(([seq, writes]) => ({ seq, writes }));
}

export async function verifyLegacy(native, external, snapshot, context) {
  const equal = (a, b) => insist(JSON.stringify(a) === JSON.stringify(b), "conversation_migration_parity_failed");
  for (const row of snapshot.conversations) equal(await native.conversation(row.id, context), await external.conversation(row.id, context));
  for (const row of snapshot.entries) equal(await native.entry(row.id, context), await external.entry(row.id, context));
  for (const row of snapshot.tasks) equal(await native.task(row.id, context), await external.task(row.id, context));
  for (const row of snapshot.submissions) equal(await native.submission(row.id, context), await external.submission(row.id, context));
  for (const row of snapshot.documents) {
    equal(await native.document(row.id, "current", context), await external.document(row.id, "current", context));
    const record = JSON.parse(row.record);
    if (record.history === "rewindable") for (const revision of snapshot.document_revisions.filter(item => item.document_id === row.id)) equal(await native.document(row.id, revision.seq, context), await external.document(row.id, revision.seq, context));
  }
  const scans = async (method, query) => {
    let cursor;
    do { const a = await native[method](query, 2, cursor, context), b = await external[method](query, 2, cursor, context); equal(a, b); cursor = a.next; } while (cursor);
  };
  await scans("scanConversations", {}); await scans("scanTasks", {}); await scans("scanSubmissions", {});
  for (const row of snapshot.documents) {
    const record = JSON.parse(row.record), address = { kind: record.kind, scope: record.scope, ...(record.key === undefined ? {} : { key: record.key }) };
    for (const at of ["current", ...snapshot.document_revisions.filter(item => item.document_id === row.id).map(item => item.seq)]) {
      equal(await native.findDocument(address, at, context), await external.findDocument(address, at, context));
      await scans("scanDocuments", { scope: record.scope, at });
    }
  }
  for (const row of snapshot.conversations) {
    let cursor;
    do {
      const a = await native.scanEntries({ conversationId: row.id }, 50, cursor, context), b = await external.scanEntries({ conversationId: row.id }, 50, cursor, context);
      equal(a, b); cursor = a.next;
    } while (cursor);
    for (const cutoff of [undefined, ...snapshot.entries.map(entry => entry.id)]) equal(await native.findLatestHeadMarker(row.id, cutoff, context), await external.findLatestHeadMarker(row.id, cutoff, context));
  }
}
