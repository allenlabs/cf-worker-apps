import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { MANAGER_DIRECTORY_SCHEMA } from "../../workers/pi/manager-directory.js";

const require = createRequire(import.meta.url), wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { build } = await import(wranglerRequire.resolve("esbuild"));
const directory = await mkdtemp(join(tmpdir(), "cloud-agent-manager-check-"));
const entry = join(directory, "entry.js"), bundle = join(directory, "worker.js");
const helper = fileURLToPath(new URL("../../workers/pi/manager-directory.js", import.meta.url));
await writeFile(entry, `import { resolveManagers } from ${JSON.stringify(helper)};
export default { async fetch(request, env) {
  const input = await request.json(), calls = []; let active = 0, peak = 0;
  const lookup = async (params, {signal}) => {
    calls.push(params); active++; peak = Math.max(active, peak);
    try {
      if (input.timeout) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('fixture-aborted')), {once:true}));
      if (input.delay) await new Promise(resolve => setTimeout(resolve, input.delay));
      if (input.failLookup) throw Error('fixture-secret-must-not-leak');
      return input.profiles?.[params.managerId];
    } finally { active--; }
  };
  try {
    const displays = await resolveManagers({ db: env.DB, tenantId: input.tenantId, channelId: input.channelId, managerIds: input.managerIds, lookup: input.noLookup ? undefined : lookup, now: () => input.now });
    return Response.json({ displays: [...displays.values()], calls, peak });
  } catch (error) { return Response.json({ error: error.message, calls, peak }, {status:500}); }
} };`);
await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "esm", platform: "browser", target: "es2022" });
let networks = 0;
const mf = new Miniflare(convertV4MiniflareOptions({ name: "manager-check", modulesRoot: directory, modules: [{ type: "ESModule", path: bundle }], compatibilityDate: "2026-10-04", d1Databases: { DB: "manager-fixture" }, outboundService: () => { networks++; throw Error("Unexpected network"); } }));
const db = await mf.getD1Database("DB");
const profile = (id, name, channelId = "channel-a") => ({ manager: { id, name, channelId, email: "private@example.invalid", phone: "fixture-private-phone", avatarUrl: "https://private.fixture.invalid/avatar", accessToken: "fixture-profile-secret" } });
const input = (id, displayName, now = 1000, extra = {}) => ({ tenantId: "tenant-a", channelId: "channel-a", managerIds: [id], now, profiles: { [id]: profile(id, displayName) }, ...extra });
const request = body => mf.dispatchFetch("https://manager.fixture.invalid/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const resolve = async body => { const response = await request(body), value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; };
const rejected = async body => { const response = await request(body), value = await response.json(); assert.equal(response.status, 500); return value; };
const row = async (id, tenantId = "tenant-a", channelId = "channel-a") => db.prepare("SELECT * FROM manager_directory WHERE tenant_id=? AND channel_id=? AND manager_id=?").bind(tenantId, channelId, id).first();
const fallback = id => ({ managerId: id, displayName: `직원 ${id}`, state: "fallback" });

try {
  await db.prepare(MANAGER_DIRECTORY_SCHEMA).run();
  let value = await resolve(input("manager-a", "홍직원", 1000, { managerIds: ["manager-a", "manager-a"] }));
  assert.equal(value.calls.length, 1); assert.deepEqual(value.calls[0], { channelId: "channel-a", managerId: "manager-a" });
  assert.deepEqual(value.displays, [{ managerId: "manager-a", displayName: "홍직원", state: "resolved" }]);
  assert.equal((await row("manager-a")).expires_at, 21601000);
  value = await resolve(input("manager-a", "이름 변경", 1001));
  assert.equal(value.calls.length, 0); assert.equal(value.displays[0].displayName, "홍직원");
  value = await resolve(input("manager-a", "  김직원  ", 21601000));
  assert.equal(value.calls.length, 1); assert.equal(value.displays[0].displayName, "김직원");

  value = await resolve(input("manager-a", "다른 조직", 1000, { tenantId: "tenant-b" }));
  assert.equal(value.displays[0].displayName, "다른 조직");
  value = await resolve(input("manager-a", "다른 채널", 1000, { channelId: "channel-b", profiles: { "manager-a": profile("manager-a", "다른 채널", "channel-b") } }));
  assert.equal(value.displays[0].displayName, "다른 채널");
  assert.equal((await row("manager-a")).display_name, "김직원");
  assert.equal((await row("manager-a", "tenant-b")).display_name, "다른 조직");
  assert.equal((await row("manager-a", "tenant-a", "channel-b")).display_name, "다른 채널");

  const malformed = [
    ["missing", undefined], ["array", []], ["wrong-id", profile("another-id", "잘못된 직원")],
    ["wrong-channel", profile("wrong-channel", "다른 채널 직원", "channel-b")],
    ["empty", profile("empty", " ")], ["numeric", profile("numeric", 42)],
    ["control", profile("control", "직원\n줄바꿈")], ["too-long", profile("too-long", "가".repeat(86))]
  ];
  for (const [id, result] of malformed) {
    value = await resolve(input(id, "unused", 2000, { profiles: { [id]: result } }));
    assert.deepEqual(value.displays, [fallback(id)]); assert.equal((await row(id)).expires_at, 62000);
  }
  value = await resolve(input("no-channel-field", "직원", 2000, { profiles: { "no-channel-field": { manager: { id: "no-channel-field", name: "직원" } } } }));
  assert.equal(value.displays[0].state, "resolved", "Official opaque Manager response need not carry channelId");
  assert.equal((await resolve(input("name-boundary", "x".repeat(256)))).displays[0].state, "resolved");
  assert.equal((await resolve(input("over-boundary", "x".repeat(257)))).displays[0].state, "fallback");
  value = await resolve(input("denied", "직원", 3000, { failLookup: true }));
  assert.deepEqual(value.displays, [fallback("denied")]); assert.ok(!JSON.stringify(value).includes("fixture-secret"));
  value = await resolve(input("denied", "조회 복구", 62999));
  assert.equal(value.calls.length, 0); assert.deepEqual(value.displays, [fallback("denied")]);
  value = await resolve(input("denied", "조회 복구", 63000));
  assert.equal(value.calls.length, 1); assert.equal(value.displays[0].displayName, "조회 복구");
  value = await resolve(input("timeout", "직원", 3000, { timeout: true }));
  assert.deepEqual(value.displays, [fallback("timeout")]);

  const dangerousName = '<img src=x onerror="fixture()">';
  value = await resolve(input("literal-name", dangerousName));
  assert.deepEqual(Object.keys(value.displays[0]).sort(), ["displayName", "managerId", "state"]);
  assert.equal(value.displays[0].displayName, dangerousName, "Name remains text; caller must use textContent/escaping");
  const cache = (await db.prepare("SELECT * FROM manager_directory").all()).results;
  assert.ok(!JSON.stringify(cache).includes("private@example.invalid"));
  assert.ok(!JSON.stringify(cache).includes("fixture-private-phone"));
  assert.ok(!JSON.stringify(cache).includes("fixture-profile-secret"));
  assert.ok(!JSON.stringify(cache).includes("private.fixture.invalid"));
  assert.deepEqual(Object.keys(cache[0]).sort(), ["channel_id", "display_name", "expires_at", "fetched_at", "manager_id", "state", "tenant_id"]);

  const ids = Array.from({ length: 50 }, (_, index) => `page-${index}`);
  value = await resolve({ tenantId: "tenant-a", channelId: "channel-a", managerIds: ids, now: 4000, delay: 5, profiles: Object.fromEntries(ids.map(id => [id, profile(id, `직원 ${id}`)])) });
  assert.equal(value.displays.length, 50); assert.equal(value.calls.length, 50); assert.equal(value.peak, 5);
  assert.deepEqual((await resolve(input("unused", "Unused", 4000, { managerIds: [] }))).displays, []);
  for (const extra of [{ tenantId: "bad tenant" }, { channelId: "bad/channel" }, { managerIds: ["bad/id"] }, { managerIds: [...ids, "one-more"] }, { now: -1 }, { now: 0.5 }, { now: null }, { now: Number.MAX_SAFE_INTEGER }, { noLookup: true }]) {
    const failure = await rejected(input("invalid", "Invalid", 4000, extra));
    assert.equal(failure.error, "manager_directory_invalid"); assert.equal(failure.calls.length, 0);
  }

  const older = request(input("rename-race", "이전 이름", 5000, { delay: 150 }));
  await new Promise(resolve => setTimeout(resolve, 30));
  await resolve(input("rename-race", "최신 이름", 6000));
  const olderResponse = await older;
  assert.equal(olderResponse.status, 200); assert.equal((await olderResponse.json()).displays[0].displayName, "최신 이름");
  assert.equal((await row("rename-race")).display_name, "최신 이름");
  const olderPositive = request(input("failure-race", "예전 이름", 7000, { delay: 150 }));
  await new Promise(resolve => setTimeout(resolve, 30));
  await resolve(input("failure-race", "Unused", 8000, { failLookup: true }));
  const olderPositiveResponse = await olderPositive;
  assert.equal(olderPositiveResponse.status, 200); assert.deepEqual((await olderPositiveResponse.json()).displays, [fallback("failure-race")]);
  assert.equal((await row("failure-race")).state, "fallback");

  await db.prepare("CREATE TRIGGER reject_manager_write BEFORE INSERT ON manager_directory WHEN NEW.manager_id='write-fail' BEGIN SELECT RAISE(ABORT, 'fixture_d1_write_failure'); END").run();
  const writeFailure = await rejected(input("write-fail", "Not saved", 9000, { managerIds: ["atomic-good", "write-fail"], profiles: { "atomic-good": profile("atomic-good", "Rolled back"), "write-fail": profile("write-fail", "Not saved") } }));
  assert.ok(writeFailure.error.includes("fixture_d1_write_failure")); assert.equal(await row("write-fail"), null);
  assert.equal(await row("atomic-good"), null, "A failed directory batch must not acknowledge partial cache writes");
  await db.prepare("DROP TABLE manager_directory").run();
  const readFailure = await rejected(input("read-fail", "Not read", 9000));
  assert.ok(readFailure.error.includes("no such table")); assert.equal(readFailure.calls.length, 0);
  assert.equal(networks, 0);
  console.log(JSON.stringify({ ok: true, runtime: "workerd", database: "D1", tenantChannelIsolation: true, ttlRenameAndNegativeCache: true, boundedLookupTimeout: true, privateFieldsDiscarded: true, literalNamesRequireCallerTextRendering: true, staleRefreshGuard: true, d1FailuresExplicit: true, realNetworks: networks }));
} finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
