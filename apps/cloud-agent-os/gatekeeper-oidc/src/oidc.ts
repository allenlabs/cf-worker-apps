import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { OAuthClient, type OAuthTokens } from "@gadgets/gatekeeper-kit/oauth-client";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";

export interface Env {
  PUBLIC_BASE_URL: string;
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  OIDC_CLIENT_SECRET: string;
  OIDC_DISPLAY_NAME?: string;
  OIDC_ALLOWED_IDENTITIES: string;
  OIDC_LOGIN_URL?: string;
  OIDC_LOGIN_SITE?: string;
}

export class SignInError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
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
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new SignInError("invalid_sign_in_configuration", 503);
  return url;
}

export function configuration(env: Env) {
  try {
    const issuer = httpsUrl(text(env.OIDC_ISSUER));
    if (issuer.search || issuer.href.replace(/\/$/, "") !== env.OIDC_ISSUER) throw Error();
    const origin = httpsUrl(text(env.PUBLIC_BASE_URL));
    if (origin.origin !== env.PUBLIC_BASE_URL) throw Error();
    const clientId = text(env.OIDC_CLIENT_ID, 255);
    const clientSecret = text(env.OIDC_CLIENT_SECRET, 4096);
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
    return { issuer: env.OIDC_ISSUER, origin: origin.origin, clientId, clientSecret, allowed, login,
      displayName: env.OIDC_DISPLAY_NAME ? text(env.OIDC_DISPLAY_NAME, 128) : "Organization SSO",
      callback: `${origin.origin}/gatekeeper/oidc/oauth` };
  } catch { throw new SignInError("invalid_sign_in_configuration", 503); }
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
  if (!response.ok) throw new SignInError("identity_provider_unavailable", 502);
  return record(JSON.parse(await readTextCapped(response, 65536)));
}

export async function discover(config: Configuration) {
  const document = await remoteJson(`${config.issuer}/.well-known/openid-configuration`);
  if (document.issuer !== config.issuer || !Array.isArray(document.id_token_signing_alg_values_supported)
      || !document.id_token_signing_alg_values_supported.includes("EdDSA")
      || !Array.isArray(document.code_challenge_methods_supported) || !document.code_challenge_methods_supported.includes("S256")) {
    throw new SignInError("identity_provider_protocol_mismatch", 502);
  }
  function endpoint(key: string) {
    const value = httpsUrl(text(document[key]));
    if (value.origin !== new URL(config.issuer).origin) throw new SignInError("identity_provider_endpoint_mismatch", 502);
    return value.href;
  }
  return { authorization: endpoint("authorization_endpoint"), token: endpoint("token_endpoint"),
    jwks: endpoint("jwks_uri"), userinfo: endpoint("userinfo_endpoint") };
}

export function oauthClient(config: Configuration, endpoints: Awaited<ReturnType<typeof discover>>) {
  return new OAuthClient({ label: "Identity provider", client: { method: "basic", encoding: "form",
    id: config.clientId, secret: config.clientSecret }, tokenEndpoint: endpoints.token,
    authorizationEndpoint: endpoints.authorization, timeoutMs: 15000, maxResponseBytes: 65536 });
}

export async function verifyIdentity(config: Configuration, endpoints: Awaited<ReturnType<typeof discover>>,
  tokens: OAuthTokens, nonce: string): Promise<VerifiedIdentity> {
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
    profile = await remoteJson(endpoints.userinfo, { authorization: `Bearer ${tokens.accessToken}` });
    if (profile.sub !== subject) throw new SignInError("identity_subject_mismatch");
  }
  if (profile.email_verified !== true) throw new SignInError("verified_email_required", 403);
  const identity = { email: text(profile.email, 320).trim().toLowerCase(), subject, expiresAt: payload.exp * 1000 };
  if (!allowedIdentity(config, identity)) throw new SignInError("identity_not_allowed", 403);
  return identity;
}
