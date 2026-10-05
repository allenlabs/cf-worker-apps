import { Agent } from "agents";
import { PiHarness } from "agents/harness/pi";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";

// Feasibility fixture only. The HTTP control routes below are NOT authenticated
// application routes. Production must bind the authenticated principal before
// selecting the DO and resolve GitHub credentials outside model-visible tools.
const profiles = Object.freeze({
  author: { repository: "fixture-org/plugin-library", branch: "personal-fixture", prefix: "personal/member-a/" },
  other: { repository: "fixture-org/plugin-library", branch: "other-fixture", prefix: "personal/member-b/" }
});
const encoder = new TextEncoder();
const text = value => [{ type: "text", text: JSON.stringify(value) }];
const digest = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
function insist(condition, message) { if (!condition) throw Error(message); }
function pathInScope(path) {
  insist(typeof path === "string" && path.length <= 240 && !path.includes("%") && !path.includes("\\"), "path_denied");
  insist(path.split("/").every(part => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(part) && part !== "." && part !== ".." && part !== ".git"), "path_denied");
  insist(/\.(md|txt|json|yaml|yml)$/.test(path), "text_type_denied");
  return path;
}

export class Draft extends Agent {
  constructor(ctx, env) {
    super(ctx, env);
    this.draftSql = ctx.storage.sql;
    this.draftStorage = ctx.storage;
    this.draftSql.exec(`CREATE TABLE IF NOT EXISTS draft_context (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS draft_files (path TEXT PRIMARY KEY, content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS write_receipts (id TEXT PRIMARY KEY, input TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS publish_receipts (id TEXT PRIMARY KEY, request TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_trace (seq INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);`);
    const registry = createRegistry();
    const tool = (name, parameters, execute) => ({
      name, description: name.replaceAll("_", " ") + " within this principal's fixed Git draft",
      parameters, replay: "safe", executionMode: "sequential",
      async execute(args, api) {
        const result = await execute(args, String(api.taskId) + ":" + api.callId);
        return { content: text(result) };
      }
    });
    registry.install({ name: "draft-authoring", tools: [
      tool("draft_write", Type.Object({ path: Type.String(), content: Type.String() }, { additionalProperties: false }), (args, id) => this.write(args, id)),
      tool("draft_read", Type.Object({ path: Type.String() }, { additionalProperties: false }), args => this.read(args.path)),
      tool("draft_preview", Type.Object({}, { additionalProperties: false }), () => this.preview()),
      tool("draft_publish", Type.Object({ snapshotHash: Type.String(), message: Type.String() }, { additionalProperties: false }), (args, id) => this.publish(args, id))
    ] });
    this.faux = fauxProvider({ models: [{ id: "draft-fixture", name: "Draft fixture" }] });
    const models = createModels();
    models.setProvider(this.faux.provider);
    this.harness = new PiHarness({
      harness: ({ storage, context }) => Harness.open(storage, { models, registry, settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 } } }, context),
      defaults: { model: this.faux.getModel(), thinkingLevel: "off" }
    });
    this.lifecycle.use(this.harness);
  }

  context() {
    const value = this.draftSql.exec("SELECT data FROM draft_context WHERE id=1").toArray()[0];
    insist(value, "fixture_principal_not_bound");
    return JSON.parse(value.data);
  }

  initialize({ profile, baseOid }) {
    insist(Object.hasOwn(profiles, profile) && /^[a-f0-9]{40}$/.test(baseOid), "fixture_context_invalid");
    const context = { ...profiles[profile], baseOid };
    const existing = this.draftSql.exec("SELECT data FROM draft_context WHERE id=1").toArray()[0];
    insist(!existing || existing.data === JSON.stringify(context), "fixture_context_immutable");
    this.draftSql.exec("INSERT OR IGNORE INTO draft_context (id,data) VALUES (1,?)", JSON.stringify(context));
    return context;
  }

  write(args, id) {
    this.context();
    const path = pathInScope(args.path);
    insist(typeof args.content === "string" && !args.content.includes("\0") && encoder.encode(args.content).length <= 65536, "text_limit");
    const input = JSON.stringify(args);
    const old = this.draftSql.exec("SELECT input,result FROM write_receipts WHERE id=?", id).toArray()[0];
    if (old) { insist(old.input === input, "write_receipt_mismatch"); return JSON.parse(old.result); }
    insist(!this.draftSql.exec("SELECT id FROM publish_receipts WHERE state='unknown' LIMIT 1").toArray().length, "publish_reconciliation_required");
    const files = this.draftSql.exec("SELECT path,content FROM draft_files WHERE path<>?", path).toArray();
    insist(files.length < 32 && files.reduce((bytes, file) => bytes + encoder.encode(file.content).length, encoder.encode(args.content).length) <= 262144, "draft_limit");
    const result = { path, bytes: encoder.encode(args.content).length };
    this.draftStorage.transactionSync(() => {
      this.draftSql.exec("INSERT INTO draft_files (path,content) VALUES (?,?) ON CONFLICT(path) DO UPDATE SET content=excluded.content", path, args.content);
      this.draftSql.exec("INSERT INTO write_receipts (id,input,result) VALUES (?,?,?)", id, input, JSON.stringify(result));
      this.draftSql.exec("INSERT INTO tool_trace (name) VALUES ('draft_write')");
    });
    return result;
  }

  read(path) {
    this.context(); pathInScope(path);
    const file = this.draftSql.exec("SELECT content FROM draft_files WHERE path=?", path).toArray()[0];
    insist(file, "file_absent");
    this.draftSql.exec("INSERT INTO tool_trace (name) VALUES ('draft_read')");
    return { path, content: file.content };
  }

  async preview() {
    const context = this.context();
    const files = this.draftSql.exec("SELECT path,content FROM draft_files ORDER BY path").toArray();
    const snapshotHash = await digest(JSON.stringify({ context, files }));
    this.draftSql.exec("INSERT INTO tool_trace (name) VALUES ('draft_preview')");
    return { snapshotHash, baseOid: context.baseOid, files };
  }

  async publish(args, id) {
    const request = JSON.stringify([args.snapshotHash, args.message]);
    const receipt = this.draftSql.exec("SELECT request,state,result FROM publish_receipts WHERE id=?", id).toArray()[0];
    if (receipt) {
      insist(receipt.request === request, "publish_receipt_mismatch");
      return { ...JSON.parse(receipt.result), state: receipt.state, replayed: true };
    }
    const context = this.context();
    insist(typeof args.message === "string" && args.message.length > 0 && args.message.length <= 200 && !/[\r\n\0]/.test(args.message), "commit_message_invalid");
    const snapshot = await this.preview();
    insist(snapshot.snapshotHash === args.snapshotHash && snapshot.files.length > 0, "snapshot_changed");
    // A second in-flight publication must not race this receipt's I/O gap.
    insist(!this.draftSql.exec("SELECT id FROM publish_receipts WHERE state='unknown' LIMIT 1").toArray().length, "publish_reconciliation_required");
    const input = {
      branch: { repositoryNameWithOwner: context.repository, branchName: context.branch },
      expectedHeadOid: context.baseOid,
      message: { headline: args.message },
      fileChanges: { additions: snapshot.files.map(file => ({ path: context.prefix + file.path, contents: btoa(String.fromCharCode(...encoder.encode(file.content))) })) },
      // Correlation only: GitHub does NOT promise idempotency for this field.
      clientMutationId: id
    };
    const payload = { query: "mutation PublishDraft($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { clientMutationId commit { oid } } }", variables: { input } };
    const unknown = { state: "unknown", snapshotHash: snapshot.snapshotHash, reason: "reconcile_before_retry" };
    // Freeze the exact payload and unknown receipt before ANY network side effect.
    this.draftStorage.transactionSync(() => {
      insist(JSON.stringify(this.draftSql.exec("SELECT path,content FROM draft_files ORDER BY path").toArray()) === JSON.stringify(snapshot.files), "snapshot_changed");
      this.draftSql.exec("INSERT INTO publish_receipts (id,request,payload,state,result) VALUES (?,?,?,'unknown',?)", id, request, JSON.stringify(payload), JSON.stringify(unknown));
      this.draftSql.exec("INSERT INTO tool_trace (name) VALUES ('draft_publish')");
    });
    let state = "unknown", result = unknown;
    try {
      // No credential exists in this fixture. Miniflare intercepts ALL outbound
      // requests. This is not an authenticated GitHub integration test.
      const response = await fetch("https://api.github.com/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json();
      const oid = body?.data?.createCommitOnBranch?.commit?.oid;
      if (response.ok && !body.errors && /^[a-f0-9]{40}$/.test(oid ?? "")) { state = "completed"; result = { state, snapshotHash: snapshot.snapshotHash, oid }; }
    } catch { /* Lost/malformed response remains durably unknown; no retry. */ }
    this.draftSql.exec("UPDATE publish_receipts SET state=?,result=? WHERE id=?", state, JSON.stringify(result), id);
    return result;
  }

  async run() {
    await this.lifecycle.start();
    this.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("draft_write", { path: "greeting/SKILL.md", content: "---\nname: greeting\ndescription: Say hello using the supplied reference.\n---\nRead references/style.md and greet the user.\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("draft_write", { path: "greeting/references/style.md", content: "Use one friendly sentence.\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("draft_read", { path: "greeting/references/style.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("draft_preview", {}), { stopReason: "toolUse" }),
      async transcript => {
        const last = transcript.messages.filter(message => message.role === "toolResult").at(-1);
        const preview = JSON.parse(last.content.find(block => block.type === "text").text);
        return fauxAssistantMessage(fauxToolCall("draft_publish", { snapshotHash: preview.snapshotHash, message: "Add greeting skill and reference" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("DRAFT_PUBLISHED")
    ]);
    const session = this.harness.session();
    const receipt = await session.submit("Write and read the greeting skill, preview it, then publish this approved fixture draft.", { operationId: "fixture-authoring-run" });
    const result = await session.wait(receipt.operationId);
    return { result, messages: await session.messages(), state: await this.inspect() };
  }

  async inspect() {
    return {
      context: this.context(), files: this.draftSql.exec("SELECT path,content FROM draft_files ORDER BY path").toArray(),
      publications: this.draftSql.exec("SELECT id,state,result FROM publish_receipts ORDER BY id").toArray().map(row => ({ ...row, result: JSON.parse(row.result) })),
      trace: this.draftSql.exec("SELECT name FROM tool_trace ORDER BY seq").toArray().map(row => row.name)
    };
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      const body = request.method === "POST" ? await request.json() : {};
      const value = path === "/initialize" ? this.initialize(body)
        : path === "/write" ? this.write(body.args, body.id)
        : path === "/read" ? this.read(body.path)
        : path === "/preview" ? await this.preview()
        : path === "/publish" ? await this.publish(body.args, body.id)
        : path === "/run" ? await this.run()
        : path === "/inspect" ? await this.inspect() : null;
      return value === null ? new Response("Not found", { status: 404 }) : Response.json(value);
    } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
  }
}

export default { fetch() { return new Response("Test-only DO probe; no public API.", { status: 404 }); } };
