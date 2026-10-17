import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { OAuthClient, type OAuthClientAuth, type OAuthTokens } from "@gadgets/gatekeeper-kit/oauth-client";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";

export interface Env {
  PUBLIC_BASE_URL: string;
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  OIDC_CLIENT_SECRET?: string;
  SIGN_IN_PROTOCOL?: string;
  OAUTH_JWT_RESOURCE?: string;
  OAUTH_JWT_SCOPES?: string;
  OAUTH_JWT_TOKEN_ENDPOINT_AUTH_METHOD?: string;
  OIDC_DISPLAY_NAME?: string;
  OIDC_ALLOWED_IDENTITIES: string;
  OIDC_LOGIN_URL?: string;
  OIDC_LOGIN_SITE?: string;
}

const SIGN_IN_FAILURES = {
  invalid_identity_response: 400, invalid_sign_in_configuration: 503,
  identity_provider_unavailable: 502, identity_provider_protocol_mismatch: 502,
  identity_provider_endpoint_mismatch: 502, invalid_identity_token: 400,
  invalid_identity_keys: 400, identity_subject_mismatch: 400,
  verified_email_required: 403, identity_not_allowed: 403,
  sign_in_only: 400, invalid_sign_in_attempt: 400, sign_in_attempt_expired: 400,
  invalid_sign_in_callback: 400, invalid_sign_in_handoff: 400, restart_sign_in: 400,
  token_client_rejected: 400, token_grant_rejected: 400, token_exchange_failed: 400,
  sign_in_handoff_failed: 502, sign_in_cleanup_failed: 502, sign_in_failed: 400,
} as const;
export type SignInCode = keyof typeof SIGN_IN_FAILURES;
export type SignInFailure = { code: SignInCode; status: number };
export type SignInResult<T> = { ok: true; value: T } | { ok: false; error: SignInFailure };

export class SignInError extends Error {
  constructor(readonly code: SignInCode) { super(code); }
}

/** Only fixed categories cross RPC; provider messages and exception properties never do. */
export function signInFailure(error: unknown, fallback: SignInCode): { ok: false; error: SignInFailure } {
  const code = error instanceof SignInError && Object.hasOwn(SIGN_IN_FAILURES, error.code) ? error.code : fallback;
  return { ok: false, error: { code, status: SIGN_IN_FAILURES[code] } };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SignInError("invalid_identity_response");
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown, maximum = 2048): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new SignInError("invalid_identity_response");
  return value;
}

function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new SignInError("invalid_sign_in_configuration");
  return url;
}

export function configuration(env: Env) {
  try {
    const issuer = httpsUrl(text(env.OIDC_ISSUER));
    if (issuer.search || issuer.href.replace(/\/$/, "") !== env.OIDC_ISSUER) throw Error();
    const origin = httpsUrl(text(env.PUBLIC_BASE_URL));
    if (origin.origin !== env.PUBLIC_BASE_URL) throw Error();
    const clientId = text(env.OIDC_CLIENT_ID, 255);
    const raw: unknown = JSON.parse(env.OIDC_ALLOWED_IDENTITIES);
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) throw Error();
    const allowed = raw.map(value => {
      const identity = record(value);
      const email = text(identity.email, 320).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw Error();
      return { email, subject: text(identity.subject, 255) };
    });
    if (new Set(allowed.map(identity => identity.email)).size !== allowed.length) throw Error();
    const login = env.OIDC_LOGIN_URL ? httpsUrl(env.OIDC_LOGIN_URL) : null;
    if (env.OIDC_LOGIN_SITE && !login) throw Error();
    if (env.OIDC_LOGIN_SITE && !/^[A-Za-z0-9_-]{1,96}$/.test(env.OIDC_LOGIN_SITE)) throw Error();
    const common = { issuer: env.OIDC_ISSUER, origin: origin.origin, clientId, allowed, login,
      displayName: env.OIDC_DISPLAY_NAME ? text(env.OIDC_DISPLAY_NAME, 128) : "Organization SSO",
      callback: `${origin.origin}/gatekeeper/oidc/oauth` };
    if (env.SIGN_IN_PROTOCOL === "oauth-jwt") {
      const resource = httpsUrl(text(env.OAUTH_JWT_RESOURCE));
      if (resource.origin !== env.OAUTH_JWT_RESOURCE) throw Error();
      const rawScopes: unknown = JSON.parse(text(env.OAUTH_JWT_SCOPES, 8192));
      if (!Array.isArray(rawScopes) || rawScopes.length === 0 || rawScopes.length > 32) throw Error();
      const scopes = rawScopes.map(scope => text(scope, 128));
      if (scopes.some(scope => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope)
          || scope === "openid" || scope === "offline_access") || new Set(scopes).size !== scopes.length) throw Error();
      const method = env.OAUTH_JWT_TOKEN_ENDPOINT_AUTH_METHOD;
      if (method !== "none" && method !== "client_secret_post") throw Error();
      const client: OAuthClientAuth = method === "none" ? { method: "none", id: clientId }
        : { method: "post", id: clientId, secret: text(env.OIDC_CLIENT_SECRET, 4096) };
      if (method === "none" && env.OIDC_CLIENT_SECRET !== undefined) throw Error();
      return { ...common, mode: "oauth-jwt" as const, resource: resource.origin, scopes, method, client };
    }
    if (env.SIGN_IN_PROTOCOL !== undefined && env.SIGN_IN_PROTOCOL !== "oidc"
        || env.OAUTH_JWT_RESOURCE !== undefined || env.OAUTH_JWT_SCOPES !== undefined
        || env.OAUTH_JWT_TOKEN_ENDPOINT_AUTH_METHOD !== undefined) throw Error();
    const client: OAuthClientAuth = { method: "basic", encoding: "form", id: clientId,
      secret: text(env.OIDC_CLIENT_SECRET, 4096) };
    return { ...common, mode: "oidc" as const, client };
  } catch { throw new SignInError("invalid_sign_in_configuration"); }
}

export type Configuration = ReturnType<typeof configuration>;
export type VerifiedIdentity = { email: string; subject: string; expiresAt: number };

export function allowedIdentity(config: Configuration, identity: VerifiedIdentity): boolean {
  return identity.expiresAt > Date.now() && config.allowed.some(candidate =>
    candidate.email === identity.email && candidate.subject === identity.subject);
}

async function remoteJson(url: string, headers?: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { accept: "application/json", ...headers },
    redirect: "manual", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new SignInError("identity_provider_unavailable");
  return record(JSON.parse(await readTextCapped(response, 65536)));
}

export async function discover(config: Configuration) {
  const issuer = new URL(config.issuer);
  const metadata = config.mode === "oauth-jwt"
    ? `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname === "/" ? "" : issuer.pathname}`
    : `${config.issuer}/.well-known/openid-configuration`;
  const document = await remoteJson(metadata);
  const grants = document.grant_types_supported === undefined ? ["authorization_code", "implicit"] : document.grant_types_supported;
  if (document.issuer !== config.issuer
      || !Array.isArray(document.code_challenge_methods_supported) || !document.code_challenge_methods_supported.includes("S256")
      || (config.mode === "oidc"
        ? !Array.isArray(document.id_token_signing_alg_values_supported) || !document.id_token_signing_alg_values_supported.includes("EdDSA")
        : document.authorization_response_iss_parameter_supported !== true
          || !Array.isArray(document.response_types_supported) || !document.response_types_supported.includes("code")
          || !Array.isArray(grants) || !grants.includes("authorization_code")
          || !Array.isArray(document.token_endpoint_auth_methods_supported) || !document.token_endpoint_auth_methods_supported.includes(config.method))) {
    throw new SignInError("identity_provider_protocol_mismatch");
  }
  function endpoint(key: string) {
    const value = httpsUrl(text(document[key]));
    if (value.origin !== new URL(config.issuer).origin) throw new SignInError("identity_provider_endpoint_mismatch");
    return value.href;
  }
  return { authorization: endpoint("authorization_endpoint"), token: endpoint("token_endpoint"),
    jwks: endpoint("jwks_uri"), userinfo: config.mode === "oidc" ? endpoint("userinfo_endpoint") : null };
}

export function oauthClient(config: Configuration, endpoints: Awaited<ReturnType<typeof discover>>) {
  return new OAuthClient({ label: "Identity provider", client: config.client, tokenEndpoint: endpoints.token,
    authorizationEndpoint: endpoints.authorization, timeoutMs: 15000, maxResponseBytes: 65536 });
}

export async function verifyIdentity(config: Configuration, endpoints: Awaited<ReturnType<typeof discover>>,
  tokens: OAuthTokens, nonce: string): Promise<VerifiedIdentity> {
  if (config.mode === "oauth-jwt") return verifyAccessIdentity(config, endpoints.jwks, tokens);
  const token = text(tokens.idToken, 32768);
  const header = decodeProtectedHeader(token);
  if (header.alg !== "EdDSA" || typeof header.kid !== "string" || !header.kid || header.kid.length > 255 || header.crit) {
    throw new SignInError("invalid_identity_token");
  }
  const jwks = await remoteJson(endpoints.jwks);
  if (!Array.isArray(jwks.keys) || jwks.keys.length > 32) throw new SignInError("invalid_identity_keys");
  const keys = jwks.keys.map(record).filter(key => key.kid === header.kid && key.kty === "OKP"
    && key.crv === "Ed25519" && typeof key.x === "string" && !key.d
    && (!key.alg || key.alg === "EdDSA") && (!key.use || key.use === "sig")
    && (!key.key_ops || Array.isArray(key.key_ops) && key.key_ops.includes("verify")))
    .map(key => ({ kty: "OKP", crv: "Ed25519", kid: text(key.kid, 255), x: text(key.x, 255), alg: "EdDSA", use: "sig" }));
  if (keys.length !== 1) throw new SignInError("invalid_identity_keys");
  const { payload } = await jwtVerify(token, createLocalJWKSet({ keys }), {
    issuer: config.issuer, audience: config.clientId, algorithms: ["EdDSA"],
    requiredClaims: ["sub", "exp", "iat", "nonce"],
  });
  if (payload.nonce !== nonce || typeof payload.iat !== "number" || payload.iat > Date.now() / 1000 + 60
      || typeof payload.exp !== "number" || !Number.isFinite(payload.exp)
      || Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId) {
    throw new SignInError("invalid_identity_token");
  }
  const subject = text(payload.sub, 255);
  let profile: Record<string, unknown> = payload;
  if (typeof profile.email !== "string" || profile.email_verified === undefined) {
    if (tokens.tokenType?.toLowerCase() !== "bearer") throw new SignInError("invalid_identity_token");
    if (!endpoints.userinfo) throw new SignInError("identity_provider_protocol_mismatch");
    profile = await remoteJson(endpoints.userinfo, { authorization: `Bearer ${tokens.accessToken}` });
    if (profile.sub !== subject) throw new SignInError("identity_subject_mismatch");
  }
  if (profile.email_verified !== true) throw new SignInError("verified_email_required");
  const identity = { email: text(profile.email, 320).trim().toLowerCase(), subject, expiresAt: payload.exp * 1000 };
  if (!allowedIdentity(config, identity)) throw new SignInError("identity_not_allowed");
  return identity;
}

async function verifyAccessIdentity(config: Extract<Configuration, { mode: "oauth-jwt" }>,
  jwksUrl: string, tokens: OAuthTokens): Promise<VerifiedIdentity> {
  if (tokens.tokenType?.toLowerCase() !== "bearer") throw new SignInError("invalid_identity_token");
  const token = text(tokens.accessToken, 32768);
  const header = decodeProtectedHeader(token);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || header.kid.length > 255
      || header.crit || ["jwk", "jku", "x5u", "x5c"].some(field => field in header)) throw new SignInError("invalid_identity_token");
  const jwks = await remoteJson(jwksUrl);
  if (!Array.isArray(jwks.keys) || jwks.keys.length > 32) throw new SignInError("invalid_identity_keys");
  const matching = jwks.keys.map(record).filter(key => key.kid === header.kid);
  const [key] = matching;
  if (matching.length !== 1 || !key || key.kty !== "RSA" || typeof key.n !== "string" || typeof key.e !== "string"
      || ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(field => field in key)
      || key.alg !== undefined && key.alg !== "RS256" || key.use !== undefined && key.use !== "sig"
      || key.key_ops !== undefined && !(Array.isArray(key.key_ops) && key.key_ops.length === 1 && key.key_ops[0] === "verify")) {
    throw new SignInError("invalid_identity_keys");
  }
  const keys = [{ kty: "RSA", kid: text(key.kid, 255), n: text(key.n, 2048), e: text(key.e, 16), alg: "RS256", use: "sig" }];
  const { payload } = await jwtVerify(token, createLocalJWKSet({ keys }), {
    issuer: config.issuer, audience: config.resource, algorithms: ["RS256"],
    requiredClaims: ["sub", "exp", "iat", "jti", "client_id", "azp", "scope", "token_use", "email", "emailVerified", "banned"],
  });
  const now = Date.now() / 1000;
  const scope = typeof payload.scope === "string" ? payload.scope : "";
  if (payload.aud !== config.resource || payload.client_id !== config.clientId || payload.azp !== config.clientId
      || payload.token_use !== "access" || payload.banned !== false
      || typeof payload.iat !== "number" || !Number.isSafeInteger(payload.iat) || payload.iat < 0
      || payload.iat > now + 60 || payload.iat < now - 300
      || typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp) || payload.exp <= payload.iat
      || payload.exp > 8_640_000_000_000
      || !/^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(scope)
      || !config.scopes.every(required => scope.split(" ").includes(required))) throw new SignInError("invalid_identity_token");
  text(payload.jti, 255);
  if (payload.emailVerified !== true) throw new SignInError("verified_email_required");
  const identity = { email: text(payload.email, 320).trim().toLowerCase(), subject: text(payload.sub, 255), expiresAt: payload.exp * 1000 };
  if (!allowedIdentity(config, identity)) throw new SignInError("identity_not_allowed");
  return identity;
}
