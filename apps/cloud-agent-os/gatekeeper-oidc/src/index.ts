import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { advanceToOAuth, claimOAuth, putInitiation } from "@gadgets/gatekeeper-kit/connect-handshake";
import { generateNonce, OAUTH_NONCE_LIFETIME_MS } from "@gadgets/gatekeeper-kit/connect-nonce";
import { createPkce, OAuthResponseError } from "@gadgets/gatekeeper-kit/oauth-client";
import { connectHandoffPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import type { AccountDescription, ConnectHandoff, GatekeeperConnectCallback, GatekeeperConnectOptions,
  GatekeeperUser, GatekeeperVendor as Vendor, SupportedResource, VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import { allowedIdentity, configuration, discover, oauthClient, signInFailure, SignInError, verifyIdentity,
  type Env, type SignInCode, type SignInFailure, type SignInResult, type VerifiedIdentity } from "./oidc";

const PREFIX = "/gatekeeper/oidc";
const HEX = /^[a-f0-9]{64}$/;
type Attempt = { codeVerifier: string; nonce: string };

function failureResponse(failure: SignInFailure): Response {
  return new Response(`Sign-in failed (${failure.code}). Restart sign-in from the application.`, {
    status: failure.status, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "referrer-policy": "no-referrer" },
  });
}

export class GatekeeperVendor extends WorkerEntrypoint<Env> implements Vendor {
  async describe(): Promise<VendorDescription> {
    const config = configuration(this.env);
    return { displayName: config.displayName, url: config.issuer, providesAuth: true };
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  async getTypeScriptTypes(): Promise<string> { return ""; }
  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>, options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    if (options?.scopes !== "auth" || options.resourceUrlPatterns?.length) throw new SignInError("sign_in_only");
    const config = configuration(this.env);
    const id = this.ctx.exports.OidcLogin.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.OidcLogin.get(id).initialize(callback, nonce);
    return { url: `${config.origin}${PREFIX}/${id.toString()}/${nonce}` };
  }
}

export class OidcLogin extends DurableObject<Env> {
  async initialize(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    if (!HEX.test(nonce) || this.ctx.storage.kv.get("initialized")) throw new SignInError("invalid_sign_in_attempt");
    this.ctx.storage.kv.put("initialized", true);
    this.ctx.storage.kv.put("callback", callback);
    putInitiation(this.ctx.storage.kv, nonce, Date.now());
    await this.ctx.storage.setAlarm(Date.now() + OAUTH_NONCE_LIFETIME_MS);
  }

  async begin(nonce: string): Promise<SignInResult<string>> {
    let stage: SignInCode = "sign_in_failed";
    try {
      const config = configuration(this.env);
      const pkce = await createPkce();
      const idNonce = generateNonce();
      const oauthNonce = advanceToOAuth(this.ctx.storage.kv, nonce, Date.now(),
        { codeVerifier: pkce.codeVerifier, nonce: idNonce });
      if (!oauthNonce) throw new SignInError("sign_in_attempt_expired");
      await this.ctx.storage.setAlarm(Date.now() + OAUTH_NONCE_LIFETIME_MS);
      stage = "identity_provider_unavailable";
      const endpoints = await discover(config);
      const authorize = oauthClient(config, endpoints).authorizationUrl({ redirectUri: config.callback,
        state: `${this.ctx.id.toString()}:${oauthNonce}`, scopes: ["openid", "profile", "email"],
        codeChallenge: pkce.codeChallenge, params: { nonce: idNonce } });
      if (!config.login) return { ok: true, value: authorize.href };
      if (this.env.OIDC_LOGIN_SITE) config.login.searchParams.set("sitename", this.env.OIDC_LOGIN_SITE);
      config.login.searchParams.set("callbackURL", authorize.href);
      return { ok: true, value: config.login.href };
    } catch (error) { return signInFailure(error, stage); }
  }

  async complete(code: string | null, state: string, issuer: string | null, denied: boolean): Promise<SignInResult<ConnectHandoff>> {
    let stage: SignInCode = "sign_in_failed";
    let result: SignInResult<ConnectHandoff>;
    let claimed = false;
    try {
      const attempt = claimOAuth<Attempt>(this.ctx.storage.kv, state, Date.now());
      if (!attempt) throw new SignInError("sign_in_attempt_expired");
      claimed = true;
      const config = configuration(this.env);
      if (denied || !code || code.length > 8192 || issuer !== null && issuer !== config.issuer) throw new SignInError("invalid_sign_in_callback");
      const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      if (!callback) throw new SignInError("sign_in_attempt_expired");
      stage = "identity_provider_unavailable";
      const endpoints = await discover(config);
      stage = "token_exchange_failed";
      const tokens = await oauthClient(config, endpoints).exchangeCode({ code, redirectUri: config.callback, codeVerifier: attempt.codeVerifier });
      stage = "invalid_identity_token";
      const identity = await verifyIdentity(config, endpoints, tokens, attempt.nonce);
      this.ctx.storage.kv.put("identity", identity);
      const user = this.ctx.exports.GatekeeperUserImpl({ props: { loginId: this.ctx.id.toString() } });
      stage = "sign_in_handoff_failed";
      const handoff = await callback.complete(user, new Date(identity.expiresAt));
      if (handoff.targetOrigin !== config.origin) throw new SignInError("invalid_sign_in_handoff");
      result = { ok: true, value: handoff };
    } catch (error) {
      if (stage === "token_exchange_failed" && error instanceof OAuthResponseError) {
        if (error.oauthError === "invalid_client") stage = "token_client_rejected";
        else if (error.oauthError === "invalid_grant") stage = "token_grant_rejected";
      }
      result = signInFailure(error, stage);
    }
    if (claimed) {
      try { await this.clear(); }
      catch { return signInFailure(null, "sign_in_cleanup_failed"); }
    }
    return result;
  }

  async email(): Promise<string | null> {
    const identity = this.ctx.storage.kv.get<VerifiedIdentity>("identity");
    return identity && allowedIdentity(configuration(this.env), identity) ? identity.email : null;
  }
  async clear(): Promise<void> { await this.ctx.storage.deleteAll(); await this.ctx.storage.deleteAlarm(); }
  async alarm(): Promise<void> { await this.clear(); }
}

export class GatekeeperUserImpl extends WorkerEntrypoint<Env, { loginId: string }> implements GatekeeperUser {
  private account() { return this.ctx.exports.OidcLogin.get(this.ctx.exports.OidcLogin.idFromString(this.ctx.props.loginId)); }
  async getAuthenticatedEmail(): Promise<string | null> {
    try { return await this.account().email(); } catch { return null; }
  }
  async describe(): Promise<AccountDescription> {
    return { displayName: "Temporary sign-in", avatar: { url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" } };
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  async getGatekeeperClassFor(): Promise<never> { throw new SignInError("sign_in_only"); }
  async startResourceConfigurator(): Promise<never> { throw new SignInError("sign_in_only"); }
  async getVerifier(): Promise<never> { throw new SignInError("sign_in_only"); }
  async reconnect(): Promise<never> { throw new SignInError("restart_sign_in"); }
  async commitReconnect(): Promise<never> { throw new SignInError("sign_in_only"); }
  async ensureResources(patterns: string[]): Promise<{ url?: string }> {
    if (patterns.length) throw new SignInError("sign_in_only");
    return {};
  }
  async revoke(): Promise<void> { await this.account().clear(); }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const config = configuration(env);
      const url = new URL(request.url);
      if (request.method !== "GET" || url.origin !== config.origin || !url.pathname.startsWith(`${PREFIX}/`)) return new Response("Not found", { status: 404 });
      const path = url.pathname.slice(PREFIX.length + 1).split("/");
      const [loginId = "", initiationNonce = ""] = path;
      if (path.length === 2 && HEX.test(loginId) && HEX.test(initiationNonce)) {
        const attempt = ctx.exports.OidcLogin.get(ctx.exports.OidcLogin.idFromString(loginId));
        const result = await attempt.begin(initiationNonce);
        if (!result.ok) return failureResponse(result.error);
        return new Response(null, { status: 302, headers: { location: result.value,
          "cache-control": "no-store", "referrer-policy": "no-referrer" } });
      }
      if (path.length !== 1 || path[0] !== "oauth") return new Response("Not found", { status: 404 });
      for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1) throw new SignInError("invalid_sign_in_callback");
      const state = url.searchParams.get("state")?.split(":");
      const [id = "", oauthNonce = ""] = state ?? [];
      if (!state || state.length !== 2 || !HEX.test(id) || !HEX.test(oauthNonce)) throw new SignInError("invalid_sign_in_callback");
      const attempt = ctx.exports.OidcLogin.get(ctx.exports.OidcLogin.idFromString(id));
      const result = await attempt.complete(url.searchParams.get("code"), oauthNonce, url.searchParams.get("iss"), url.searchParams.has("error"));
      if (!result.ok) return failureResponse(result.error);
      return htmlResponse(connectHandoffPageHtml(result.value));
    } catch (error) {
      return failureResponse(signInFailure(error, "sign_in_failed").error);
    }
  },
};
