import { codexDiagnostic, codexHtmlError, reportCodexDiagnostic } from "./codex-http.js";

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const IMAGE_ENDPOINT = "https://chatgpt.com/backend-api/codex/images/generations";
const PENDING = "codexImagePending", PROFILE = "codexImageProfile", REGISTRATION = "codexRegistration";
const MAX_RESPONSE = 24 * 1024 * 1024;
const encoder = new TextEncoder();
const active = new WeakMap();
const check = (value, code) => { if (!value) throw new Error(code); };
const text = (value, max = 32768) => typeof value === "string" && value.length > 0 && encoder.encode(value).length <= max && !/[\x00-\x1f\x7f]/.test(value);
const read = async (owner, key) => owner.open(await owner.ctx.storage.get(key));
const write = async (owner, key, value) => owner.ctx.storage.put(key, await owner.seal(value));

function exclusive(owner, kind, action) {
  const running = active.get(owner);
  if (running) return running.kind === "access" && kind === "access" ? running.promise : Promise.reject(new Error("codex_image_auth_busy"));
  const promise = Promise.resolve().then(action).finally(() => { if (active.get(owner)?.promise === promise) active.delete(owner); });
  active.set(owner, { kind, promise });
  return promise;
}

async function bounded(response, maximum) {
  check(!response.headers.has("content-length") || Number(response.headers.get("content-length")) <= maximum, "codex_image_response_too_large");
  const reader = response.body?.getReader();
  check(reader, "codex_image_response_invalid");
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      check(length <= maximum, "codex_image_response_too_large");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function request(url, body, form = false) {
  let response;
  try {
    response = await fetch(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(30000), headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", accept: "application/json" }, body: form ? new URLSearchParams(body) : JSON.stringify(body) });
  } catch { throw new Error("codex_image_oauth_network_error"); }
  return response;
}

async function json(response) {
  const bytes = await bounded(response, 128 * 1024);
  let value;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("codex_image_oauth_response_invalid"); }
  check(value && typeof value === "object" && !Array.isArray(value), "codex_image_oauth_response_invalid");
  return value;
}

function tokenFields(token, previous) {
  check(text(token.access_token) && !token.access_token.startsWith("sk-"), "codex_image_access_token_invalid");
  check(token.token_type === undefined || token.token_type?.toLowerCase() === "bearer", "codex_image_token_type_invalid");
  const refresh = token.refresh_token ?? previous?.refresh;
  check(text(refresh), "codex_image_refresh_token_missing");
  check(token.expires_in === undefined || (Number.isFinite(token.expires_in) && token.expires_in > 0), "codex_image_token_lifetime_invalid");
  let expiresAt = Date.now() + token.expires_in * 1000;
  if (token.expires_in === undefined) {
    try { expiresAt = JSON.parse(atob(token.access_token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/"))).exp * 1000; } catch { expiresAt = NaN; }
  }
  check(Number.isFinite(expiresAt) && expiresAt > Date.now() && expiresAt <= Date.now() + 365 * 86400000, "codex_image_token_lifetime_invalid");
  return { access: token.access_token, refresh, expiresAt };
}

async function identity(owner, verifyIdentity, idToken, clientId, pinned, registrationPin) {
  check(text(idToken), "codex_image_id_token_missing");
  const verified = await verifyIdentity(idToken, clientId, await owner.expectedEmailHash(), registrationPin);
  check(verified && text(verified.subjectHash, 256) && text(verified.accountHash, 256) && text(verified.metadata?.accountId, 256) && text(verified.metadata?.email, 320), "codex_image_identity_invalid");
  check(text(verified.metadata.planType, 64) && verified.metadata.planType.toLowerCase() !== "free", "codex_image_subscription_required");
  check(!pinned || (pinned.subjectHash === verified.subjectHash && pinned.accountHash === verified.accountHash && pinned.metadata.accountId === verified.metadata.accountId), "codex_image_identity_mismatch");
  return verified;
}

const registrationIdentity = value => value ? { clientId: value.clientId ?? null, subjectHash: value.subjectHash ?? null, accountHash: value.accountHash ?? null } : null;
const registrationFingerprint = value => JSON.stringify(registrationIdentity(value));
async function checkRegistration(owner, profile, requireCodexPin = true) {
  const pinned = await owner.ctx.storage.get("registration");
  if (profile.unified) {
    const codexPin = await read(owner, REGISTRATION);
    check(!requireCodexPin || codexPin, "codex_registration_missing");
    check(!codexPin || (codexPin.issuer === ISSUER && codexPin.clientId === profile.clientId && codexPin.expectedEmailHash === profile.expectedEmailHash && codexPin.subjectHash === profile.subjectHash && codexPin.accountHash === profile.accountHash && codexPin.metadata.accountId === profile.metadata.accountId), "codex_image_identity_mismatch");
    check(profile.migration?.intent === "admin_unified_connection" && profile.migration.registrationFingerprint === registrationFingerprint(pinned), "codex_image_identity_policy_changed");
    check(!pinned?.accountHash || pinned.accountHash === profile.accountHash, "codex_image_identity_mismatch");
    check(pinned?.clientId !== profile.clientId || !pinned.subjectHash || pinned.subjectHash === profile.subjectHash, "codex_image_identity_mismatch");
  } else check((!pinned?.subjectHash || pinned.subjectHash === profile.subjectHash) && (!pinned?.accountHash || pinned.accountHash === profile.accountHash), "codex_image_identity_mismatch");
}
function checkAccessAccount(profile) {
  let claims;
  try { const parts = profile.access.split("."); check(parts.length === 3, "codex_access_account_invalid"); claims = JSON.parse(atob(parts[1].replaceAll("-", "+").replaceAll("_", "/"))); } catch { throw new Error("codex_access_account_invalid"); }
  check(claims?.["https://api.openai.com/auth"]?.chatgpt_account_id === profile.metadata.accountId, "codex_access_account_mismatch");
}

export function codexImageStart(owner, unified = false) {
  return exclusive(owner, "start", async () => {
    const expectedEmailHash = await owner.expectedEmailHash();
    const previous = await read(owner, PROFILE), codexPin = await read(owner, REGISTRATION);
    check(unified || (!previous?.unified && !codexPin), "codex_unified_connection_required");
    const clientId = codexPin?.clientId ?? previous?.clientId ?? owner.env.CODEX_IMAGE_CLIENT_ID ?? CLIENT_ID;
    check(text(clientId, 255) && /^[A-Za-z0-9._:-]+$/.test(clientId), "codex_image_client_invalid");
    const registration = await owner.ctx.storage.get("registration");
    const migration = unified ? { intent: "admin_unified_connection", registrationFingerprint: registrationFingerprint(registration), registration: registrationIdentity(registration) } : undefined;
    const response = await request(`${ISSUER}/api/accounts/deviceauth/usercode`, { client_id: clientId });
    check(response.ok, `codex_image_oauth_http_${response.status}`);
    const result = await json(response);
    const userCode = result.user_code ?? result.usercode;
    const interval = Number(result.interval);
    check(text(result.device_auth_id, 4096) && text(userCode, 128) && Number.isSafeInteger(interval) && interval >= 1 && interval <= 300, "codex_image_device_response_invalid");
    check(expectedEmailHash === await owner.expectedEmailHash(), "codex_image_identity_policy_changed");
    if (unified) check(migration.registrationFingerprint === registrationFingerprint(await owner.ctx.storage.get("registration")), "codex_image_identity_policy_changed");
    const pending = { unified, migration, type: "codex_image_v1", attemptId: crypto.randomUUID(), phase: "pending", clientId, expectedEmailHash, deviceAuthId: result.device_auth_id, userCode, interval, expiresAt: Date.now() + 900000, nextAt: Date.now() + interval * 1000 };
    await write(owner, PENDING, pending);
    return { verificationUrl: `${ISSUER}/codex/device`, userCode, expiresAt: new Date(pending.expiresAt).toISOString(), nextCheckAt: new Date(pending.nextAt).toISOString() };
  });
}

export function codexImageCheck(owner, verifyIdentity) {
  return exclusive(owner, "check", async () => {
    const pending = await read(owner, PENDING);
    check(pending?.type === "codex_image_v1", "codex_image_login_required");
    if (pending.attemptId && (await read(owner, PROFILE))?.attemptId === pending.attemptId) { await owner.ctx.storage.delete(PENDING); return codexImageStatus(owner); }
    check(pending.phase === "pending", "codex_image_attempt_failed_restart_login");
    if (pending.expiresAt <= Date.now()) { await owner.ctx.storage.delete(PENDING); throw new Error("codex_image_attempt_expired"); }
    check(pending.expectedEmailHash === await owner.expectedEmailHash(), "codex_image_identity_policy_changed");
    if (pending.unified) check(pending.migration?.intent === "admin_unified_connection" && pending.migration.registrationFingerprint === registrationFingerprint(await owner.ctx.storage.get("registration")), "codex_image_identity_policy_changed");
    if (pending.nextAt > Date.now()) return { pending: true, nextCheckAt: new Date(pending.nextAt).toISOString() };
    // Persist before polling too: a lost successful poll must not replay a consumed code.
    await write(owner, PENDING, { ...pending, phase: "checking" });
    try {
      const response = await request(`${ISSUER}/api/accounts/deviceauth/token`, { device_auth_id: pending.deviceAuthId, user_code: pending.userCode });
      if ([403, 404].includes(response.status)) {
        pending.nextAt = Date.now() + pending.interval * 1000;
        await write(owner, PENDING, pending);
        return { pending: true, nextCheckAt: new Date(pending.nextAt).toISOString() };
      }
      check(response.ok, `codex_image_oauth_http_${response.status}`);
      const result = await json(response);
      check(text(result.authorization_code, 8192) && text(result.code_verifier, 512) && text(result.code_challenge, 512), "codex_image_device_response_invalid");
      const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(result.code_verifier))))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      check(challenge === result.code_challenge, "codex_image_pkce_mismatch");
      await write(owner, PENDING, { ...pending, phase: "exchanging" });
      const exchange = await request(`${ISSUER}/oauth/token`, { grant_type: "authorization_code", client_id: pending.clientId, code: result.authorization_code, redirect_uri: `${ISSUER}/deviceauth/callback`, code_verifier: result.code_verifier }, true);
      check(exchange.ok, `codex_image_oauth_http_${exchange.status}`);
      const token = await json(exchange);
      const credential = tokenFields(token);
      const previous = await read(owner, PROFILE);
      const legacy = pending.migration?.registration;
      const registrationPin = pending.unified ? { ...(legacy?.accountHash ? { accountHash: legacy.accountHash } : {}), ...(legacy?.clientId === pending.clientId && legacy.subjectHash ? { subjectHash: legacy.subjectHash } : {}) } : undefined;
      const verified = await identity(owner, verifyIdentity, token.id_token, pending.clientId, await read(owner, REGISTRATION) ?? (previous?.clientId === pending.clientId ? previous : null), registrationPin);
      const profile = { type: "codex_image_v1", unified: pending.unified === true, migration: pending.migration, attemptId: pending.attemptId, clientId: pending.clientId, expectedEmailHash: pending.expectedEmailHash, ...credential, ...verified };
      await checkRegistration(owner, profile, false);
      if (profile.unified) checkAccessAccount(profile);
      check(pending.expectedEmailHash === await owner.expectedEmailHash(), "codex_image_identity_policy_changed");
      if (profile.unified) {
        const pin = { type: "codex_registration_v1", issuer: ISSUER, clientId: profile.clientId, expectedEmailHash: profile.expectedEmailHash, subjectHash: profile.subjectHash, accountHash: profile.accountHash, metadata: { accountId: profile.metadata.accountId } };
        const sealedProfile = await owner.seal(profile), sealedPin = await owner.seal(pin);
        await owner.ctx.storage.transaction(async storage => {
          check(pending.migration.registrationFingerprint === registrationFingerprint(await storage.get("registration")), "codex_image_identity_policy_changed");
          check(pending.expectedEmailHash === ((await storage.get("identityPolicy"))?.expectedEmailHash ?? owner.env.OWNER_EMAIL_SHA256), "codex_image_identity_policy_changed");
          const existingPin = await owner.open(await storage.get(REGISTRATION));
          check(!existingPin || JSON.stringify(existingPin) === JSON.stringify(pin), "codex_image_identity_mismatch");
          await storage.put(PROFILE, sealedProfile); await storage.put(REGISTRATION, sealedPin); await storage.delete(PENDING);
        });
      } else { await write(owner, PROFILE, profile); await owner.ctx.storage.delete(PENDING); }
      return codexImageStatus(owner);
    } catch (error) {
      await write(owner, PENDING, { type: pending.type, attemptId: pending.attemptId, phase: "failed", expiresAt: pending.expiresAt });
      throw error;
    }
  });
}

export async function codexImageStatus(owner) {
  const profile = await read(owner, PROFILE), pending = await read(owner, PENDING);
  let valid = !profile?.refreshFailed;
  if (profile?.unified) { try { await checkRegistration(owner, profile); checkAccessAccount(profile); check(profile.expectedEmailHash === await owner.expectedEmailHash(), "codex_image_identity_policy_changed"); } catch { valid = false; } }
  return { provider: "codex", unified: profile?.unified === true, inferenceReady: profile?.unified === true && valid, reconnectRequired: !!profile && !valid, connected: profile?.type === "codex_image_v1", identity: profile?.metadata ?? null, expiresAt: profile ? new Date(profile.expiresAt).toISOString() : null, loginPending: pending?.phase === "pending" && pending.expiresAt > Date.now(), loginFailed: !!pending && pending.phase !== "pending", nextCheckAt: pending?.phase === "pending" ? new Date(pending.nextAt).toISOString() : null };
}

export function codexImageAccess(owner, verifyIdentity, forceRefresh = false, inference = false) {
  return exclusive(owner, "access", async () => {
    const profile = await read(owner, PROFILE);
    check(profile?.type === "codex_image_v1", "codex_image_login_required");

    check(profile.expectedEmailHash === await owner.expectedEmailHash(), "codex_image_identity_policy_changed");
    await checkRegistration(owner, profile);
    if (profile.unified) checkAccessAccount(profile);
    check(!profile.refreshFailed, "codex_image_refresh_failed_restart_login");
    if (!forceRefresh && profile.expiresAt - Date.now() > 60000) return { kind: "codex_image_v1", clientId: profile.clientId, access: profile.access, accountId: profile.metadata.accountId, unified: profile.unified === true };
    // A refresh token may rotate; a crashed exchange requires a new login instead of replay.
    await write(owner, PROFILE, { ...profile, refreshFailed: true });
    const response = await request(`${ISSUER}/oauth/token`, { grant_type: "refresh_token", client_id: profile.clientId, refresh_token: profile.refresh });
    check(response.ok, `codex_image_oauth_http_${response.status}`);
    const token = await json(response);
    const credential = tokenFields(token, profile);
    const verified = token.id_token === undefined ? profile : await identity(owner, verifyIdentity, token.id_token, profile.clientId, profile, profile.unified ? {} : undefined);
    const renewed = { ...profile, ...credential, subjectHash: verified.subjectHash, accountHash: verified.accountHash, metadata: verified.metadata, refreshFailed: false };
    await checkRegistration(owner, renewed);
    if (renewed.unified) checkAccessAccount(renewed);
    await write(owner, PROFILE, renewed);
    return { kind: "codex_image_v1", clientId: renewed.clientId, access: renewed.access, accountId: renewed.metadata.accountId, unified: renewed.unified === true };
  }).then(profile => { check(!inference || profile.unified, "codex_unified_login_required"); return profile; });
}

export function codexImageDisconnect(owner, all = false) {
  return exclusive(owner, "disconnect", async () => {
    check(all || (!(await read(owner, PROFILE))?.unified && !await read(owner, REGISTRATION)), "codex_unified_disconnect_requires_account_action");
    await owner.ctx.storage.delete([PENDING, PROFILE]);
    return codexImageStatus(owner);
  });
}

export async function codexImageRequest(env, profile, prompt, signal, onDiagnostic) {
  check(env.IMAGE_PROVIDER === "codex", "codex_image_provider_disabled");
  check(typeof prompt === "string" && prompt.trim() && encoder.encode(prompt).length <= 16384, "codex_image_prompt_invalid");
  check(profile?.kind === "codex_image_v1" && text(profile.clientId, 255) && text(profile.access) && !profile.access.startsWith("sk-") && text(profile.accountId, 256), "image_auth_needed");
  const { access, accountId } = profile;
  const response = await fetch(IMAGE_ENDPOINT, { method: "POST", redirect: "manual", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000), headers: { authorization: `Bearer ${access}`, "ChatGPT-Account-ID": accountId, "content-type": "application/json", accept: "application/json", originator: "cloud-agent", "user-agent": "cloud-agent/1", "x-codex-image-turn-id": crypto.randomUUID() }, body: JSON.stringify({ model: "gpt-image-2", prompt, n: 1, quality: "low", size: "1024x1024", background: "opaque" }) });
  let diagnostic = codexDiagnostic("image", response);
  await reportCodexDiagnostic(onDiagnostic, diagnostic);
  if (!response.ok || diagnostic.category === "upstream_blocked" || diagnostic.contentType === "html") {
    const bytes = await bounded(response, 128 * 1024);
    const body = new TextDecoder().decode(bytes);
    let structured = false;
    try { const value = JSON.parse(body); structured = value && typeof value === "object" && !Array.isArray(value); } catch { }
    let revised = diagnostic;
    if (codexHtmlError(body)) revised = { ...diagnostic, errorBodyFormat: "html" };
    else if (diagnostic.contentType === "json" && !structured && ["auth_required", "permission_denied"].includes(diagnostic.category)) revised = { ...diagnostic, category: "invalid_response" };
    if (revised !== diagnostic) { diagnostic = revised; await reportCodexDiagnostic(onDiagnostic, diagnostic); }
    const code = diagnostic.category === "upstream_blocked" || diagnostic.contentType === "html" || diagnostic.errorBodyFormat === "html" ? "image_upstream_blocked" : diagnostic.category === "auth_required" ? "image_auth_needed" : diagnostic.category === "permission_denied" && diagnostic.contentType === "json" ? "image_permission_denied" : `codex_image_http_${response.status}`;
    throw Object.assign(new Error(code), { diagnostic });
  }
  const bytes = await bounded(response, MAX_RESPONSE);
  const headers = { "content-type": "application/json" };
  const requestId = response.headers.get("x-codex-imagegen-request-id");
  if (requestId && requestId === diagnostic.requestId) headers["x-codex-imagegen-request-id"] = requestId;
  return new Response(bytes, { status: response.status, headers });
}

export async function codexImageGenerate(env, owner, verifyIdentity, prompt, signal) {
  check(env.IMAGE_PROVIDER === "codex", "codex_image_provider_disabled");
  let profile;
  try { profile = await codexImageAccess(owner, verifyIdentity); }
  catch (error) {
    if (["codex_image_login_required", "codex_image_refresh_failed_restart_login", "codex_image_oauth_http_401", "codex_image_oauth_http_403"].includes(error.message)) throw new Error("image_auth_needed");
    throw error;
  }
  return codexImageRequest(env, profile, prompt, signal);
}
