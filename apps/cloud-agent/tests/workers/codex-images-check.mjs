import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { codexImageStart, codexImageCheck, codexImageAccess, codexImageStatus, codexImageDisconnect, codexImageGenerate, codexImageRequest } from "../../workers/pi/codex-images-auth.js";

const clientId = "fixture-codex-client", email = "image-fixture@example.invalid";
const hash = value => createHash("sha256").update(value).digest("hex");
const expectedEmailHash = hash(email), encoder = new TextEncoder();
const b64 = bytes => Buffer.from(bytes).toString("base64url");
const signing = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
const wrapping = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
let now = Date.now();
const originalNow = Date.now, originalFetch = globalThis.fetch;
Date.now = () => now;
const claims = (overrides = {}) => ({ iss: "https://auth.openai.com", aud: clientId, sub: "fixture-subject", email, exp: now / 1000 + 3600, account: "fixture-account", plan: "pro", ...overrides });
async function jwt(overrides) {
  const input = `${b64(JSON.stringify({ alg: "EdDSA" }))}.${b64(JSON.stringify(claims(overrides)))}`;
  return `${input}.${b64(await crypto.subtle.sign("Ed25519", signing.privateKey, encoder.encode(input)))}`;
}
let verifyCalls = 0;
async function verifyIdentity(token, selectedClient, expectedHash) {
  verifyCalls++;
  const [header, body, signature] = token.split(".");
  assert.equal(JSON.parse(Buffer.from(header, "base64url")).alg, "EdDSA");
  assert.equal(await crypto.subtle.verify("Ed25519", signing.publicKey, Buffer.from(signature, "base64url"), encoder.encode(`${header}.${body}`)), true, "real fixture signature required");
  const c = JSON.parse(Buffer.from(body, "base64url"));
  assert.equal(c.iss, "https://auth.openai.com"); assert.equal(c.aud, selectedClient); assert(c.exp > now / 1000); assert.equal(hash(c.email), expectedHash);
  return { subjectHash: hash(c.sub), accountHash: hash(c.account), metadata: { accountId: c.account, email: c.email, planType: c.plan } };
}
function owner(data = new Map()) {
  const touched = [];
  return {
    env: { CODEX_IMAGE_CLIENT_ID: clientId }, data, touched,
    ctx: { storage: {
      async get(key) { touched.push(key); return structuredClone(data.get(key)); },
      async put(key, value) { touched.push(key); data.set(key, structuredClone(value)); },
      async delete(keys) { for (const key of [].concat(keys)) { touched.push(key); data.delete(key); } }
    } },
    async expectedEmailHash() { return expectedEmailHash; },
    async seal(value) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapping, encoder.encode(JSON.stringify(value)));
      return { iv: b64(iv), ciphertext: b64(encrypted) };
    },
    async open(value) {
      if (!value) return null;
      return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(value.iv, "base64url") }, wrapping, Buffer.from(value.ciphertext, "base64url"))));
    }
  };
}
let statuses = [], tokenOverride = {}, refreshOverride = {}, exchangeNetworkFailure = false, imageStatus = 200, imageLarge = false;
let pollCalls = 0, exchangeCalls = 0, refreshCalls = 0, imageCalls = 0, starts = 0;
const verifier = "fixture-code-verifier-abcdefghijklmnopqrstuvwxyz";
const challenge = b64(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)));
globalThis.fetch = async (url, init) => {
  assert.equal(init.redirect, "manual"); assert.equal(new URL(url).protocol, "https:");
  if (url.endsWith("/deviceauth/usercode")) {
    starts++; assert.deepEqual(JSON.parse(init.body), { client_id: clientId });
    return Response.json({ device_auth_id: "fixture-device", usercode: "FIXTURE-CODE", interval: "1" });
  }
  if (url.endsWith("/deviceauth/token")) {
    pollCalls++; assert.deepEqual(JSON.parse(init.body), { device_auth_id: "fixture-device", user_code: "FIXTURE-CODE" });
    const status = statuses.shift() ?? 200;
    return status === 200 ? Response.json({ authorization_code: "fixture-code", code_verifier: verifier, code_challenge: challenge }) : new Response(null, { status });
  }
  if (url === "https://auth.openai.com/oauth/token") {
    assert(!String(init.body).includes("resource"));
    if (init.headers["content-type"] === "application/x-www-form-urlencoded") {
      exchangeCalls++;
      const values = Object.fromEntries(init.body);
      assert.deepEqual(values, { grant_type: "authorization_code", client_id: clientId, code: "fixture-code", redirect_uri: "https://auth.openai.com/deviceauth/callback", code_verifier: verifier });
      if (exchangeNetworkFailure) throw new Error("fixture lost exchange");
      return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600, id_token: await jwt(), ...tokenOverride });
    }
    refreshCalls++;
    assert.deepEqual(JSON.parse(init.body), { grant_type: "refresh_token", client_id: clientId, refresh_token: "fixture-refresh" });
    return Response.json({ access_token: "fixture-renewed", expires_in: 3600, id_token: await jwt(), ...refreshOverride });
  }
  assert.equal(url, "https://chatgpt.com/backend-api/codex/images/generations");
  imageCalls++;
  assert.match(init.headers.authorization, /^Bearer fixture-(access|renewed)$/);
  assert.equal(init.headers["ChatGPT-Account-ID"], "fixture-account");
  assert.equal(init.headers.originator, "cloud-agent");
  assert.match(init.headers["x-codex-image-turn-id"], /^[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(init.body), { model: "gpt-image-2", prompt: "Fixture prompt", n: 1, quality: "low", size: "1024x1024", background: "opaque" });
  if (imageLarge) return new Response("{}", { headers: { "content-length": String(25 * 1024 * 1024) } });
  return Response.json({ created: 123, data: [{ b64_json: "Zml4dHVyZQ==", generation_id: "fixture-image" }] }, { status: imageStatus, headers: { "x-codex-imagegen-request-id": "fixture-request" } });
};
async function login(o) { await codexImageStart(o); now += 1001; return codexImageCheck(o, verifyIdentity); }
try {
  const o = owner(new Map([["credential", { fixture: "untouched-siwc" }]]));
  assert.equal((await codexImageStatus(o)).connected, false);
  await assert.rejects(codexImageGenerate({ IMAGE_PROVIDER: "codex" }, o, verifyIdentity, "Fixture prompt"), /image_auth_needed/);
  const start = await codexImageStart(o);
  assert.equal(start.verificationUrl, "https://auth.openai.com/codex/device"); assert.equal(start.userCode, "FIXTURE-CODE");
  assert(!JSON.stringify([...o.data]).includes("FIXTURE-CODE"));
  const beforePoll = pollCalls;
  assert.equal((await codexImageCheck(o, verifyIdentity)).pending, true); assert.equal(pollCalls, beforePoll);
  statuses = [403, 404];
  for (let i = 0; i < 2; i++) { now += 1001; assert.equal((await codexImageCheck(o, verifyIdentity)).pending, true); }
  now += 1001;
  assert.equal((await codexImageCheck(o, verifyIdentity)).connected, true);
  assert(!o.data.has("codexImagePending")); assert.equal(verifyCalls, 1);
  assert(!JSON.stringify([...o.data]).includes("fixture-access"));
  assert(!JSON.stringify(await codexImageStatus(o)).includes("fixture-refresh"));
  assert(!JSON.stringify(await codexImageStatus(o)).includes("clientId"));
  assert(o.touched.every(key => key.startsWith("codexImage") || key === "registration" || key === "codexRegistration"));
  assert.deepEqual(o.data.get("credential"), { fixture: "untouched-siwc" });

  const restarted = owner(o.data);
  assert.equal((await codexImageStatus(restarted)).connected, true);
  const completed = await restarted.open(o.data.get("codexImageProfile"));
  await restarted.ctx.storage.put("codexImagePending", await restarted.seal({ type: "codex_image_v1", phase: "exchanging", attemptId: completed.attemptId }));
  const completedExchanges = exchangeCalls;
  assert.equal((await codexImageCheck(owner(o.data), verifyIdentity)).connected, true);
  assert.equal(exchangeCalls, completedExchanges, "recover committed profile without another token exchange");
  assert(!o.data.has("codexImagePending"));
  const credential = await codexImageAccess(restarted, verifyIdentity);
  assert.equal(credential.kind, "codex_image_v1"); assert.equal(credential.clientId, clientId);

  const imageFirst = owner(); await login(imageFirst);
  await imageFirst.ctx.storage.put("registration", { subjectHash: hash("fixture-subject"), accountHash: hash("other-account") });
  const beforeBindingRefresh = refreshCalls;
  await assert.rejects(codexImageAccess(imageFirst, verifyIdentity), /identity_mismatch/, "an image-first login must match the later SIWC registration before returning an unexpired token");
  const imageFirstProfile = await imageFirst.open(imageFirst.data.get("codexImageProfile"));
  await imageFirst.ctx.storage.put("codexImageProfile", await imageFirst.seal({ ...imageFirstProfile, expiresAt: now + 30000 }));
  await assert.rejects(codexImageAccess(imageFirst, verifyIdentity), /identity_mismatch/, "workspace mismatch must be denied before refresh");
  assert.equal(refreshCalls, beforeBindingRefresh);

  const response = await codexImageRequest({ IMAGE_PROVIDER: "codex" }, credential, "Fixture prompt");
  assert.equal(response.headers.get("x-codex-imagegen-request-id"), "fixture-request");
  assert.equal((await response.json()).data[0].generation_id, "fixture-image");
  const count = imageCalls;
  await assert.rejects(codexImageRequest({ IMAGE_PROVIDER: "api" }, credential, "Fixture prompt"), /provider_disabled/); assert.equal(imageCalls, count);
  await assert.rejects(codexImageRequest({ IMAGE_PROVIDER: "codex" }, { ...credential, kind: "siwc" }, "Fixture prompt"), /image_auth_needed/);
  imageStatus = 403;
  await assert.rejects(codexImageRequest({ IMAGE_PROVIDER: "codex" }, credential, "Fixture prompt"), /image_permission_denied/);
  imageStatus = 200; imageLarge = true;
  await assert.rejects(codexImageRequest({ IMAGE_PROVIDER: "codex" }, credential, "Fixture prompt"), /response_too_large/); imageLarge = false;

  now += 3550000;
  const beforeRefresh = refreshCalls;
  const accesses = await Promise.all([codexImageAccess(restarted, verifyIdentity), codexImageAccess(restarted, verifyIdentity)]);
  assert.equal(refreshCalls, beforeRefresh + 1); assert.equal(accesses[0].access, "fixture-renewed");
  const stored = await restarted.open(restarted.data.get("codexImageProfile"));
  assert.equal(stored.refresh, "fixture-refresh", "retain unrotated refresh token");
  now += 3550000;
  refreshOverride = { id_token: await jwt({ account: "other-account" }) };
  await assert.rejects(codexImageAccess(restarted, verifyIdentity), /identity_mismatch/);
  const failedRefreshCalls = refreshCalls;
  await assert.rejects(codexImageAccess(owner(o.data), verifyIdentity), /refresh_failed_restart_login/); assert.equal(refreshCalls, failedRefreshCalls);
  refreshOverride = {};
  await codexImageDisconnect(restarted);
  assert.equal((await codexImageStatus(restarted)).connected, false); assert(o.data.has("credential"));

  const expired = owner(); await codexImageStart(expired); now += 900001;
  await assert.rejects(codexImageCheck(owner(expired.data), verifyIdentity), /attempt_expired/); assert(!expired.data.has("codexImagePending"));
  const failed = owner(); exchangeNetworkFailure = true;
  await assert.rejects(login(failed), /oauth_network_error/);
  const lostExchangeCalls = exchangeCalls;
  await assert.rejects(codexImageCheck(owner(failed.data), verifyIdentity), /attempt_failed_restart_login/); assert.equal(exchangeCalls, lostExchangeCalls);
  assert.equal((await codexImageStatus(failed)).loginFailed, true); exchangeNetworkFailure = false;

  for (const changes of [{ email: "wrong@example.invalid" }, { aud: "wrong-client" }, { iss: "https://evil.invalid" }, { plan: "free" }]) {
    const denied = owner(); tokenOverride = { id_token: await jwt(changes) };
    await assert.rejects(login(denied)); assert.equal((await codexImageStatus(denied)).connected, false);
  }
  const tampered = await jwt(); tokenOverride = { id_token: tampered.slice(0, -5) + "AAAAA" };
  await assert.rejects(login(owner()));
  tokenOverride = {};
  const changed = owner(); await login(changed); changed.expectedEmailHash = async () => hash("other@example.invalid");
  await assert.rejects(codexImageAccess(changed, verifyIdentity), /policy_changed/);
  console.log("Codex image auth checks passed: encrypted separate profile, pending/restart, identity and refresh guards, subscription transport; no live OAuth/image API calls.");
} finally { Date.now = originalNow; globalThis.fetch = originalFetch; }
