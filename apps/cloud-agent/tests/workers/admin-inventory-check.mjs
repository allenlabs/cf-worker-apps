import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const admin = await readFile(new URL("../../workers/pi/admin.js", import.meta.url), "utf8");
const runtime = await readFile(new URL("../../workers/pi/index.js", import.meta.url), "utf8");
function section(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Source boundaries exist: ${start}`);
  return source.slice(first, last);
}

// Execute the actual class and subscription methods without loading the Worker/Pi runtime.
const Credentials = new Function("DurableObject", "pinTenant", `
  ${section(admin, "const encoder =", "const page = adminPage;").replaceAll(/^export /gm, "")}
  ${section(runtime, "class LoginError extends Error", "function skillSource(")}
  return class extends ManagementCredentials {
    ${section(runtime, "  async #subscriptionInventory() {", "  async expectedEmailHash() {")}
    async adminSession() { return { principal: { subject: "synthetic-admin", email: "admin@example.invalid" }, csrf: "fixture-csrf" }; }
  };
`)(class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }, async () => {});

const selection = { mode: "fixed", defaultAccountId: "owner", poolAccountIds: [] };
function fixture(count) {
  const inventory = [{ id: "owner", label: "owner", createdAt: null }, ...Array.from({ length: count - 1 }, (_, index) => ({
    id: `account-00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`, label: "Existing account",
  }))];
  const values = new Map(Object.entries({ adminAccounts: inventory, accountSelection: selection, defaultAccountId: "owner" }));
  let transactionTail = Promise.resolve(), configured = 0;
  const storage = {
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) {
      for (const [name, item] of typeof key === "string" ? [[key, value]] : Object.entries(key)) values.set(name, structuredClone(item));
    },
    async transaction(callback) {
      const pending = transactionTail.then(() => callback(this));
      transactionTail = pending.catch(() => undefined);
      return pending;
    },
  };
  const started = Promise.withResolvers(), released = Promise.withResolvers();
  const credentials = new Credentials({ storage, blockConcurrencyWhile: callback => callback() }, {
    SUBSCRIPTION_INFERENCE_PROVIDER: "auto", INFERENCE_BRIDGE_PROVIDER: "auto",
    INFERENCE_BRIDGE_ACCOUNT_ID: "owner", INFERENCE_BRIDGE_MODEL: "gpt-5.4",
    Credentials: { getByName(id) { return { async configureAccount(policy) {
      configured++;
      assert.equal(policy.label, id);
      assert.match(policy.expectedEmailHash, /^[a-f0-9]{64}$/);
      started.resolve(); await released.promise;
    } }; } },
  });
  return { credentials, storage, started, released, configured: () => configured };
}

for (const count of [1, 19]) {
  const f = fixture(count);
  const legacy = f.credentials.adminMutation("account.create", { expectedEmail: "fixture@example.invalid" }, "fixture-session", "fixture-csrf");
  await f.started.promise;
  const named = await f.credentials.createSubscriptionConnection({ label: "Named connection" });
  assert.ok((await f.credentials.accountInventory()).some(row => row.id === named.id));
  f.released.resolve();
  const result = await legacy, rows = await f.credentials.accountInventory();
  assert.ok(rows.some(row => row.id === named.id), "A successful subscription creation survives concurrent legacy account.create");
  if (count === 1) {
    assert.ok(rows.some(row => row.id === result.id && row.expectedEmail === "fixture@example.invalid" && !row.subscriptionSetup));
    assert.equal(rows.length, 3);
  } else {
    assert.deepEqual(result, { adminError: "account_limit", status: 409 });
    assert.equal(rows.length, 20, "The final slot cannot be consumed twice across the configureAccount wait");
    assert.equal((await f.credentials.adminAudit()).length, 0, "A rejected create records no successful account.create audit");
  }
  assert.deepEqual(await f.storage.get("accountSelection"), selection);
  assert.equal(await f.storage.get("defaultAccountId"), "owner");
}

const full = fixture(20);
assert.deepEqual(await full.credentials.adminMutation("account.create", { expectedEmail: "fixture@example.invalid" }, "fixture-session", "fixture-csrf"), { adminError: "account_limit", status: 409 });
assert.equal(full.configured(), 0, "The initial capacity check precedes configureAccount");
console.log("PASS: actual account.create and subscription methods preserve concurrent inventory inserts, enforce the final slot atomically, and retain account selection.");
