import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const base = dirname(fileURLToPath(import.meta.url));
const dependencyRoot = process.env.CLOUD_AGENT_REPO ? resolve(process.env.CLOUD_AGENT_REPO) : base;
const require = createRequire(process.env.CLOUD_AGENT_REPO ? join(dependencyRoot, "apps/cloud-agent/package.json") : import.meta.url);
const { build } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const temp = await mkdtemp(join(tmpdir(), "pi-git-draft-"));
const initialOid = "1".repeat(40);
const heads = new Map([["personal-fixture", initialOid], ["other-fixture", initialOid]]);
const commits = [];
const requests = [];
let loseResponse = false;
await build({ entryPoints: [join(base, "worker.mjs")], outfile: join(temp, "worker.js"), bundle: true, format: "esm", platform: "browser", conditions: ["workerd", "worker", "browser"], alias: { path: "node:path" }, external: ["cloudflare:*", "node:*"], nodePaths: [join(dependencyRoot, "node_modules")] });
const options = () => convertV4MiniflareOptions({
  resourcePersistencePath: join(temp, "storage"),
  workers: [{
    name: "pi-git-draft", modulesRoot: temp, modules: [{ type: "ESModule", path: join(temp, "worker.js") }],
    compatibilityDate: "2026-10-04", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { Draft: { className: "Draft", useSQLite: true } },
    outboundService: async request => {
      assert.equal(request.url, "https://api.github.com/graphql");
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("authorization"), null, "Fixture unexpectedly carried a credential");
      const body = await request.json();
      assert.match(body.query, /createCommitOnBranch\(input: \$input\)/);
      const input = body.variables.input;
      assert.equal(input.branch.repositoryNameWithOwner, "fixture-org/plugin-library");
      assert.ok(heads.has(input.branch.branchName));
      const prefix = input.branch.branchName === "other-fixture" ? "personal/member-b/" : "personal/member-a/";
      assert.ok(input.fileChanges.additions.every(file => file.path.startsWith(prefix)), "Host personal prefix escaped");
      assert.deepEqual(Object.keys(input.fileChanges), ["additions"]);
      requests.push(input);
      if (input.expectedHeadOid !== heads.get(input.branch.branchName)) {
        // Generic GraphQL rejection. No undocumented production error type is
        // assumed: this fixture alone knows its compare-and-swap failed.
        return Response.json({ errors: [{ message: "Fixture expected HEAD mismatch" }] });
      }
      const oid = (commits.length + 2).toString(16).padStart(40, "0");
      commits.push({ oid, ...input });
      heads.set(input.branch.branchName, oid);
      if (loseResponse) { loseResponse = false; throw Error("Fixture accepted commit but response was lost"); }
      return Response.json({ data: { createCommitOnBranch: { clientMutationId: input.clientMutationId, commit: { oid } } } });
    }
  }]
});
let mf = new Miniflare(options());
async function call(draft, path, body) {
  const namespace = await mf.getDurableObjectNamespace("Draft", "pi-git-draft");
  return namespace.get(namespace.idFromName(draft)).fetch("https://probe.invalid" + path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
}
async function json(draft, path, body) {
  const response = await call(draft, path, body);
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
const initialize = (name, profile = "author", baseOid = initialOid) => json(name, "/initialize", { profile, baseOid });
const write = (name, path, content, id = "write-" + path) => json(name, "/write", { id, args: { path, content } });
const preview = name => json(name, "/preview");
const publish = (name, snapshotHash, id, message = "Publish fixture draft") => json(name, "/publish", { id, args: { snapshotHash, message } });
const restart = async () => { await mf.dispose(); mf = new Miniflare(options()); };
try {
  await initialize("pi-draft");
  const run = await json("pi-draft", "/run");
  assert.equal(run.result.status, "done");
  assert.equal(run.result.text, "DRAFT_PUBLISHED");
  assert.deepEqual(run.state.trace, ["draft_write", "draft_write", "draft_read", "draft_preview", "draft_preview", "draft_publish"]);
  assert.equal(run.state.files.length, 2);
  assert.equal(run.state.publications.length, 1);
  assert.equal(run.state.publications[0].state, "completed");
  assert.equal(requests.length, 1);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].fileChanges.additions.length, 2, "Skill and reference were not published in one commit");
  assert.deepEqual(commits[0].fileChanges.additions.map(file => Buffer.from(file.contents, "base64").toString("utf8")), run.state.files.map(file => file.content));
  // The real Pi transcript, not direct mock calls, must contain every tool.
  const transcript = JSON.stringify(run.messages);
  for (const name of ["draft_write", "draft_read", "draft_preview", "draft_publish"]) assert.ok(transcript.includes(name));

  await restart();
  const restored = await json("pi-draft", "/inspect");
  assert.deepEqual(restored.files, run.state.files, "SQLite draft disappeared after native runtime restart");
  const replay = await publish("pi-draft", restored.publications[0].result.snapshotHash, restored.publications[0].id, "Add greeting skill and reference");
  assert.equal(replay.state, "completed");
  assert.equal(replay.replayed, true);
  assert.equal(requests.length, 1, "Completed receipt caused another GitHub request");
  for (const args of [
    { snapshotHash: "different-hash", message: "Add greeting skill and reference" },
    { snapshotHash: restored.publications[0].result.snapshotHash, message: "Different commit message" }
  ]) {
    const mismatch = await call("pi-draft", "/publish", { id: restored.publications[0].id, args });
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error, "publish_receipt_mismatch");
  }

  await initialize("other-draft", "other");
  for (const path of ["../member-b/SKILL.md", "/personal/member-b/SKILL.md", "greeting/../../other.md", "greeting\\other.md", "greeting/%2e%2e/secret.md", "greeting/.git/config.txt", "greeting/script.js"]) {
    const response = await call("pi-draft", "/write", { id: "escape-" + path, args: { path, content: "blocked" } });
    assert.equal(response.status, 400, "Unsafe path accepted: " + path);
  }
  assert.equal((await call("other-draft", "/read", { path: "greeting/SKILL.md" })).status, 400, "Separate fixture draft unexpectedly shared files");
  assert.equal((await call("pi-draft", "/initialize", { profile: "other", baseOid: initialOid })).status, 400, "A bound principal was replaced");
  assert.equal((await call("pi-draft", "/write", { id: "oversize", args: { path: "large.md", content: "x".repeat(65537) } })).status, 400);
  await write("other-draft", "own/SKILL.md", "---\nname: own\ndescription: A fixture.\n---\nHello.\n");
  const ownPreview = await preview("other-draft");
  assert.equal((await publish("other-draft", ownPreview.snapshotHash, "own-publish")).state, "completed");
  assert.equal(commits.at(-1).fileChanges.additions[0].path, "personal/member-b/own/SKILL.md");

  const currentHead = heads.get("personal-fixture");
  await initialize("conflict-a", "author", currentHead);
  await initialize("conflict-b", "author", currentHead);
  await write("conflict-a", "a/SKILL.md", "first draft");
  await write("conflict-b", "b/SKILL.md", "second stale draft");
  const beforeConflict = commits.length;
  const first = await publish("conflict-a", (await preview("conflict-a")).snapshotHash, "conflict-a-publish");
  assert.equal(first.state, "completed");
  const second = await publish("conflict-b", (await preview("conflict-b")).snapshotHash, "conflict-b-publish");
  assert.equal(second.state, "unknown", "An unresolved GraphQL error was treated as proof of no side effect");
  assert.equal(commits.length, beforeConflict + 1, "Stale draft replaced a competing commit");
  assert.equal(heads.get("personal-fixture"), first.oid);

  await initialize("unknown", "author", heads.get("personal-fixture"));
  await write("unknown", "lost/SKILL.md", "commit may have happened");
  const lostSnapshot = await preview("unknown");
  loseResponse = true;
  const beforeLost = requests.length;
  const lost = await publish("unknown", lostSnapshot.snapshotHash, "lost-publish");
  assert.equal(lost.state, "unknown");
  assert.equal(requests.length, beforeLost + 1);
  assert.ok(commits.at(-1).fileChanges.additions[0].path.endsWith("lost/SKILL.md"), "Response-loss fixture did not actually accept the mock commit");
  assert.equal((await publish("unknown", lostSnapshot.snapshotHash, "lost-publish")).state, "unknown");
  assert.equal((await call("unknown", "/publish", { id: "new-id-cannot-retry", args: { snapshotHash: lostSnapshot.snapshotHash, message: "Unsafe retry" } })).status, 400);
  await restart();
  assert.equal((await json("unknown", "/inspect")).publications[0].state, "unknown");
  assert.equal((await publish("unknown", lostSnapshot.snapshotHash, "lost-publish")).state, "unknown");
  assert.equal(requests.length, beforeLost + 1, "Unknown receipt retried after native restart");
  assert.equal((await call("unknown", "/write", { id: "after-unknown", args: { path: "lost/SKILL.md", content: "changed" } })).status, 400);
  console.log(JSON.stringify({ ok: true, runtime: "workerd + SQLite DO + real PiHarness", provider: "faux fixture", externalGitHubWrites: 0, mockCommitRequests: requests.length, mockCommits: commits.length, checks: ["Pi tool write/read/preview/publish", "multi-file single commit", "native restart persistence", "personal draft storage isolation", "mock HEAD conflict prevents commit", "receipt replay and input mismatch denial", "lost response unknown without retry"] }, null, 2));
} finally {
  await mf.dispose();
  await rm(temp, { recursive: true, force: true });
}
