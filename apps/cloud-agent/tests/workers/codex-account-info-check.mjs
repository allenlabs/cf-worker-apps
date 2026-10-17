import assert from "node:assert/strict";
import { readCodexAccountInfo } from "../../workers/pi/codex-account-info.js";

const selected = "fixture-selected";
const access = "fixture-access-do-not-return";
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
    primaryWindow: { usedPercent: 0, windowSeconds: 18000, resetAt: 1800000000 }, secondaryWindow: null,
    credits: { hasCredits: false, unlimited: false, balance: "0.0000000000000000001" },
  });
  const map = await read({ accounts: () => json({
    accounts: { [selected]: { account: { account_id: selected, name: "Mapped workspace", structure: "workspace" } } },
    account_ordering: [selected], default_account_id: other,
  }) });
  assert.equal(map.account.workspaceName, "Mapped workspace");
  assert.equal(map.account.planType, null);
  const missing = await read({ usage: () => json({ plan_type: "pro", rate_limit: { allowed: true, limit_reached: false, primary_window: {} } }) });
  assert.deepEqual(missing.usage.primaryWindow, { usedPercent: null, windowSeconds: null, resetAt: null });
  assert.equal(missing.usage.secondaryWindow, null);
  assert.equal(missing.usage.credits, null);
  const over = structuredClone(usageResponse);
  over.rate_limit.primary_window.used_percent = 125;
  assert.equal((await read({ usage: () => json(over) })).usage.primaryWindow.usedPercent, 125);
  const onlyPlan = (await read({ usage: () => json({ plan_type: "pro" }) })).usage;
  assert.equal(onlyPlan.status, "available");
  assert.equal(onlyPlan.allowed, null);
  assert.equal(onlyPlan.primaryWindow, null);

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
