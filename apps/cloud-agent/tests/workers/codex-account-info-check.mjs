import assert from "node:assert/strict";
import { readCodexAccountInfo } from "../../workers/pi/codex-account-info.js";
import { retainSubscriptionInfo, subscriptionInfoHistory } from "../../workers/pi/subscription-account-info.js";

const selected = "fixture-selected";
const access = "fixture-access-do-not-return-" + "x".repeat(512);
const other = "fixture-other-do-not-return";
const account = { id: selected, name: "Example workspace", structure: "workspace", plan_type: "business" };
const accountResponse = { accounts: [account, { id: other, name: "Private other workspace" }] };
const usageResponse = {
  account_id: selected,
  plan_type: "plus",
  rate_limit: {
    allowed: false,
    limit_reached: false,
    primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_after_seconds: 2400, reset_at: 1800000000 },
    secondary_window: null,
  },
  credits: { has_credits: false, unlimited: false, balance: "0.0000000000000000001" },
};
const originalFetch = globalThis.fetch;
const originalConsole = { ...console };
const originalSetTimeout = globalThis.setTimeout;
let calls;
let logs = 0;
const json = value => Response.json(value);
async function read({ accounts = () => json(accountResponse), usage = () => json(usageResponse), profile = { access, accountId: selected } } = {}) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(init.signal instanceof AbortSignal, true);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${access}`);
    assert.equal(headers.get("chatgpt-account-id"), selected);
    assert.equal(headers.get("user-agent"), "cloud-agent/1");
    assert.deepEqual([...headers.keys()].sort(), ["accept", "authorization", "chatgpt-account-id", "user-agent"]);
    assert.equal(new URL(url).search, "");
    if (url === "https://chatgpt.com/backend-api/wham/accounts/check") return accounts(init);
    assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
    return usage(init);
  };
  const result = await readCodexAccountInfo(profile);
  assert.equal(Number.isFinite(Date.parse(result.checkedAt)), true);
  for (const forbidden of [access, other, "Private other workspace", "<html>", "fixture-server-secret"]) {
    assert.equal(JSON.stringify(result).includes(forbidden), false);
  }
  return result;
}

try {
  for (const method of ["debug", "info", "log", "warn", "error"]) console[method] = () => { logs++; };
  const result = await read();
  assert.equal(calls.length, 2);
  assert.deepEqual(result.account, { status: "available", httpStatus: 200, workspaceName: account.name, structure: "workspace", planType: "business" });
  assert.deepEqual(result.usage, {
    status: "available", httpStatus: 200, planType: "plus", allowed: false, limitReached: false,
    primaryWindow: { usedPercent: 0, windowSeconds: 18000, resetAt: 1800000000, resetAfterSeconds: 2400 }, secondaryWindow: null,
    additionalWindows: [],
    credits: { hasCredits: false, unlimited: false, balance: "0.0000000000000000001" },
  });
  const map = await read({ accounts: () => json({
    accounts: { [selected]: { account: { account_id: selected, name: "Mapped workspace", structure: "workspace" } } },
    account_ordering: [selected], default_account_id: other,
  }) });
  assert.equal(map.account.workspaceName, "Mapped workspace");
  assert.equal(map.account.planType, null);
  const missing = await read({ usage: () => json({ plan_type: "pro", rate_limit: { allowed: true, limit_reached: false, primary_window: {} } }) });
  assert.deepEqual(missing.usage.primaryWindow, { usedPercent: null, windowSeconds: null, resetAt: null, resetAfterSeconds: null });
  assert.equal(missing.usage.secondaryWindow, null);
  assert.equal(missing.usage.credits, null);
  const over = structuredClone(usageResponse);
  over.rate_limit.primary_window.used_percent = 125;
  assert.equal((await read({ usage: () => json(over) })).usage.primaryWindow.usedPercent, 125);
  const onlyPlan = (await read({ usage: () => json({ plan_type: "pro" }) })).usage;
  assert.equal(onlyPlan.status, "available");
  assert.equal(onlyPlan.allowed, null);
  assert.equal(onlyPlan.primaryWindow, null);
  const extra = { limit_name: "Model-specific limit", metered_feature: "codex_fixture", rate_limit: usageResponse.rate_limit };
  const additional = (await read({ usage: () => json({ ...usageResponse, additional_rate_limits: [extra] }) })).usage.additionalWindows;
  assert.deepEqual(additional, [{ id: "codex_fixture", name: "Model-specific limit", allowed: false, limitReached: false, primaryWindow: result.usage.primaryWindow, secondaryWindow: null }]);
  for (const additional_rate_limits of [null, {}, "bad", [null, {}, { ...extra, limit_name: "x".repeat(129) }, { ...extra, rate_limit: { allowed: true } }]]) {
    const projected = (await read({ usage: () => json({ ...usageResponse, additional_rate_limits }) })).usage;
    assert.equal(projected.status, "available");
    assert.deepEqual(projected.additionalWindows, []);
  }
  assert.equal((await read({ usage: () => json({ ...usageResponse, additional_rate_limits: Array(20).fill(extra) }) })).usage.additionalWindows.length, 8);

  const baseTime = Date.parse("2026-10-01T00:00:00.000Z");
  const observation = (hour, usedPercent = hour) => ({ ...result, checkedAt: new Date(baseTime + hour * 3600000).toISOString(), usage: { ...result.usage, primaryWindow: { ...result.usage.primaryWindow, usedPercent } } });
  let retained;
  for (let hour = 0; hour < 180; hour++) retained = retainSubscriptionInfo(retained, "scope-a", observation(hour), baseTime + hour * 3600000);
  assert.equal(retained.history.length, 168);
  assert.equal(retained.history[0].primaryWindow.usedPercent, 12);
  assert.equal(retained.history.at(-1).primaryWindow.usedPercent, 179, "measurements above 100 stay intact");
  retained = retainSubscriptionInfo(retained, "scope-a", observation(179, 182), baseTime + 179 * 3600000);
  assert.equal(retained.history.length, 168, "same-hour refresh replaces that hour's observation");
  assert.equal(retained.history.at(-1).primaryWindow.usedPercent, 182);
  const lastSuccess = retained.snapshot;
  const failed = { ...observation(180), usage: { status: "unavailable", reason: "http_error", httpStatus: 429 } };
  retained = retainSubscriptionInfo(retained, "scope-a", failed, baseTime + 180 * 3600000);
  assert.deepEqual(retained.snapshot, lastSuccess);
  assert.deepEqual(retained.lastAttempt, failed);
  assert.equal(retained.history.at(-1).primaryWindow.usedPercent, 182);
  assert.equal(subscriptionInfoHistory(retained, baseTime + 400 * 3600000).length, 0);
  assert.deepEqual(retainSubscriptionInfo(retained, "scope-b", failed, baseTime + 180 * 3600000).history, []);
  assert.equal(retainSubscriptionInfo(retained, "scope-b", failed, baseTime + 180 * 3600000).snapshot, null);
  let dense;
  for (let hour = 0; hour < 168; hour++) {
    const value = observation(hour);
    value.usage.additionalWindows = Array.from({ length: 8 }, (_, i) => ({ ...additional[0], id: String(i), name: "한".repeat(42), primaryWindow: value.usage.primaryWindow, secondaryWindow: value.usage.primaryWindow }));
    dense = retainSubscriptionInfo(dense, "scope-a", value, baseTime + hour * 3600000);
  }
  assert.ok(dense.history.length > 0 && dense.history.length < 168);
  assert.ok(new TextEncoder().encode(JSON.stringify(dense)).length <= 90 * 1024, "sealed record plaintext leaves base64 encryption space within the DO per-value limit");

  for (const accounts of [
    { accounts: [{ id: other }], default_account_id: selected },
    { accounts: [] },
  ]) assert.equal((await read({ accounts: () => json(accounts) })).account.reason, "account_not_found");
  for (const accounts of [
    { accounts: [account, { ...account }] },
    { accounts: { a: { account: { account_id: selected } }, b: { account: { account_id: selected } } } },
  ]) assert.equal((await read({ accounts: () => json(accounts) })).account.reason, "duplicate_account");
  for (const accounts of [null, [], {}, { accounts: "invalid" }, { accounts: [{ id: selected, name: 4 }] }, { accounts: { [selected]: {} } }]) {
    assert.equal((await read({ accounts: () => json(accounts) })).account.reason, "unsupported_response");
  }
  for (const usage of [
    {}, { plan_type: "" }, { plan_type: 4 }, { plan_type: "pro", rate_limit: [] },
    { plan_type: "pro", rate_limit: { allowed: true, limit_reached: 0 } },
    { ...usageResponse, credits: { has_credits: true, unlimited: false, balance: 0 } },
    { ...usageResponse, credits: { has_credits: true, unlimited: false, balance: "Infinity" } },
  ]) assert.equal((await read({ usage: () => json(usage) })).usage.reason, "unsupported_response");
  for (const [field, value] of [["used_percent", -1], ["used_percent", 1.5], ["reset_at", "1800000000"], ["limit_window_seconds", Number.MAX_SAFE_INTEGER + 1], ["reset_after_seconds", false]]) {
    const usage = structuredClone(usageResponse);
    usage.rate_limit.primary_window[field] = value;
    assert.equal((await read({ usage: () => json(usage) })).usage.reason, "unsupported_response");
  }
  assert.equal((await read({ usage: () => json({ ...usageResponse, account_id: other }) })).usage.reason, "account_mismatch");

  for (const status of [301, 401, 403, 429, 500]) {
    const response = await read({ usage: () => new Response("<html>fixture-server-secret</html>", { status, headers: { Location: "https://untrusted.invalid" } }) });
    assert.equal(calls.length, 2);
    assert.deepEqual(response.usage, { status: "unavailable", reason: "http_error", httpStatus: status });
    assert.equal(response.account.status, "available");
  }
  const failures = [
    [() => new Response("<html>fixture-server-secret</html>", { headers: { "Content-Type": "text/html" } }), "invalid_content_type"],
    [() => new Response("{}", { headers: { "Content-Type": "application/json; charset=latin1" } }), "invalid_encoding"],
    [() => new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "application/json" } }), "invalid_encoding"],
    [() => new Response("{", { headers: { "Content-Type": "application/json" } }), "invalid_json"],
    [() => new Response("{} trailing", { headers: { "Content-Type": "application/json" } }), "invalid_json"],
    [() => new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": String(128 * 1024 + 1) } }), "response_too_large"],
    [() => new Response(" ".repeat(128 * 1024 + 1), { headers: { "Content-Type": "application/json" } }), "response_too_large"],
    [() => { throw new Error("fixture-server-secret"); }, "network_error"],
    [() => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("fixture-server-secret")); } }), { headers: { "Content-Type": "application/json" } }), "network_error"],
  ];
  for (const [usage, reason] of failures) {
    const failed = await read({ usage });
    assert.equal(failed.usage.reason, reason);
    assert.equal(failed.account.status, "available");
    assert.equal(calls.length, 2);
  }
  const failedAccount = await read({ accounts: () => new Response("blocked", { status: 403 }) });
  assert.equal(failedAccount.account.httpStatus, 403);
  assert.equal(failedAccount.usage.status, "available");
  const unicode = JSON.stringify({ plan_type: "plus", ignored: "한글 👩‍💻" });
  const bytes = new TextEncoder().encode(unicode);
  const split = await read({ usage: () => new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } }), { headers: { "Content-Type": "Application/JSON; charset=\"UTF-8\"" } }) });
  assert.equal(split.usage.status, "available");
  globalThis.setTimeout = callback => originalSetTimeout(callback, 5);
  const timed = await read({ usage: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))) });
  assert.equal(timed.usage.reason, "timeout");
  globalThis.setTimeout = originalSetTimeout;
  for (const profile of [null, {}, { access, accountId: "" }, { access: "a\rb", accountId: selected }]) {
    const invalid = await read({ profile });
    assert.equal(calls.length, 0);
    assert.equal(invalid.account.reason, "invalid_profile");
    assert.equal(invalid.usage.reason, "invalid_profile");
  }
  assert.equal(logs, 0);
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  Object.assign(console, originalConsole);
}
console.log("Codex account info checks passed");
