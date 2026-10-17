import { createRemoteJWKSet, jwtVerify } from "jose";
import { subscriptionPage } from "./view.js";
export { Credentials, CloudAgentInference } from "../../cloud-agent/workers/pi/index.js";

const encoder = new TextEncoder();
const jwks = new Map();
const BODY_LIMIT = 20480;
const emailPattern = /^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/;
const safeErrors = new Set(["account_identity_policy_pinned", "oauth_busy", "selected_email_mismatch", "selected_user_mismatch", "selected_workspace_mismatch", "oauth_attempt_expired", "callback_state_mismatch", "authorization_declined", "plan_usage_scope_missing", "callback_uri_mismatch", "callback_parameter_repeated", "callback_issuer_mismatch", "callback_registration_incomplete", "callback_client_mismatch"]);

class RequestError extends Error {
  constructor(code, status = 400) { super(code); this.status = status; }
}

function settings(env) {
  let origin, issuer, users;
  try {
    origin = new URL(env.PUBLIC_ORIGIN);
    issuer = new URL(env.CF_ACCESS_ISS);
    users = JSON.parse(env.INFERENCE_BRIDGE_ALLOWED_USER_IDS);
  } catch { throw new RequestError("configuration_invalid", 503); }
  if (origin.protocol !== "https:" || origin.origin !== env.PUBLIC_ORIGIN || issuer.protocol !== "https:" || issuer.origin !== env.CF_ACCESS_ISS ||
      typeof env.CF_ACCESS_AUD !== "string" || !env.CF_ACCESS_AUD || env.CF_ACCESS_AUD.length > 255 ||
      typeof env.SUBSCRIPTION_ADMIN_EMAIL !== "string" || !emailPattern.test(env.SUBSCRIPTION_ADMIN_EMAIL) || env.SUBSCRIPTION_ADMIN_EMAIL !== env.SUBSCRIPTION_ADMIN_EMAIL.toLowerCase() || env.SUBSCRIPTION_ADMIN_EMAIL.length > 254 ||
      env.SUBSCRIPTION_INFERENCE_PROVIDER !== "siwc" || env.INFERENCE_BRIDGE_PROVIDER !== "siwc" || env.INFERENCE_BRIDGE_ACCOUNT_ID !== "owner" ||
      !/^[a-zA-Z0-9._-]{1,128}$/.test(env.INFERENCE_BRIDGE_MODEL || "") ||
      !Array.isArray(users) || !users.length || users.length > 20 || new Set(users).size !== users.length || users.some(user => typeof user !== "string" || !emailPattern.test(user) || user.length > 254 || user !== user.toLowerCase()) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(env.TENANT_ID || "") ||
      !/^[A-Za-z0-9_-]{43}$/.test(env.TOKEN_WRAPPING_KEY || "") || typeof env.TOKEN_WRAPPING_AAD !== "string" || !env.TOKEN_WRAPPING_AAD || encoder.encode(env.TOKEN_WRAPPING_AAD).length > 128) {
    throw new RequestError("configuration_invalid", 503);
  }
  return { origin: origin.origin, issuer: issuer.origin, audience: env.CF_ACCESS_AUD, admin: env.SUBSCRIPTION_ADMIN_EMAIL };
}

async function authenticate(request, config) {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || token.length > 16384) throw new RequestError("access_denied", 401);
  let payload;
  try {
    if (!jwks.has(config.issuer)) jwks.set(config.issuer, createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`)));
    ({ payload } = await jwtVerify(token, jwks.get(config.issuer), {
      issuer: config.issuer, audience: config.audience, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub"],
    }));
  } catch { throw new RequestError("access_denied", 401); }
  if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat) || payload.iat > Date.now() / 1000 + 60) throw new RequestError("access_denied", 401);
  if (typeof payload.sub !== "string" || !payload.sub || typeof payload.email !== "string" || payload.email.trim().toLowerCase() !== config.admin || payload.email_verified === false) {
    throw new RequestError("admin_denied", 403);
  }
}

async function body(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") || "") || request.headers.has("content-encoding")) throw new RequestError("json_required", 415);
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > BODY_LIMIT)) throw new RequestError("body_too_large", 413);
  if (!request.body) throw new RequestError("body_invalid");
  const reader = request.body.getReader(), parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) { await reader.cancel(); throw new RequestError("body_too_large", 413); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new RequestError("body_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RequestError("body_invalid");
  return parsed;
}

function readiness(status) {
  const identity = status.identityVerified === true ? status.identity : null;
  return { siwcInferenceReady: status.siwcInferenceReady === true, connected: status.connected === true, loginPending: status.loginPending === true, identityVerified: status.identityVerified === true, planUsageConfirmed: status.planUsageConfirmed === true,
    identity: identity ? { email: identity.email, planType: identity.planType, workspaceName: identity.workspace?.title ?? null } : null };
}

function secure(response, nonce) {
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("content-security-policy", `default-src 'none'; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; style-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
  response.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return response;
}

export default {
  async fetch(request, env) {
    try {
      const config = settings(env), url = new URL(request.url);
      if (url.origin !== config.origin || url.search) throw new RequestError("request_invalid");
      await authenticate(request, config);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/gatekeeper/subscription")) {
        const nonce = crypto.randomUUID().replaceAll("-", "");
        return secure(new Response(subscriptionPage(nonce), { headers: { "content-type": "text/html; charset=utf-8" } }), nonce);
      }
      if (!["/gatekeeper/subscription/status", "/gatekeeper/subscription/start", "/gatekeeper/subscription/complete"].includes(url.pathname)) throw new RequestError("not_found", 404);
      if (request.method !== "POST") throw new RequestError("method_not_allowed", 405);
      if (request.headers.get("origin") !== config.origin) throw new RequestError("origin_denied", 403);
      const input = await body(request);
      if (url.pathname === "/gatekeeper/subscription/status") {
        if (Object.keys(input).length) throw new RequestError("body_invalid");
        return secure(Response.json(readiness(await env.Credentials.getByName("owner").status())));
      }
      if (url.pathname === "/gatekeeper/subscription/start") {
        if (Object.keys(input).some(key => !["email", "planUsageConfirmed"].includes(key)) || input.planUsageConfirmed !== true || typeof input.email !== "string" || input.email.length > 254 || !emailPattern.test(input.email.trim())) throw new RequestError("start_input_invalid");
        const email = input.email.trim().toLowerCase();
        const expectedEmailHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(email)))].map(value => value.toString(16).padStart(2, "0")).join("");
        const credentials = env.Credentials.getByName("owner");
        await credentials.configureAccount({ expectedEmailHash, label: "Personal ChatGPT subscription" });
        const attempt = await credentials.start(true);
        const authorization = new URL(attempt.authorizationUrl);
        if (authorization.origin !== "https://auth.openai.com" || authorization.pathname !== "/api/accounts/authorize") throw new RequestError("oauth_failed", 502);
        return secure(Response.json({ authorizationUrl: authorization.href, expiresIn: attempt.expiresIn, manualCallbackRequired: true }));
      }
      if (Object.keys(input).length !== 1 || typeof input.callbackUrl !== "string" || input.callbackUrl.length > 16384) throw new RequestError("callback_input_invalid");
      return secure(Response.json(readiness(await env.Credentials.getByName("owner").complete(input.callbackUrl))));
    } catch (error) {
      const code = error instanceof RequestError || safeErrors.has(error?.message) ? error.message : "oauth_failed";
      return secure(Response.json({ error: code }, { status: error instanceof RequestError ? error.status : 400 }));
    }
  },
};
