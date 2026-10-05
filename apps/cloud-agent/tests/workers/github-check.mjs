import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../..", import.meta.url)));
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Script } from "node:vm";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const require = createRequire(import.meta.url), wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { build } = await import(wranglerRequire.resolve("esbuild"));
const directory = await mkdtemp(join(tmpdir(), "cloud-agent-github-check-")), entry = join(directory, "entry.js"), bundle = join(directory, "worker.js");
await writeFile(entry, `import { ManagementCredentials,adminRoute } from ${JSON.stringify(resolve("workers/pi/admin.js"))};
import { GitHubAuthoring as BaseGitHubAuthoring } from ${JSON.stringify(resolve("workers/pi/github-authoring.js"))};
export class GitHubAuthoring extends BaseGitHubAuthoring {
 async fetch(request){if(new URL(request.url).pathname==="/fixture/write-receipts")return Response.json(this.draftSql.exec("SELECT id,request,result FROM github_writes ORDER BY rowid").toArray().map(row=>({...row,request:JSON.parse(row.request),result:JSON.parse(row.result)})));if(new URL(request.url).pathname!=="/fixture/long-history")return new Response("Not found",{status:404});const pi=await this.harness.pi(),conversation=await pi.conversation(1,this.piContext);for(let n=0;n<20;n++)await(await conversation.submit({type:"write",entry:{kind:"pi.user",model:[{role:"user",content:"Valid previous file context ".repeat(2500),timestamp:Date.now()}]}},this.piContext)).wait(this.piContext);return Response.json({seeded:true});}
}
export default {fetch:adminRoute};
export class Credentials extends ManagementCredentials {
 async seal(value){const iv=crypto.getRandomValues(new Uint8Array(12)),key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(this.env.TOKEN_WRAPPING_KEY),c=>c.charCodeAt(0)),{name:'AES-GCM'},false,['encrypt']);return {iv:[...iv],ciphertext:[...new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(value))))]};}
 async open(value){const key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(this.env.TOKEN_WRAPPING_KEY),c=>c.charCodeAt(0)),{name:'AES-GCM'},false,['decrypt']);return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(value.iv)},key,new Uint8Array(value.ciphertext))));}
 async status(){return {connected:this.env.TEST_ACCOUNT_DISABLED!=="true",directUsageGranted:true};}
 async reportUsage(input){await this.ctx.storage.put("fixtureGithubUsage",input);return {recorded:true};}
}
`);
await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "esm", platform: "browser", target: "es2022", loader: { ".sql": "text" }, conditions: ["workerd", "worker", "browser"], alias: { path: "node:path" }, external: ["cloudflare:*", "node:*"] });
const origin = "https://cloud-agent.fixture.invalid", issuer = "https://sso.fixture.invalid", admins = { "one@example.invalid": "actor-one", "two@example.invalid": "actor-two" };
const ssoKeys = generateKeyPairSync("ed25519"), rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ssoJwk = { ...ssoKeys.publicKey.export({ format: "jwk" }), kid: "fixture-sso", alg: "EdDSA" };
const sha = value => createHash("sha1").update(value).digest("hex");
let loginActor = "one@example.invalid", nonce, appMismatch = false, suspended = false, tokenScopeBad = false, redirectRepo = false, oversizedTree = false, loss = false, mutationCalls = 0, tokenCalls = [], jwtCalls = 0;
const installationTokens = new Map();
const initialFiles = new Map([
  ["skills/personal/README.md", { mode: "100644", content: "Original text 한글\n" }],
  ["skills/personal/link.md", { mode: "120000", content: "../../private.md" }],
  ["skills/personal/submodule", { mode: "160000", content: "submodule" }],
  ["skills/personal/binary.txt", { mode: "100644", content: Buffer.from([255, 254, 0]) }],
  ["skills/personal/large.txt", { mode: "100644", content: "x".repeat(65537) }],
  ["skills/personal/lfs.txt", { mode: "100644", content: "version https://git-lfs.github.com/spec/v1\n" }],
  ["other/secret.md", { mode: "100644", content: "Other scope" }]
]);
const initialOid = "1".repeat(40); let head = initialOid; const commits = new Map([[head, initialFiles]]), requests = [];
function signedSso() { const h = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: ssoJwk.kid })).toString("base64url"), p = Buffer.from(JSON.stringify({ iss: issuer, aud: "fixture-client", sub: admins[loginActor], email: loginActor, email_verified: true, nonce, iat: Date.now() / 1000, exp: Date.now() / 1000 + 3600 })).toString("base64url"); return `${h}.${p}.${sign(null, Buffer.from(`${h}.${p}`), ssoKeys.privateKey).toString("base64url")}`; }
function appJwt(request) { const token = request.headers.get("authorization")?.slice(7), parts = token?.split("."); assert.equal(parts.length, 3); assert.ok(verify("RSA-SHA256", Buffer.from(parts.slice(0, 2).join(".")), rsa.publicKey, Buffer.from(parts[2], "base64url"))); const claims = JSON.parse(Buffer.from(parts[1], "base64url")); assert.equal(claims.iss, "fixture-app-client"); assert.ok(claims.exp > Date.now() / 1000 && claims.exp - claims.iat <= 600); jwtCalls++; }
function installToken(request) { const token = request.headers.get("authorization")?.slice(7), scope = installationTokens.get(token); assert.ok(scope, "Only generated installation token reaches repository endpoints"); return scope; }
const repository = { id: 101, full_name: "fixture-org/plugin-library", private: true, default_branch: "main" };
const outboundService = async request => {
  const url = new URL(request.url); requests.push({ method: request.method, path: url.pathname });
  if (url.origin === issuer) {
    if (url.pathname === "/.well-known/openid-configuration") return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, userinfo_endpoint: `${issuer}/userinfo`, id_token_signing_alg_values_supported: ["EdDSA"], code_challenge_methods_supported: ["S256"] });
    if (url.pathname === "/jwks") return Response.json({ keys: [ssoJwk] });
    if (url.pathname === "/token") return Response.json({ id_token: signedSso() });
  }
  assert.equal(url.origin, "https://api.github.com");
  if (url.pathname === "/app") { appJwt(request); return Response.json({ id: appMismatch ? 902 : 901, slug: "fixture-connector", client_id: "fixture-app-client" }); }
  if (url.pathname === "/app/installations/801") { appJwt(request); return Response.json({ id: 801, app_id: 901, account: { login: "fixture-org" }, suspended_at: suspended ? new Date().toISOString() : null, repository_selection: "all" }); }
  if (url.pathname === "/app/installations/801/access_tokens") {
    appJwt(request); const body = await request.json(); assert.deepEqual(Object.keys(body.permissions).sort(), ["contents", "metadata"]); assert.equal(body.permissions.metadata, "read");
    if (body.permissions.contents === "write") assert.deepEqual(body.repository_ids, [101]);
    if (body.repository_ids) assert.deepEqual(body.repository_ids, [101]);
    tokenCalls.push(body); const token = "fixture-installation-" + randomBytes(80).toString("hex"); installationTokens.set(token, body);
    return Response.json({ token, expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: tokenScopeBad ? { ...body.permissions, administration: "write" } : body.permissions, ...(body.repository_ids ? { repositories: [repository] } : {}) });
  }
  const scope = installToken(request);
  if (url.pathname === "/installation/repositories") { assert.equal(scope.permissions.contents, "read"); assert.equal(url.searchParams.get("per_page"), "50"); const page = Number(url.searchParams.get("page")); return Response.json({ total_count: 51, repositories: page === 1 ? [repository] : [] }); }
  assert.deepEqual(scope.repository_ids, [101]);
  if (url.pathname === "/repositories/101") return redirectRepo ? new Response(null, { status: 302, headers: { location: "https://evil.fixture.invalid/steal" } }) : Response.json(repository);
  if (url.pathname === "/repos/fixture-org/plugin-library/branches/main") return Response.json({ name: "main", commit: { sha: head } });
  if (url.pathname.startsWith("/repos/fixture-org/plugin-library/git/trees/")) {
    if (oversizedTree) return new Response(" ".repeat(1048577));
    const selected = url.pathname.split("/").at(-1), files = commits.get(selected); assert.ok(files, "Tree uses pinned base or returned commit SHA");
    const directories = new Set(); for (const path of files.keys()) { const parts = path.split("/"); for (let n = 1; n < parts.length; n++) directories.add(parts.slice(0, n).join("/")); }
    return Response.json({ truncated: false, tree: [...directories].map(path => ({ path, type: "tree", mode: "040000", sha: sha(path) })).concat([...files].map(([path, row]) => ({ path, type: row.mode === "160000" ? "commit" : "blob", mode: row.mode, sha: sha(row.content), size: Buffer.byteLength(row.content) }))) });
  }
  if (url.pathname.startsWith("/repos/fixture-org/plugin-library/git/blobs/")) { const id = url.pathname.split("/").at(-1), row = [...commits.values()].flatMap(files => [...files.values()]).find(row => sha(row.content) === id); assert.ok(row); return Response.json({ sha: id, size: Buffer.byteLength(row.content), encoding: "base64", content: Buffer.from(row.content).toString("base64") }); }
  if (url.pathname === "/graphql") {
    assert.equal(scope.permissions.contents, "write"); mutationCalls++; const payload = await request.json(), input = payload.variables.input;
    assert.equal(payload.query, "mutation PublishDraft($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { clientMutationId commit { oid } } }"); assert.deepEqual(input.branch, { repositoryNameWithOwner: repository.full_name, branchName: "main" }); assert.ok(!input.fileChanges.deletions);
    if (input.expectedHeadOid !== head) return Response.json({ errors: [{ message: "Head changed" }] });
    const files = new Map(commits.get(head)); for (const file of input.fileChanges.additions) { assert.ok(file.path.startsWith("skills/personal/")); files.set(file.path, { mode: "100644", content: Buffer.from(file.contents, "base64").toString("utf8") }); }
    head = sha(JSON.stringify(payload)); commits.set(head, files);
    if (loss) return new Response("Lost after commit", { status: 503 });
    return Response.json({ data: { createCommitOnBranch: { clientMutationId: input.clientMutationId, commit: { oid: head } } } });
  }
  throw Error(`Unexpected mocked endpoint ${url.pathname}`);
};
const options = { name: "cloud-agent-github-check", modulesRoot: directory, modules: [{ type: "ESModule", path: bundle }], compatibilityDate: "2026-10-04", compatibilityFlags: ["nodejs_compat"], d1Databases: ["CONVERSATIONS"],
  durableObjects: { Credentials: { className: "Credentials", useSQLite: true }, GitHubAuthoring: { className: "GitHubAuthoring", useSQLite: true } }, resourcePersistencePath: join(directory, "storage"), bindings: { PUBLIC_ORIGIN: origin, SSO_ISSUER: issuer, SSO_CLIENT_ID: "fixture-client", SSO_CLIENT_SECRET: "generated-fixture-secret", SUPER_ADMIN_EMAILS: JSON.stringify(Object.keys(admins)), SUPER_ADMIN_SUBJECTS: JSON.stringify(admins), TOKEN_WRAPPING_KEY: randomBytes(32).toString("base64"), PROBE_MODE: "mock", GITHUB_APP_ID: "901", GITHUB_APP_CLIENT_ID: "fixture-app-client", GITHUB_INSTALLATION_ID: "801", GITHUB_INSTALLATION_OWNER: "fixture-org", GITHUB_APP_PRIVATE_KEY: rsa.privateKey.export({ format: "pem", type: "pkcs8" }) }, outboundService };
let mf = new Miniflare(convertV4MiniflareOptions(options));
const send = (path, options = {}) => mf.dispatchFetch(`${origin}${path}`, { redirect: "manual", ...options });
async function login(email) { loginActor = email; const start = await send("/auth/login"); assert.equal(start.status, 303); const location = new URL(start.headers.get("location")); nonce = location.searchParams.get("nonce"); const callback = await send("/auth/callback?" + new URLSearchParams({ state: location.searchParams.get("state"), code: "fixture-code", iss: issuer }), { headers: { cookie: start.headers.get("set-cookie").split(";")[0] } }); assert.equal(callback.status, 303, await callback.clone().text()); const cookie = callback.headers.getSetCookie().find(value => value.startsWith("__Host-cloud_agent_session=")).split(";")[0]; const overview = await (await send("/api/overview", { headers: { cookie } })).json(); return { cookie, csrf: overview.csrf }; }
const get = (path, session) => send(path, { headers: { cookie: session.cookie } });
const post = (action, body, session, extra = {}) => send(`/api/github/${action}`, { method: "POST", headers: { cookie: session.cookie, origin, "content-type": "application/json", "x-csrf-token": session.csrf, ...extra }, body: JSON.stringify(body) });
const ok = async response => { assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
const failed = async (response, code) => { assert.ok(response.status >= 400, `Expected denial: ${await response.clone().text()}`); assert.equal((await response.json()).error, code); };
const register = async session => ok(await post("source", { repositoryId: 101, branch: "main", prefix: "skills/personal/", accountId: "owner" }, session));
const draft = (source, session) => get(`/api/github/draft?sourceId=${source.id}`, session).then(ok);
const stage = (source, session, path, content, expectedVersion, operationId = randomUUID()) => post("stage", { sourceId: source.id, path, content, expectedVersion, operationId }, session);
try {
  const before = requests.length; await failed(await send("/api/github/status"), "sso_login_required"); assert.equal(requests.length, before);
  const one = await login("one@example.invalid"), two = await login("two@example.invalid");
  const html = await (await send("/", { headers: { cookie: one.cookie } })).text(); new Script(html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1]); assert.match(html, /확인한 내용 Git에 저장/);
  await failed(await post("source", {}, one, { "x-csrf-token": "bad" }), "admin_csrf_invalid"); await failed(await post("source", {}, one, { origin: "https://evil.fixture.invalid" }), "admin_csrf_invalid");
  const status = await ok(await get("/api/github/status", one)); assert.equal(status.connected, true); assert.deepEqual(status.runtimePermissions, { contents: "write", metadata: "read" });
  const inventory = await ok(await get("/api/github/repositories", one)); assert.equal(inventory.nextPage, 2); assert.equal((await ok(await get("/api/github/repositories?page=2", one))).nextPage, null);
  await failed(await get("/api/github/repositories?page=-1", one), "github_page_invalid");
  appMismatch = true; assert.equal((await ok(await get("/api/github/status", one))).error, "github_app_mismatch"); appMismatch = false;
  suspended = true; assert.equal((await ok(await get("/api/github/status", one))).error, "github_installation_unavailable"); suspended = false;
  redirectRepo = true; await failed(await registerResponse(one), "github_request_failed"); redirectRepo = false;
  await failed(await post("source", { repositoryId: 101, branch: "main", prefix: ".github/workflows/", accountId: "owner" }, one), "github_path_denied");
  const source = await register(one), other = await register(two); assert.notEqual(source.actor, other.actor); assert.equal((await draft(source, one)).version, 0);
  await failed(await get(`/api/github/draft?sourceId=${source.id}`, two), "github_source_not_found");
  const files = await ok(await get(`/api/github/files?sourceId=${source.id}`, one)); assert.equal(files.files.find(row => row.path === "link.md").editable, false); assert.equal(files.files.find(row => row.path === "submodule").editable, false);
  const read = await ok(await get(`/api/github/file?${new URLSearchParams({ sourceId: source.id, path: "README.md" })}`, one)); assert.equal(read.content, "Original text 한글\n");
  for (const [path, code] of [["../other.md", "github_path_denied"], ["a%2f.md", "github_path_denied"], ["a\\b.md", "github_path_denied"], [".env", "github_path_denied"], ["script.exe", "github_text_type_denied"], ["link.md", "github_regular_text_only"], ["submodule/new.md", "github_regular_text_only"], ["binary.txt", "github_utf8_required"], ["large.txt", "github_file_size_invalid"], ["lfs.txt", "github_lfs_unsupported"]]) await failed(await stage(source, one, path, "new", 0), code);
  oversizedTree = true; await failed(await get(`/api/github/files?sourceId=${source.id}`, one), "github_response_too_large"); oversizedTree = false;
  await failed(await stage(source, one, "large.md", "x".repeat(65537), 0), "github_file_size_invalid");
  const firstWrite = randomUUID(); await ok(await stage(source, one, "README.md", "Updated 한글\n", 0, firstWrite)); assert.equal((await ok(await stage(source, one, "README.md", "Updated 한글\n", 0, firstWrite))).version, 1);
  await failed(await stage(source, one, "README.md", "different", 1, firstWrite), "github_write_receipt_mismatch"); await failed(await stage(source, one, "new.md", "new", 0), "github_draft_changed");
  await ok(await stage(source, one, "extension.ts", "\ufeffexport const greeting = \"hello\";\n", 1));
  const preview = await ok(await post("preview", { sourceId: source.id, message: "Update two text files" }, one)); assert.equal(preview.files.length, 2); assert.equal(preview.baseOid, initialOid);
  const publishId = randomUUID(), beforePublish = mutationCalls; const concurrent = await Promise.all([post("publish", { sourceId: source.id, planHash: preview.planHash, operationId: publishId }, one), post("publish", { sourceId: source.id, planHash: preview.planHash, operationId: publishId }, one)]); const published = await ok(concurrent[0]); assert.equal((await ok(concurrent[1])).replayed, true); assert.equal(published.state, "completed"); assert.equal(mutationCalls, beforePublish + 1); assert.equal(commits.get(published.oid).get("skills/personal/README.md").content, "Updated 한글\n"); assert.equal(commits.get(published.oid).get("skills/personal/extension.ts").content, "\ufeffexport const greeting = \"hello\";\n");
  const replay = await ok(await post("publish", { sourceId: source.id, planHash: preview.planHash, operationId: publishId }, one)); assert.equal(replay.replayed, true); assert.equal(mutationCalls, beforePublish + 1);
  await failed(await post("publish", { sourceId: source.id, planHash: "a".repeat(64), operationId: publishId }, one), "github_publish_receipt_mismatch");
  const after = await draft(source, one); assert.equal(after.files.length, 0); assert.equal(after.baseOid, published.oid);
  const pipeSource = await register(one), pipeInput = { sourceId: pipeSource.id, operationId: randomUUID(), prompt: "Stage and preview a skill using opaque provider call identifiers." }, pipeAsk = await ok(await post("ask", pipeInput, one));
  assert.equal(pipeAsk.state.version, 1, `Pipe-ID tool write must stage: github_write_invalid=${JSON.stringify(pipeAsk.state.entries).includes("github_write_invalid")}, version=${pipeAsk.state.version}`); assert.ok(JSON.stringify(pipeAsk.state.entries).includes("call_fixture_write|fc_fixture_write"));
  const pipeNamespace = await mf.getDurableObjectNamespace("GitHubAuthoring", "cloud-agent-github-check"), pipeName = "github-" + createHash("sha256").update(JSON.stringify([pipeSource.actor, pipeSource.id, pipeSource.generation])).digest("hex"), pipeReceipts = await (await pipeNamespace.get(pipeNamespace.idFromName(pipeName)).fetch("https://fixture.invalid/fixture/write-receipts")).json();
  assert.equal(pipeReceipts.length, 1); assert.match(pipeReceipts[0].id, /^tool-[a-f0-9]{64}$/); const pipeReplay = await ok(await post("stage", { sourceId: pipeSource.id, operationId: pipeReceipts[0].id, ...pipeReceipts[0].request }, one)); assert.deepEqual(pipeReplay, pipeReceipts[0].result); assert.equal((await draft(pipeSource, one)).version, 1);
  await failed(await post("stage", { sourceId: pipeSource.id, operationId: pipeReceipts[0].id, ...pipeReceipts[0].request, content: "Changed content" }, one), "github_write_receipt_mismatch"); assert.equal((await ok(await post("ask", pipeInput, one))).state.version, 1); assert.equal((await ok(await post("preview", { sourceId: pipeSource.id, message: "Review the pipe-ID draft" }, one))).files.length, 1);
  const askId = randomUUID(), askInput = { sourceId: source.id, operationId: askId, prompt: "Create a greeting skill draft." }; const ask = await ok(await post("ask", askInput, one)); assert.equal(ask.text, "DRAFT_READY_FOR_REVIEW"); assert.ok(ask.state.files.some(file => file.path === "greeting/SKILL.md")); assert.ok(ask.state.entries.some(entry => JSON.stringify(entry).includes("github_draft_write"))); assert.equal(mutationCalls, beforePublish + 1, "Pi stages and previews but has no publish tool");
  const askReplay = await ok(await post("ask", askInput, one)); assert.equal(askReplay.state.version, ask.state.version); assert.equal(askReplay.text, ask.text); await failed(await post("ask", { ...askInput, prompt: "Different request" }, one), "github_ask_receipt_mismatch");
  const changedPlan = await ok(await post("preview", { sourceId: source.id, message: "Stale preview" }, one)); const current = await draft(source, one); await ok(await stage(source, one, "extra.txt", "extra", current.version)); await failed(await post("publish", { sourceId: source.id, planHash: changedPlan.planHash, operationId: randomUUID() }, one), "github_plan_changed");
  const historyNamespace = await mf.getDurableObjectNamespace("GitHubAuthoring", "cloud-agent-github-check"), authorName = "github-" + createHash("sha256").update(JSON.stringify([source.actor, source.id, source.generation])).digest("hex");
  assert.equal((await historyNamespace.get(historyNamespace.idFromName(authorName)).fetch("https://fixture.invalid/fixture/long-history")).status, 200);
  const boundedHistory = await draft(source, one); assert.ok(boundedHistory.displayLimits.omittedEntries > 0); assert.ok(Buffer.byteLength(JSON.stringify(boundedHistory)) < 1048576);
  const longHistoryPreview = await ok(await post("preview", { sourceId: source.id, message: "Publish despite long durable history" }, one)); assert.equal((await ok(await post("publish", { sourceId: source.id, planHash: longHistoryPreview.planHash, operationId: randomUUID() }, one))).state, "completed");
  const lossSource = await register(one); await ok(await stage(lossSource, one, "loss.md", "Exactly once\n", 0)); const lossPreview = await ok(await post("preview", { sourceId: lossSource.id, message: "Lost response fixture" }, one)), lossId = randomUUID(); loss = true;
  const unknown = await ok(await post("publish", { sourceId: lossSource.id, planHash: lossPreview.planHash, operationId: lossId }, one)); assert.equal(unknown.state, "unknown"); loss = false; const lossCalls = mutationCalls;
  await failed(await post("publish", { sourceId: lossSource.id, planHash: lossPreview.planHash, operationId: randomUUID() }, one), "github_publication_unknown"); await failed(await stage(lossSource, one, "loss.md", "replacement", 1), "github_publication_unknown");
  await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options));
  const restarted = await draft(lossSource, one); assert.equal(restarted.files[0].content, "Exactly once\n"); assert.equal(restarted.publications[0].state, "unknown");
  assert.equal((await ok(await post("publish", { sourceId: lossSource.id, planHash: lossPreview.planHash, operationId: lossId }, one))).state, "unknown"); assert.equal(mutationCalls, lossCalls);
  await failed(await post("publish", { sourceId: lossSource.id, planHash: lossPreview.planHash, operationId: randomUUID() }, one), "github_publication_unknown");
  const conflict = await register(one); await ok(await stage(conflict, one, "conflict.md", "Preserve me", 0)); const conflictPlan = await ok(await post("preview", { sourceId: conflict.id, message: "Concurrent change" }, one)); const beforeConflict = head; head = sha("external concurrent commit"); commits.set(head, new Map(commits.get(beforeConflict)));
  assert.equal((await ok(await post("publish", { sourceId: conflict.id, planHash: conflictPlan.planHash, operationId: randomUUID() }, one))).state, "unknown"); assert.equal((await draft(conflict, one)).files[0].content, "Preserve me");
  await ok(await post("disable", { sourceId: other.id }, two)); await failed(await get(`/api/github/draft?sourceId=${other.id}`, two), "github_source_changed");
  const limitSource = await register(one); for (let n = 0; n < 4; n++) await ok(await stage(limitSource, one, `large-${n}.md`, "x".repeat(65536), n)); await failed(await stage(limitSource, one, "over.md", "x", 4), "github_draft_limit");
  tokenScopeBad = true; await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options)); await failed(await get("/api/github/repositories", one), "github_token_scope_invalid"); tokenScopeBad = false;
  await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions({ ...options, bindings: { ...options.bindings, TEST_ACCOUNT_DISABLED: "true" } })); await failed(await get(`/api/github/draft?sourceId=${source.id}`, one), "github_account_unavailable");
  await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions({ ...options, bindings: { ...options.bindings, SUPER_ADMIN_EMAILS: JSON.stringify(["two@example.invalid"]) } })); await failed(await get(`/api/github/draft?sourceId=${source.id}`, one), "sso_login_required");
  await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options));
  const serialized = JSON.stringify({ status, inventory, preview, ask, restarted, audit: (await ok(await get("/api/overview", one))).audit }); for (const token of installationTokens.keys()) assert.ok(!serialized.includes(token)); assert.ok(!serialized.includes("BEGIN PRIVATE KEY")); assert.ok(!serialized.includes(options.bindings.TOKEN_WRAPPING_KEY));
  assert.ok(jwtCalls > 0 && tokenCalls.some(call => call.permissions.contents === "write")); assert.ok(!requests.some(row => row.method === "DELETE" || /\/git\/refs/.test(row.path)));
  console.log("github-check: native SSO/CSRF, private draft isolation, RS256 and narrow tokens, fixed GitHub endpoints, regular text bounds, Pi draft tools, atomic multi-file CAS, replay and durable unknown receipts passed; zero external GitHub writes.");
} finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
function registerResponse(session) { return post("source", { repositoryId: 101, branch: "main", prefix: "skills/personal/", accountId: "owner" }, session); }
