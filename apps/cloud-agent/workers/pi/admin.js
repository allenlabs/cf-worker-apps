import { DurableObject } from "cloudflare:workers";
import { parse as parseYaml } from "yaml";
import { GitHubBroker, GitHubError, validateCommit, githubSources, githubRegister, githubAuthorize, githubContext } from "./github.js";
import { adminPage } from "./admin-view.js";
import { pinTenant, tenantId, objectKey, storedHistory, listConversations } from "./conversation-store.js";
import { commandAllowed } from "./source-history.js";

const encoder = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const unb64 = text => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const hash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))].map(n => n.toString(16).padStart(2, "0")).join("");
const accountId = value => value === "owner" || typeof value === "string" && /^account-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const nativeId = value => typeof value === "string" && /^[A-Za-z0-9_:-]{1,255}$/.test(value);
const cookie = (request, name) => request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
const cookieHeader = (name, value, age) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const SESSION = "__Host-cloud_agent_session";
const ATTEMPT = "__Host-cloud_agent_login";
const productName = env => env.PRODUCT_NAME || "Cloud Agent";
class AdminError extends Error { constructor(code, status = 400) { super(code); this.name = "AdminError"; this.status = status; } }
const requireValue = (ok, code, status = 400) => { if (!ok) throw new AdminError(code, status); };
export function channelScope(env) {
  const scope = { channelId: env.ALLOWED_CHANNEL_ID, groupId: env.ALLOWED_CHAT_ID, appId: env.CHANNEL_APP_ID };
  requireValue(Object.values(scope).every(nativeId), "channel_configuration_invalid", 503);
  return scope;
}
const object = value => !!value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => requireValue(object(value) && Object.keys(value).every(key => keys.includes(key)), "invalid_fields");
function observedThread(rows, root, threadKey) {
  const matches = rows.filter(row => row.rootMessageId === root && (threadKey === undefined || row.threadKey === threadKey));
  requireValue(matches.length === 1, matches.length ? "thread_root_ambiguous" : "thread_not_observed", matches.length ? 409 : 404);
  return matches[0];
}
const string = (value, limit, code = "invalid_text") => { requireValue(typeof value === "string" && value.trim().length > 0 && encoder.encode(value).length <= limit && !value.includes("\0"), code); return value.trim(); };
const response = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...headers } });
const redirect = (path, headers = {}) => new Response(null, { status: 303, headers: { location: path, "cache-control": "no-store", "referrer-policy": "no-referrer", ...headers } });

async function boundedText(message, limit, code, status) {
  requireValue(Number(message.headers.get("content-length") || 0) <= limit, code, status);
  const reader = message.body?.getReader(); if (!reader) return "";
  const decoder = new TextDecoder(); let text = "", bytes = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; requireValue(bytes <= limit, code, status); text += decoder.decode(value, { stream: true }); }
    return text + decoder.decode();
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

async function remoteJson(url, options = {}) {
  let r;
  try { r = await fetch(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(15000) }); }
  catch { throw new AdminError("sso_network_error", 502); }
  requireValue(r.ok, "sso_request_failed", 502);
  const text = await boundedText(r, 131072, "sso_response_invalid", 502);
  try { return JSON.parse(text); } catch { throw new AdminError("sso_response_invalid", 502); }
}

async function discovery(env) {
  const issuer = new URL(env.SSO_ISSUER);
  requireValue(issuer.protocol === "https:" && !issuer.username && !issuer.password && !issuer.search && !issuer.hash, "sso_configuration_invalid", 503);
  const doc = await remoteJson(`${issuer.href.replace(/\/$/, "")}/.well-known/openid-configuration`);
  requireValue(doc.issuer === env.SSO_ISSUER, "sso_issuer_mismatch", 503);
  for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri", "userinfo_endpoint"]) {
    let endpoint;
    try { endpoint = new URL(doc[field]); } catch { throw new AdminError("sso_configuration_invalid", 503); }
    requireValue(endpoint.origin === issuer.origin && endpoint.protocol === "https:" && !endpoint.username && !endpoint.password && !endpoint.hash, "sso_endpoint_invalid", 503);
  }
  requireValue(doc.id_token_signing_alg_values_supported?.includes("EdDSA") && doc.code_challenge_methods_supported?.includes("S256"), "sso_protocol_unsupported", 503);
  return doc;
}

async function verifiedPrincipal(env, doc, token, nonce) {
  requireValue(typeof token.id_token === "string" && token.id_token.length <= 32768, "sso_id_token_invalid");
  const parts = token.id_token.split(".");
  requireValue(parts.length === 3, "sso_id_token_invalid");
  let header, claims;
  try { header = JSON.parse(new TextDecoder().decode(unb64(parts[0]))); claims = JSON.parse(new TextDecoder().decode(unb64(parts[1]))); }
  catch { throw new AdminError("sso_id_token_invalid"); }
  requireValue(header.alg === "EdDSA" && typeof header.kid === "string" && header.kid.length <= 255 && !header.crit, "sso_id_token_algorithm_invalid");
  const jwks = await remoteJson(doc.jwks_uri);
  const keys = jwks.keys?.filter(key => key.kid === header.kid && key.kty === "OKP" && key.crv === "Ed25519" && (!key.use || key.use === "sig") && (!key.alg || key.alg === "EdDSA") && (!key.key_ops || key.key_ops.includes("verify")));
  requireValue(keys?.length === 1, "sso_id_token_key_invalid");
  let verified = false;
  try {
    const key = await crypto.subtle.importKey("jwk", keys[0], { name: "Ed25519" }, false, ["verify"]);
    verified = await crypto.subtle.verify("Ed25519", key, unb64(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`));
  } catch { throw new AdminError("sso_id_token_signature_invalid"); }
  requireValue(verified, "sso_id_token_signature_invalid");
  const audience = claims.aud === env.SSO_CLIENT_ID || Array.isArray(claims.aud) && claims.aud.includes(env.SSO_CLIENT_ID);
  requireValue(audience && (!Array.isArray(claims.aud) || claims.aud.length <= 1 || claims.azp === env.SSO_CLIENT_ID), "sso_id_token_audience_mismatch");
  const now = Date.now() / 1000;
  requireValue(claims.iss === env.SSO_ISSUER && typeof claims.sub === "string" && claims.sub.length > 0 && claims.sub.length <= 255, "sso_id_token_identity_invalid");
  requireValue(claims.nonce === nonce, "sso_id_token_nonce_mismatch");
  requireValue(Number.isFinite(claims.exp) && claims.exp > now && Number.isFinite(claims.iat) && claims.iat <= now + 60 && (claims.nbf === undefined || Number.isFinite(claims.nbf) && claims.nbf <= now + 60), "sso_id_token_expired");
  let identity = claims;
  if (typeof claims.email !== "string" || claims.email_verified === undefined) {
    requireValue(typeof token.access_token === "string" && token.access_token.length <= 32768 && token.token_type?.toLowerCase() === "bearer", "sso_userinfo_token_invalid");
    identity = await remoteJson(doc.userinfo_endpoint, { headers: { authorization: `Bearer ${token.access_token}` } });
    requireValue(identity.sub === claims.sub, "sso_userinfo_subject_mismatch");
  }
  requireValue(identity.email_verified === true && typeof identity.email === "string", "sso_email_unverified", 403);
  const email = identity.email.trim().toLowerCase();
  let allowed, pins;
  try { allowed = JSON.parse(env.SUPER_ADMIN_EMAILS || "[]"); pins = JSON.parse(env.SUPER_ADMIN_SUBJECTS || "{}"); }
  catch { throw new AdminError("sso_policy_invalid", 503); }
  requireValue(Array.isArray(allowed) && allowed.length <= 20 && allowed.every(x => typeof x === "string") && object(pins), "sso_policy_invalid", 503);
  requireValue(allowed.includes(email) && (!Object.keys(pins).length || pins[email] === claims.sub), "super_admin_required", 403);
  return { issuer: claims.iss, subject: claims.sub, email, role: "super_admin", name: typeof identity.name === "string" ? identity.name.slice(0, 128) : email, idTokenExpiresAt: claims.exp * 1000 };
}

function validateSkill(input) {
  exactKeys(input, ["rawContent", "resources"]);
  const rawContent = string(input.rawContent, 65536, "skill_size_invalid");
  const match = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  requireValue(match, "skill_frontmatter_invalid");
  let data;
  try { data = parseYaml(match[1]); } catch { throw new AdminError("skill_frontmatter_invalid"); }
  requireValue(object(data), "skill_frontmatter_invalid");
  const frontmatter = { data, body: match[2] };
  const optionalString = value => typeof value === "string" && value.trim() ? value.trim() : undefined;
  const parsed = { name: optionalString(data.name), description: optionalString(data.description), body: match[2], compatibility: optionalString(data.compatibility), license: optionalString(data.license), allowedTools: optionalString(data["allowed-tools"]), metadata: data.metadata };
  requireValue(parsed.name && parsed.description && (data.metadata === undefined || object(data.metadata)), "skill_metadata_invalid");
  requireValue(parsed && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parsed.name) && parsed.name.length <= 64 && parsed.description.length <= 1024 && parsed.body.trim().length > 0, "skill_metadata_invalid");
  requireValue(Object.keys(frontmatter.data).every(key => ["name", "description", "license", "compatibility", "allowed-tools", "metadata", "disable-model-invocation"].includes(key)), "skill_unknown_metadata");
  const metadata = { ...(parsed.metadata || {}) };
  if (frontmatter.data["disable-model-invocation"] !== undefined) {
    requireValue(typeof frontmatter.data["disable-model-invocation"] === "boolean", "skill_metadata_invalid");
    metadata["disable-model-invocation"] = frontmatter.data["disable-model-invocation"];
  }
  requireValue(Object.keys(metadata).length <= 20 && Object.entries(metadata).every(([key, value]) => key.length <= 128 && ["string", "boolean", "number"].includes(typeof value) && String(value).length <= 1024), "skill_metadata_invalid");
  const resources = input.resources || [];
  requireValue(Array.isArray(resources) && resources.length <= 20, "skill_resources_invalid");
  const paths = new Set(); let total = encoder.encode(rawContent).length;
  for (const resource of resources) {
    exactKeys(resource, ["path", "kind", "content", "encoding", "mimeType"]);
    requireValue(typeof resource.path === "string" && resource.path.length <= 255 && /^(?:references|assets)\/[A-Za-z0-9_./-]+$/.test(resource.path) && !resource.path.split("/").some(part => !part || part === "." || part === "..") && !paths.has(resource.path), "skill_resource_path_invalid");
    requireValue(["reference", "asset", "file"].includes(resource.kind) && (!resource.encoding || resource.encoding === "text") && typeof resource.content === "string" && !resource.content.includes("\0"), "skill_resource_invalid");
    requireValue(!/\.(?:js|mjs|cjs|ts|sh|bash|py|wasm|exe|so|dll)$/i.test(resource.path) && (!resource.mimeType || /^text\/[a-z0-9.+-]+$/i.test(resource.mimeType)), "skill_scripts_unsupported");
    const size = encoder.encode(resource.content).length;
    requireValue(size <= 65536, "skill_resource_size_invalid"); total += size; paths.add(resource.path);
  }
  requireValue(total <= 262144, "skill_bundle_size_invalid");
  return { ...parsed, metadata, rawContent, resources: resources.map(resource => ({ ...resource, encoding: "text", size: encoder.encode(resource.content).length })) };
}

export class ManagementCredentials extends DurableObject {
  constructor(ctx, env) { super(ctx, env); ctx.blockConcurrencyWhile(() => pinTenant(ctx, env)); }
  githubBroker() { return this.githubClient ??= new GitHubBroker(this.env); }
  async githubAuthorize(context) { return githubAuthorize(this, context); }
  async githubRemote(context, action, input) {
    const source = await this.githubAuthorize(context), broker = this.githubBroker();
    if (action === "files") { exactKeys(input, ["baseOid"]); return broker.files(source, input.baseOid); }
    if (action === "read" || action === "readMissing") { exactKeys(input, ["baseOid", "path"]); return broker.read(source, input.baseOid, input.path, action === "readMissing"); }
    if (action === "prepare") { exactKeys(input, []); return broker.prepare(source); }
    if (action === "commit") {
      exactKeys(input, ["payload"]);
      const payload = input.payload; validateCommit(source, payload);
      return broker.commit(source, payload);
    }
    throw new GitHubError("github_action_invalid");
  }
  async githubRead(action, input, sessionToken) {
    const session = await this.adminSession(sessionToken); requireValue(session, "sso_login_required", 401);
    if (action === "status") { exactKeys(input, []); return { ...await this.githubBroker().status(), sources: await githubSources(this, session.principal) }; }
    if (action === "repositories") { exactKeys(input, ["page"]); return this.githubBroker().repositories(input.page); }
    exactKeys(input, action === "file" ? ["sourceId", "path"] : ["sourceId"]);
    const pinned = await githubContext(this, session.principal, input.sourceId), author = this.env.GitHubAuthoring.getByName(pinned.objectName);
    await author.initialize(pinned.context, pinned.baseOid);
    if (action === "draft") return author.state(pinned.context);
    if (action === "files") return author.files(pinned.context);
    if (action === "file") return author.read({ path: input.path }, pinned.context);
    throw new GitHubError("github_action_invalid");
  }
  async githubMutation(action, input, sessionToken, csrf) {
    const session = await this.adminSession(sessionToken); requireValue(session && session.csrf === csrf, "admin_csrf_invalid", 403);
    if (action === "source") return githubRegister(this, session.principal, input);
    if (action === "disable") {
      exactKeys(input, ["sourceId"]); const pinned = await githubContext(this, session.principal, input.sourceId), rows = await this.ctx.storage.get("githubSources") || [];
      const source = rows.find(row => row.id === pinned.context.sourceId); source.enabled = false; source.generation++;
      await this.ctx.storage.put("githubSources", rows); await this.audit(session.principal, "github.source.disable", source.id); return { disabled: true };
    }
    const allowed = { stage: ["sourceId", "operationId", "path", "content", "expectedVersion"], preview: ["sourceId", "message"], publish: ["sourceId", "operationId", "planHash"], ask: ["sourceId", "operationId", "prompt"] };
    requireValue(allowed[action], "github_action_invalid"); exactKeys(input, allowed[action]);
    const pinned = await githubContext(this, session.principal, input.sourceId), author = this.env.GitHubAuthoring.getByName(pinned.objectName); await author.initialize(pinned.context, pinned.baseOid);
    let result;
    if (action === "stage") result = await author.write({ path: input.path, content: input.content, expectedVersion: input.expectedVersion }, input.operationId, pinned.context);
    if (action === "preview") result = await author.preview({ message: input.message }, pinned.context);
    if (action === "publish") result = await author.publish({ planHash: input.planHash }, input.operationId, pinned.context);
    if (action === "ask") result = await author.ask({ prompt: input.prompt, operationId: input.operationId }, pinned.context);
    await this.audit(session.principal, `github.${action}`, input.sourceId, result.state === "unknown" ? "unknown" : "ok"); return result;
  }
  async audit(principal, action, target, outcome = "ok") {
    await this.ctx.storage.transaction(async transaction => {
      const rows = await transaction.get("adminAudit") || [];
      rows.push({ at: new Date().toISOString(), subject: principal.subject, email: principal.email, action, target, outcome });
      await transaction.put("adminAudit", rows.slice(-500));
    });
  }
  async startSso() {
    const doc = await discovery(this.env);
    requireValue(typeof this.env.SSO_CLIENT_ID === "string" && this.env.SSO_CLIENT_ID.length > 0 && typeof this.env.SSO_CLIENT_SECRET === "string" && this.env.SSO_CLIENT_SECRET.length > 0, "sso_client_not_configured", 503);
    const attempt = { state: random(), nonce: random(), verifier: random(), browser: random(), expiresAt: Date.now() + 600000 };
    const prior = await this.ctx.storage.list({ prefix: "ssoAttempt:" });
    let liveAttempts = 0;
    for (const [key, stored] of prior) { if (stored.expiresAt <= Date.now()) await this.ctx.storage.delete(key); else liveAttempts++; }
    requireValue(liveAttempts < 100, "sso_busy", 429);
    await this.ctx.storage.put(`ssoAttempt:${await hash(attempt.state)}`, { browserHash: await hash(attempt.browser), expiresAt: attempt.expiresAt, sealed: await this.seal({ nonce: attempt.nonce, verifier: attempt.verifier }) });
    const authorize = new URL(doc.authorization_endpoint);
    authorize.search = new URLSearchParams({ client_id: this.env.SSO_CLIENT_ID, redirect_uri: `${this.env.PUBLIC_ORIGIN}/auth/callback`, response_type: "code", scope: "openid profile email", state: attempt.state, nonce: attempt.nonce, code_challenge: b64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(attempt.verifier)))), code_challenge_method: "S256" }).toString();
    let target = authorize.href;
    if (this.env.SSO_LOGIN_URL) {
      const login = new URL(this.env.SSO_LOGIN_URL);
      requireValue(login.protocol === "https:" && !login.username && !login.password && !login.hash, "sso_configuration_invalid", 503);
      if (this.env.SSO_SITE) login.searchParams.set("sitename", this.env.SSO_SITE);
      login.searchParams.set("callbackURL", authorize.href);
      target = login.href;
    }
    return { location: target, browser: attempt.browser };
  }
  async completeSso(query, browser) {
    requireValue(typeof query.state === "string" && /^[A-Za-z0-9_-]{43}$/.test(query.state) && typeof browser === "string" && /^[A-Za-z0-9_-]{43}$/.test(browser), "sso_state_invalid");
    const key = `ssoAttempt:${await hash(query.state)}`;
    const stored = await this.ctx.storage.transaction(async transaction => {
      const record = await transaction.get(key);
      requireValue(record && record.expiresAt > Date.now() && record.browserHash === await hash(browser), "sso_attempt_invalid");
      await transaction.delete(key); return record;
    });
    requireValue(!query.error && typeof query.code === "string" && query.code.length > 0 && query.code.length <= 8192 && (!query.iss || query.iss === this.env.SSO_ISSUER), "sso_callback_invalid");
    const attempt = await this.open(stored.sealed);
    const doc = await discovery(this.env);
    const token = await remoteJson(doc.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa(`${encodeURIComponent(this.env.SSO_CLIENT_ID)}:${encodeURIComponent(this.env.SSO_CLIENT_SECRET)}`)}` }, body: new URLSearchParams({ grant_type: "authorization_code", code: query.code, redirect_uri: `${this.env.PUBLIC_ORIGIN}/auth/callback`, code_verifier: attempt.verifier }) });
    const principal = await verifiedPrincipal(this.env, doc, token, attempt.nonce);
    const session = random(), csrf = random();
    const expiresAt = Math.min(Date.now() + 28800000, principal.idTokenExpiresAt);
    await this.ctx.storage.put(`adminSession:${await hash(session)}`, { expiresAt, sealed: await this.seal({ principal, csrf }) });
    await this.audit(principal, "sso.login", "management");
    return { session, maxAge: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)) };
  }
  async adminSession(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
    const key = `adminSession:${await hash(value)}`; const record = await this.ctx.storage.get(key);
    if (!record || record.expiresAt <= Date.now()) { if (record) await this.ctx.storage.delete(key); return null; }
    const session = await this.open(record.sealed);
    let allowed, pins;
    try { allowed = JSON.parse(this.env.SUPER_ADMIN_EMAILS || "[]"); pins = JSON.parse(this.env.SUPER_ADMIN_SUBJECTS || "{}"); } catch { return null; }
    return session.principal.role === "super_admin" && session.principal.issuer === this.env.SSO_ISSUER && allowed.includes(session.principal.email) && (!Object.keys(pins).length || pins[session.principal.email] === session.principal.subject) ? { ...session, expiresAt: record.expiresAt } : null;
  }
  async accountInventory() { return await this.ctx.storage.get("adminAccounts") || [{ id: "owner", label: "owner", createdAt: null }]; }
  async accounts() {
    const inventory = await this.accountInventory();
    return Promise.all(inventory.map(async row => {
      try {
        const status = await (row.id === "owner" ? this : this.env.Credentials.getByName(row.id)).status();
        return { ...row, ...status, label: status.identity?.source === "verified_id_token" && status.identity.accountId || row.id };
      }
      catch { return { ...row, label: row.id, connected: false, error: "account_status_unavailable" }; }
    }));
  }
  async controlSnapshot() {
    const version = await this.ctx.storage.get("skillManifestVersion") || "empty";
    return { defaultAccountId: (await this.accountSelection()).defaultAccountId, manifest: await this.skillManifest(version) };
  }
  async accountSelection() { return await this.ctx.storage.get("accountSelection") || { mode: "fixed", defaultAccountId: await this.ctx.storage.get("defaultAccountId") || "owner", poolAccountIds: [] }; }
  async skillManifest(version) {
    if (version === "empty") return { version, skills: [] };
    const value = await this.ctx.storage.get(`skillManifest:${version}`);
    requireValue(value, "skill_manifest_missing", 404); return value;
  }
  async skillCatalog() {
    const rows = await this.ctx.storage.get("skillCatalog") || [];
    return rows.map(({ name, description, revision, enabled, publishedAt, publishedBy, revisions }) => ({ name, description, revision, enabled, publishedAt, publishedBy, revisions }));
  }
  async publishedSkill(name, revision) {
    const row = (await this.ctx.storage.get("skillCatalog") || []).find(skill => skill.name === name);
    if (!row || !row.enabled || revision && !row.revisions.includes(revision)) return null;
    return await this.ctx.storage.get(`skillRevision:${name}:${revision || row.revision}`) || null;
  }
  async skillSource(name, revision) {
    const row = (await this.ctx.storage.get("skillCatalog") || []).find(skill => skill.name === name);
    if (!row || revision && !row.revisions.includes(revision)) return null;
    return await this.ctx.storage.get(`skillRevision:${name}:${revision || row.revision}`) || null;
  }
  async registerThread(identity) {
    const scope = channelScope(this.env);
    requireValue(object(identity) && identity.channelId === scope.channelId && nativeId(identity.rootMessageId) && /^channel-[0-9a-f]{64}$/.test(identity.threadKey), "thread_identity_invalid");
    if (identity.admission === "command") commandAllowed(identity, this.env);
    else requireValue(identity.groupId === scope.groupId, "thread_identity_invalid");
    const expected = `channel-${await hash(JSON.stringify([identity.channelId, identity.groupId, identity.rootMessageId]))}`;
    requireValue(identity.threadKey === expected && (identity.accountId === undefined || accountId(identity.accountId)), "thread_identity_invalid");
    const existing = (await this.ctx.storage.get("threadIndex") || []).find(row => row.threadKey === identity.threadKey);
    const selection = !existing && identity.accountId === undefined ? await this.accountSelection() : null;
    // ponytail: account health across DOs is a snapshot; later disconnects fail on the pinned account instead of switching it.
    const candidates = selection ? (await this.accounts()).filter(row => row.connected && row.directUsageGranted).map(row => row.id) : [];
    return this.ctx.storage.transaction(async transaction => {
      const rows = await transaction.get("threadIndex") || [];
      const found = rows.find(row => row.threadKey === identity.threadKey);
      if (found) { requireValue(identity.accountId === undefined || found.accountId === identity.accountId, "thread_account_immutable"); found.lastObservedAt = new Date().toISOString(); }
      else {
        requireValue(rows.length < 2000, "thread_index_full", 409); let selected = identity.accountId;
        if (selection) {
          const current = await transaction.get("accountSelection") || { mode: "fixed", defaultAccountId: await transaction.get("defaultAccountId") || "owner", poolAccountIds: [] };
          requireValue(JSON.stringify(current) === JSON.stringify(selection), "account_selection_changed", 409);
          if (selection.mode === "fixed") selected = selection.defaultAccountId;
          else {
            const cursor = await transaction.get("accountCursor") || 0, pool = selection.poolAccountIds;
            const offset = pool.findIndex((_, index) => candidates.includes(pool[(cursor + index) % pool.length]));
            requireValue(offset >= 0, "account_pool_unavailable", 409); selected = pool[(cursor + offset) % pool.length];
            await transaction.put("accountCursor", (cursor + offset + 1) % pool.length);
          }
          requireValue(candidates.includes(selected), "account_not_connected", 409);
        }
        const at = new Date().toISOString(); rows.push({ channelId: identity.channelId, groupId: identity.groupId, rootMessageId: identity.rootMessageId, threadKey: identity.threadKey, accountId: selected, firstObservedAt: at, lastObservedAt: at });
      }
      await transaction.put("threadIndex", rows);
      return rows.find(row => row.threadKey === identity.threadKey);
    });
  }
  async threads() { return (await this.ctx.storage.get("threadIndex") || []).slice().reverse(); }
  async adminAudit() { return (await this.ctx.storage.get("adminAudit") || []).slice().reverse(); }
  async adminMutation(action, input, sessionToken, csrf) {
    // ponytail: human admin mutations share one queue, including OAuth calls; split by account/catalog if concurrent operator throughput grows.
    const prior = this.managementTail || Promise.resolve();
    const pending = prior.catch(() => undefined).then(() => this.performAdminMutation(action, input, sessionToken, csrf));
    this.managementTail = pending;
    try { return await pending; }
    catch (error) { if (error instanceof AdminError || error instanceof GitHubError) return { adminError: error.message, status: error.status }; throw error; }
    finally { if (this.managementTail === pending) this.managementTail = undefined; }
  }
  async performAdminMutation(action, input, sessionToken, csrf) {
    if (action.startsWith("github.")) return this.githubMutation(action.slice(7), input, sessionToken, csrf);
    const session = await this.adminSession(sessionToken);
    requireValue(session && typeof csrf === "string" && csrf === session.csrf, "admin_csrf_invalid", 403);
    const actor = session.principal;
    if (action === "logout") {
      exactKeys(input, []); await this.ctx.storage.delete(`adminSession:${await hash(sessionToken)}`); await this.audit(actor, "sso.logout", "management"); return { loggedOut: true };
    }
    if (action === "account.create") {
      exactKeys(input, ["expectedEmail"]);
      const email = string(input.expectedEmail, 254).toLowerCase();
      requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), "account_email_invalid");
      const rows = await this.accountInventory(); requireValue(rows.length < 20, "account_limit", 409);
      const id = `account-${crypto.randomUUID()}`;
      await this.env.Credentials.getByName(id).configureAccount({ expectedEmailHash: await hash(email), label: id });
      rows.push({ id, label: id, expectedEmail: email, createdAt: new Date().toISOString(), createdBy: actor.subject });
      await this.ctx.storage.put("adminAccounts", rows); await this.audit(actor, action, id); return { id };
    }
    if (action === "account.selection") {
      exactKeys(input, ["mode", "defaultAccountId", "poolAccountIds"]);
      requireValue(["fixed", "round_robin"].includes(input.mode) && accountId(input.defaultAccountId) && Array.isArray(input.poolAccountIds) && input.poolAccountIds.length <= 20 && input.poolAccountIds.every(accountId) && new Set(input.poolAccountIds).size === input.poolAccountIds.length, "account_selection_invalid");
      const accounts = await this.accounts(), connected = accounts.filter(row => row.connected && row.directUsageGranted).map(row => row.id);
      requireValue(accounts.some(row => row.id === input.defaultAccountId) && input.poolAccountIds.every(id => accounts.some(row => row.id === id)), "account_not_found", 404);
      requireValue(input.poolAccountIds.every(id => connected.includes(id)) && (input.mode === "fixed" ? connected.includes(input.defaultAccountId) : input.poolAccountIds.length > 0), "account_not_connected", 409);
      const selection = { mode: input.mode, defaultAccountId: input.defaultAccountId, poolAccountIds: input.poolAccountIds };
      await this.ctx.storage.transaction(async transaction => {
        const previous = await transaction.get("accountSelection") || { mode: "fixed", defaultAccountId: await transaction.get("defaultAccountId") || "owner", poolAccountIds: [] };
        await transaction.put({ accountSelection: selection, defaultAccountId: selection.defaultAccountId });
        if (JSON.stringify(previous) !== JSON.stringify(selection)) await transaction.put("accountCursor", 0);
      });
      await this.audit(actor, action, "new_roots"); return { ...selection, appliesTo: "new_roots_only" };
    }
    if (action.startsWith("account.")) {
      const fields = action === "account.start" ? ["id", "planUsageConfirmed"] : action === "account.complete" ? ["id", "callbackUrl"] : action === "account.disconnect" ? ["id", "confirmed"] : ["id"];
      exactKeys(input, fields); requireValue(accountId(input.id) && (await this.accountInventory()).some(row => row.id === input.id), "account_not_found", 404);
      const credentials = input.id === "owner" ? this : this.env.Credentials.getByName(input.id); let result;
      if (action === "account.start") { requireValue(input.planUsageConfirmed === true, "plan_usage_ui_unconfirmed"); result = await credentials.start(true); }
      else if (action === "account.refresh") { result = await credentials.refreshStatus(); }
      else if (action === "account.complete") { string(input.callbackUrl, 16384, "callback_url_invalid"); result = await credentials.complete(input.callbackUrl); }
      else if (action === "account.disconnect") { requireValue(input.confirmed === true, "disconnect_confirmation_required"); result = await credentials.disconnect(); }
      else if (action === "account.default") { const status = await credentials.status(); requireValue(status.connected && status.directUsageGranted, "account_not_connected", 409); const selection = { ...await this.accountSelection(), mode: "fixed", defaultAccountId: input.id }; await this.ctx.storage.transaction(async transaction => { await transaction.put({ defaultAccountId: input.id, accountSelection: selection, accountCursor: 0 }); }); result = { ...selection, appliesTo: "new_roots_only" }; }
      else throw new AdminError("action_not_found", 404);
      await this.audit(actor, action, input.id); return result;
    }
    if (action === "skill.validate") { const skill = validateSkill(input); return { name: skill.name, description: skill.description, bytes: encoder.encode(skill.rawContent).length, resources: skill.resources.map(({ path, size }) => ({ path, size })) }; }
    if (action === "skill.publish" || action === "skill.toggle") {
      let rows = await this.ctx.storage.get("skillCatalog") || [], target, revisionRecord = {};
      if (action === "skill.publish") {
        const skill = validateSkill(input); target = skill.name;
        const revision = await hash(JSON.stringify(skill)); skill.version = revision;
        let row = rows.find(value => value.name === target);
        requireValue(row || rows.length < 20, "skill_limit", 409);
        if (!row) { row = { name: target, enabled: false, revisions: [] }; rows.push(row); }
        requireValue(row.revisions.includes(revision) || row.revisions.length < 100, "skill_revision_limit", 409);
        if (!row.revisions.includes(revision)) { revisionRecord[`skillRevision:${target}:${revision}`] = skill; row.revisions.push(revision); }
        Object.assign(row, { description: skill.description, revision, enabled: false, publishedAt: new Date().toISOString(), publishedBy: actor.email });
      } else {
        exactKeys(input, ["name", "enabled"]); requireValue(typeof input.enabled === "boolean", "skill_toggle_invalid");
        const row = rows.find(value => value.name === input.name); requireValue(row, "skill_not_found", 404); target = row.name; row.enabled = input.enabled;
      }
      const skills = await Promise.all(rows.filter(row => row.enabled).map(row => revisionRecord[`skillRevision:${row.name}:${row.revision}`] || this.ctx.storage.get(`skillRevision:${row.name}:${row.revision}`)));
      requireValue(skills.every(Boolean), "skill_revision_missing", 409);
      requireValue(encoder.encode(JSON.stringify(skills)).length <= 1048576, "skill_manifest_size_limit", 409);
      const version = await hash(JSON.stringify(skills));
      await this.ctx.storage.put({ ...revisionRecord, skillCatalog: rows, skillManifestVersion: version, [`skillManifest:${version}`]: { version, skills } });
      await this.audit(actor, action, target); return { manifestVersion: version, catalog: await this.skillCatalog() };
    }
    throw new AdminError("action_not_found", 404);
  }
}

const page = adminPage;

export async function adminRoute(request, env) {
  try {
    const url = new URL(request.url);
    requireValue(env.PUBLIC_ORIGIN && url.origin === env.PUBLIC_ORIGIN && url.protocol === "https:", "canonical_origin_required", 421);
    const owner = env.Credentials.getByName("owner"), path = url.pathname;
    if (request.method === "GET" && path === "/health") return response({ service: productName(env), status: "ok" });
    if (request.method === "GET" && path === "/auth/login") { const login = await owner.startSso(); return redirect(login.location, { "set-cookie": cookieHeader(ATTEMPT, login.browser, 600) }); }
    if (request.method === "GET" && path === "/auth/callback") {
      requireValue([...url.searchParams.keys()].every(key => ["code", "state", "iss", "error", "error_description"].includes(key) && url.searchParams.getAll(key).length === 1), "sso_callback_invalid");
      const login = await owner.completeSso(Object.fromEntries(url.searchParams), cookie(request, ATTEMPT));
      const old = cookie(request, SESSION); if (old) { const prior = await owner.adminSession(old); if (prior) await owner.adminMutation("logout", {}, old, prior.csrf); }
      const headers = new Headers({ location: "/", "cache-control": "no-store", "referrer-policy": "no-referrer" });
      headers.append("set-cookie", cookieHeader(ATTEMPT, "", 0)); headers.append("set-cookie", cookieHeader(SESSION, login.session, login.maxAge));
      return new Response(null, { status: 303, headers });
    }
    const sessionToken = cookie(request, SESSION), session = await owner.adminSession(sessionToken);
    if (request.method === "GET" && ["/", "/login"].includes(path)) return page(env, !!session);
    const diagnostic = env.DIAGNOSTIC_READS_ENABLED === "true" && request.method === "GET" && ["/status", "/channel/status", "/channel/history", "/history"].includes(path) && env.PROBE_KEY_SHA256 && request.headers.get("authorization")?.startsWith("Bearer ") && await hash(request.headers.get("authorization").slice(7)) === env.PROBE_KEY_SHA256;
    requireValue(session || diagnostic, "sso_login_required", 401);
    if (request.method === "GET") {
      if (path.startsWith("/api/github/")) {
        requireValue(session, "sso_login_required", 401);
        const action = path.slice("/api/github/".length), input = action === "status" ? {} : action === "repositories" ? { page: Number(url.searchParams.get("page") || 1) } : action === "file" ? { sourceId: url.searchParams.get("sourceId"), path: url.searchParams.get("path") } : { sourceId: url.searchParams.get("sourceId") };
        return response(await owner.githubRead(action, input, sessionToken));
      }
      if (path === "/status") return response(await owner.status());
      if (path === "/channel/status") return response(await owner.channelStatus());
      if (path === "/history") { requireValue(url.searchParams.get("thread") === "manual-test", "diagnostic_thread_invalid"); return response({ thread: "manual-test", entries: await env.Assistant.getByName("manual-test").history() }); }
      if (path === "/api/threads/settings") {
        const root = url.searchParams.get("root"); requireValue(nativeId(root), "thread_root_invalid");
        const observed = observedThread(await owner.threads(), root, url.searchParams.get("threadKey") || undefined);
        return response(await env.Assistant.getByName(observed.threadKey).adminSettings());
      }
      if (path === "/api/conversations") return response(await listConversations(env, { before: url.searchParams.get("before") || undefined, limit: Number(url.searchParams.get("limit") || 50), kind: url.searchParams.get("kind") || "channel" }));
      if (path === "/channel/history" || path === "/api/threads/history" || path === "/api/threads/export") {
        const root = url.searchParams.get("root"); requireValue(nativeId(root), "thread_root_invalid");
        const observed = observedThread(await owner.threads(), root, url.searchParams.get("threadKey") || undefined);
        const threadKey = observed.threadKey;
        const history = { threadKey, ...await env.Assistant.getByName(threadKey).channelHistory() };
        const page = path.startsWith("/api/") ? await storedHistory(env, objectKey("assistant", env.Assistant.idFromName(threadKey).toString()), url.searchParams.get("session") || history.selected.sessionId, { before: url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined, limit: Number(url.searchParams.get("limit") || 50) }) : null;
        const bounded = page ? { ...history, ...page, receipts: history.receipts.slice(-50), displayLimits: { ...page.displayLimits, receipts: 50 } } : history;
        requireValue(encoder.encode(JSON.stringify(bounded)).length <= 1048576, "thread_history_too_large", 413);
        return response(bounded, 200, path.endsWith("/export") ? { "content-disposition": `attachment; filename="thread-${root.replace(/[^A-Za-z0-9_-]/g, "_")}.json"` } : {});
      }
      if (path === "/api/overview") { const [accounts, snapshot, skills, threads, audit, accountSelection] = await Promise.all([owner.accounts(), owner.controlSnapshot(), owner.skillCatalog(), owner.threads(), owner.adminAudit(), owner.accountSelection()]); return response({ tenant: { id: tenantId(env), name: env.TENANT_NAME || productName(env) }, principal: session.principal, csrf: session.csrf, expiresAt: session.expiresAt, accounts, defaultAccountId: accountSelection.defaultAccountId, accountSelection, manifestVersion: snapshot.manifest.version, skills, threads, audit }); }
      if (path === "/api/skills/source") { const skill = await owner.skillSource(url.searchParams.get("name"), url.searchParams.get("revision") || undefined); requireValue(skill, "skill_not_found", 404); return response(skill); }
      throw new AdminError("route_not_found", 404);
    }
    requireValue(request.method === "POST", "method_not_allowed", 405);
    requireValue(session && request.headers.get("origin") === env.PUBLIC_ORIGIN && request.headers.get("x-csrf-token") === session.csrf && request.headers.get("content-type")?.split(";")[0].trim() === "application/json", "admin_csrf_invalid", 403);
    const raw = await boundedText(request, 400000, "request_too_large", 413);
    let input; try { input = JSON.parse(raw); } catch { throw new AdminError("invalid_json"); }
    if (path === "/api/threads/control") {
      exactKeys(input, ["root", "threadKey", "operationId", "action", "args"]); requireValue(nativeId(input.root), "thread_root_invalid");
      requireValue(typeof input.operationId === "string" && /^admin-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.operationId), "operation_id_invalid");
      requireValue(["model", "thinking", "new", "resume", "name", "clone", "fork", "reload"].includes(input.action) && typeof input.args === "string" && encoder.encode(input.args).length <= 500 && !input.args.includes("\0"), "thread_control_invalid");
      const observed = observedThread(await owner.threads(), input.root, input.threadKey);
      const result = await env.Assistant.getByName(observed.threadKey).adminControl({ operationId: input.operationId, action: input.action, args: input.args });
      await owner.audit(session.principal, `thread.${input.action}`, input.root, result.status);
      return response(result);
    }
    if (path === "/ask") {
      exactKeys(input, ["prompt", "operationId"]); requireValue(url.searchParams.get("thread") === "manual-test", "manual_thread_invalid");
      const prompt = string(input.prompt, 16384); requireValue(typeof input.operationId === "string" && /^manual-[A-Za-z0-9-]{1,128}$/.test(input.operationId), "operation_id_invalid");
      const selected = url.searchParams.get("account") || "owner"; requireValue(accountId(selected), "account_not_found", 404);
      const account = (await owner.accounts()).find(row => row.id === selected); requireValue(account, "account_not_found", 404); requireValue(account.connected && account.directUsageGranted, "account_not_connected", 409);
      return response(await env.Assistant.getByName(selected === "owner" ? "manual-test" : `manual-${selected}`).manualAsk(prompt, input.operationId, selected));
    }
    const actions = { ...Object.fromEntries(["source", "disable", "stage", "preview", "publish", "ask"].map(action => [`/api/github/${action}`, `github.${action}`])), "/api/logout": "logout", "/api/accounts/create": "account.create", "/api/accounts/start": "account.start", "/api/accounts/complete": "account.complete", "/api/accounts/disconnect": "account.disconnect", "/api/accounts/default": "account.default", "/api/accounts/selection": "account.selection", "/api/accounts/refresh": "account.refresh", "/api/skills/validate": "skill.validate", "/api/skills/publish": "skill.publish", "/api/skills/toggle": "skill.toggle" };
    requireValue(actions[path], "route_not_found", 404);
    const result = await owner.adminMutation(actions[path], input, sessionToken, session.csrf);
    if (result.adminError) throw new AdminError(result.adminError, result.status);
    return response(result, 200, path === "/api/logout" ? { "set-cookie": cookieHeader(SESSION, "", 0) } : {});
  } catch (error) {
    const safe = error instanceof AdminError ? error.message : /^[a-z][a-z0-9_]{0,80}$/.test(error?.message || "") ? error.message : "management_request_failed";
    const remoteStatus = safe === "thread_busy" ? 409 : ["super_admin_required", "sso_email_unverified"].includes(safe) ? 403 : ["sso_network_error", "sso_request_failed", "sso_response_invalid"].includes(safe) ? 502 : ["sso_configuration_invalid", "sso_issuer_mismatch", "sso_endpoint_invalid", "sso_protocol_unsupported", "sso_client_not_configured", "sso_policy_invalid"].includes(safe) ? 503 : safe === "sso_busy" ? 429 : 400;
    return response({ error: safe }, (error instanceof AdminError || error instanceof GitHubError) ? error.status : remoteStatus);
  }
}
