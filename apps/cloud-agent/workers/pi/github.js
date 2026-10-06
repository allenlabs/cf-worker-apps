const encoder = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const b64url = bytes => b64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const digest = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))].map(n => n.toString(16).padStart(2, "0")).join("");
const oid = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const accountId = value => value === "owner" || typeof value === "string" && /^account-[a-f0-9-]{36}$/.test(value);
const operation = value => typeof value === "string" && /^[A-Za-z0-9:_-]{1,200}$/.test(value);
const object = value => value && typeof value === "object" && !Array.isArray(value);
export class GitHubError extends Error { constructor(code, status = 400) { super(code); this.status = status; } }
const insist = (condition, code, status = 400) => { if (!condition) throw new GitHubError(code, status); };
const fields = (value, keys) => insist(object(value) && Object.keys(value).every(key => keys.includes(key)), "github_invalid_fields");
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const text = (value, limit, code) => { insist(typeof value === "string" && value.isWellFormed() && encoder.encode(value).length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), code); return value; };
function pathSegments(value) {
  insist(typeof value === "string" && value.length > 0 && value.length <= 240 && !/[\\%\u0000-\u001f\u007f]/.test(value), "github_path_denied");
  insist(value.split("/").every(part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) && ![".git", ".env", "workflows"].includes(part.toLowerCase())), "github_path_denied");
  return value;
}
function filePath(value) { pathSegments(value); insist(/\.(?:md|txt|json|yaml|yml|js|mjs|cjs|ts|tsx|jsx|css|toml)$/i.test(value), "github_text_type_denied"); return value; }
function prefixPath(value) { insist(typeof value === "string" && value.endsWith("/"), "github_prefix_invalid"); pathSegments(value.slice(0, -1)); return value; }
function branchName(value) {
  insist(typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u0020\u007f~^:?*\[\\%]/.test(value) && !value.includes("..") && !value.includes("@{") && !value.startsWith("/") && !value.endsWith("/") && value.split("/").every(part => part && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock")), "github_branch_invalid");
  return value;
}
export const COMMIT_QUERY = "mutation PublishDraft($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { clientMutationId commit { oid } } }";
const headline = value => { text(value, 200, "github_message_invalid"); insist(value.trim().length > 0 && !/[\r\n]/.test(value), "github_message_invalid"); return value; };
function fileContent(value) { text(value, 65536, "github_file_size_invalid"); insist(!value.startsWith("version https://git-lfs.github.com/spec/"), "github_lfs_unsupported"); return value; }

async function boundedJson(response, limit = 1048576) {
  insist(response.ok, "github_request_failed", 502);
  insist(Number(response.headers.get("content-length") || 0) <= limit, "github_response_too_large", 502);
  const reader = response.body?.getReader(); insist(reader, "github_response_invalid", 502);
  let size = 0, value = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; insist(size <= limit, "github_response_too_large", 502); value += decoder.decode(chunk.value, { stream: true }); }
    value += decoder.decode(); return JSON.parse(value);
  } catch (error) { await reader.cancel().catch(() => {}); if (error instanceof GitHubError) throw error; throw new GitHubError("github_response_invalid", 502); }
  finally { reader.releaseLock(); }
}
async function githubRequest(path, token, { method = "GET", body, limit } = {}) {
  // All callers supply host constants and validated encoded identifiers; no URL proxy exists.
  insist(path.startsWith("/") && !path.startsWith("//"), "github_endpoint_invalid");
  let response;
  try { response = await fetch(`https://api.github.com${path}`, { method, redirect: "manual", signal: AbortSignal.timeout(15000), headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "Cloud-Agent-GitHub-Connector", authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
  catch { throw new GitHubError("github_network_error", 502); }
  return boundedJson(response, limit);
}

export function validateCommit(source, payload) {
  fields(payload, ["query", "variables"]); insist(payload.query === COMMIT_QUERY, "github_commit_scope_invalid", 403);
  fields(payload.variables, ["input"]); const input = payload.variables.input; fields(input, ["branch", "expectedHeadOid", "message", "fileChanges", "clientMutationId"]);
  fields(input.branch, ["repositoryNameWithOwner", "branchName"]); fields(input.message, ["headline"]); fields(input.fileChanges, ["additions"]);
  insist(input.branch.repositoryNameWithOwner === source.repository && input.branch.branchName === source.branch && oid(input.expectedHeadOid) && operation(input.clientMutationId), "github_commit_scope_invalid", 403); headline(input.message.headline);
  const files = input.fileChanges.additions; insist(Array.isArray(files) && files.length > 0 && files.length <= 32, "github_commit_scope_invalid", 403);
  const paths = new Set(); let total = 0;
  for (const file of files) {
    fields(file, ["path", "contents"]); insist(typeof file.path === "string" && file.path.startsWith(source.prefix) && !paths.has(file.path), "github_commit_scope_invalid", 403); filePath(file.path.slice(source.prefix.length)); paths.add(file.path);
    insist(typeof file.contents === "string" && file.contents.length <= 87384 && /^[A-Za-z0-9+/]*={0,2}$/.test(file.contents), "github_commit_scope_invalid", 403);
    let bytes, content; try { bytes = Uint8Array.from(atob(file.contents), c => c.charCodeAt(0)); content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new GitHubError("github_commit_scope_invalid", 403); }
    insist(b64(bytes) === file.contents, "github_commit_scope_invalid", 403); fileContent(content); total += bytes.length;
  }
  insist(total <= 262144, "github_draft_limit", 413);
}

export class GitHubBroker {
  constructor(env) { this.env = env; this.tokens = new Map(); }
  configuration() {
    const appId = Number(this.env.GITHUB_APP_ID), installationId = Number(this.env.GITHUB_INSTALLATION_ID), owner = this.env.GITHUB_INSTALLATION_OWNER;
    insist(positiveId(appId) && positiveId(installationId) && typeof owner === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(owner) && typeof this.env.GITHUB_APP_PRIVATE_KEY === "string", "github_not_configured", 503);
    return { appId, installationId, owner };
  }
  async jwt() {
    const { appId } = this.configuration(); const pem = this.env.GITHUB_APP_PRIVATE_KEY;
    insist(pem.length <= 16384 && /^-----BEGIN PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]+-----END PRIVATE KEY-----\s*$/.test(pem), "github_key_format_invalid", 503);
    try {
      const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), c => c.charCodeAt(0));
      const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
      const now = Math.floor(Date.now() / 1000), payload = `${b64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))}.${b64url(encoder.encode(JSON.stringify({ iss: this.env.GITHUB_APP_CLIENT_ID || String(appId), iat: now - 60, exp: now + 480 })))}`;
      return `${payload}.${b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(payload))))}`;
    } catch { throw new GitHubError("github_key_invalid", 503); }
  }
  async verify() {
    const config = this.configuration(), jwt = await this.jwt();
    const app = await githubRequest("/app", jwt, { limit: 65536 });
    insist(app.id === config.appId && (!this.env.GITHUB_APP_CLIENT_ID || app.client_id === this.env.GITHUB_APP_CLIENT_ID), "github_app_mismatch", 503);
    const installation = await githubRequest(`/app/installations/${config.installationId}`, jwt, { limit: 65536 });
    insist(installation.id === config.installationId && installation.app_id === config.appId && installation.account?.login?.toLowerCase() === config.owner.toLowerCase() && installation.suspended_at === null, "github_installation_unavailable", 403);
    return { jwt, installation, app };
  }
  async status() {
    try { const { app, installation } = await this.verify(); return { configured: true, connected: true, app: { id: app.id, slug: app.slug }, installation: { id: installation.id, owner: installation.account.login, repositorySelection: installation.repository_selection }, runtimePermissions: { contents: "write", metadata: "read" }, publication: "reviewed_text_only" }; }
    catch (error) { return { configured: !!this.env.GITHUB_APP_PRIVATE_KEY, connected: false, error: error instanceof GitHubError ? error.message : "github_unavailable" }; }
  }
  async token(repositoryId, write = false) {
    const { jwt } = await this.verify(), { installationId } = this.configuration();
    insist(repositoryId === undefined || positiveId(repositoryId), "github_repository_invalid");
    const cacheKey = `${repositoryId || "inventory"}:${write}`;
    const cached = this.tokens.get(cacheKey); if (cached?.expiresAt > Date.now() + 60000) return cached.token;
    const permissions = { contents: write ? "write" : "read", metadata: "read" };
    const result = await githubRequest(`/app/installations/${installationId}/access_tokens`, jwt, { method: "POST", body: { ...(repositoryId ? { repository_ids: [repositoryId] } : {}), permissions }, limit: 65536 });
    insist(typeof result.token === "string" && result.token.length > 0 && result.token.length <= 4096 && Number.isFinite(Date.parse(result.expires_at)) && Date.parse(result.expires_at) > Date.now() && object(result.permissions) && result.permissions.contents === permissions.contents && result.permissions.metadata === "read" && Object.keys(result.permissions).every(key => ["contents", "metadata"].includes(key)), "github_token_scope_invalid", 502);
    if (repositoryId && result.repositories) insist(result.repositories.length === 1 && result.repositories[0].id === repositoryId, "github_token_repository_mismatch", 502);
    this.tokens.set(cacheKey, { token: result.token, expiresAt: Date.parse(result.expires_at) }); return result.token;
  }
  repository(value) {
    insist(positiveId(value?.id) && typeof value.full_name === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.full_name) && value.full_name.split("/")[0].toLowerCase() === this.configuration().owner.toLowerCase(), "github_repository_invalid", 502);
    return { id: value.id, name: value.full_name, private: value.private === true, defaultBranch: value.default_branch };
  }
  async repositories(page) {
    insist(Number.isInteger(page) && page >= 1 && page <= 100, "github_page_invalid");
    const result = await githubRequest(`/installation/repositories?per_page=50&page=${page}`, await this.token());
    insist(Array.isArray(result.repositories) && result.repositories.length <= 50 && Number.isSafeInteger(result.total_count), "github_inventory_invalid", 502);
    return { repositories: result.repositories.map(row => this.repository(row)), page, nextPage: page * 50 < result.total_count ? page + 1 : null, total: result.total_count };
  }
  async source(repositoryId, branch, prefix) {
    insist(positiveId(repositoryId), "github_repository_invalid"); branchName(branch); prefixPath(prefix);
    const token = await this.token(repositoryId), repository = this.repository(await githubRequest(`/repositories/${repositoryId}`, token, { limit: 65536 }));
    const head = await githubRequest(`/repos/${repository.name}/branches/${encodeURIComponent(branch)}`, token, { limit: 65536 });
    insist(head.name === branch && oid(head.commit?.sha), "github_branch_unavailable", 404);
    return { repositoryId, repository: repository.name, private: repository.private, branch, prefix, baseOid: head.commit.sha };
  }
  async tree(source, baseOid) {
    insist(oid(baseOid), "github_base_invalid");
    const token = await this.token(source.repositoryId), repo = this.repository(await githubRequest(`/repositories/${source.repositoryId}`, token, { limit: 65536 }));
    insist(repo.name === source.repository, "github_repository_renamed", 409);
    const result = await githubRequest(`/repos/${repo.name}/git/trees/${baseOid}?recursive=1`, token);
    insist(result.truncated === false && Array.isArray(result.tree) && result.tree.length <= 10000, "github_tree_too_large", 413);
    return { token, tree: result.tree };
  }
  regular(tree, path) {
    for (const entry of tree) if (entry.path === path || path.startsWith(`${entry.path}/`)) insist(entry.type === "tree" && entry.mode === "040000" || entry.path === path && entry.type === "blob" && entry.mode === "100644", "github_regular_text_only");
    const entry = tree.find(row => row.path === path); if (entry) insist(oid(entry.sha), "github_blob_invalid", 502); return entry;
  }
  async files(source, baseOid) {
    const { tree } = await this.tree(source, baseOid);
    this.regular(tree, source.prefix.slice(0, -1));
    const files = tree.filter(row => row.path.startsWith(source.prefix) && row.type !== "tree").map(row => {
      const path = row.path.slice(source.prefix.length); let editable = true;
      try { filePath(path); this.regular(tree, row.path); } catch { editable = false; }
      return { path, editable, bytes: row.size ?? null };
    });
    insist(files.length <= 200, "github_source_too_large", 413); return { files, baseOid };
  }
  async read(source, baseOid, path, allowMissing = false) {
    filePath(path); const fullPath = source.prefix + path, { tree, token } = await this.tree(source, baseOid), entry = this.regular(tree, fullPath);
    if (!entry) { insist(allowMissing, "github_file_not_found", 404); return { path, content: null, blobOid: null }; }
    insist(Number.isInteger(entry.size) && entry.size >= 0 && entry.size <= 65536, "github_file_size_invalid", 413);
    const blob = await githubRequest(`/repos/${source.repository}/git/blobs/${entry.sha}`, token, { limit: 100000 });
    insist(blob.encoding === "base64" && typeof blob.content === "string" && blob.size === entry.size && blob.sha === entry.sha, "github_blob_invalid", 502);
    let content;
    try { const bytes = Uint8Array.from(atob(blob.content.replaceAll("\n", "")), c => c.charCodeAt(0)); insist(bytes.length === entry.size, "github_blob_invalid", 502); content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch (error) { if (error instanceof GitHubError) throw error; throw new GitHubError("github_utf8_required"); }
    fileContent(content); return { path, content, blobOid: entry.sha };
  }
  async prepare(source) { await this.token(source.repositoryId, true); return { ready: true }; }
  async commit(source, payload) {
    validateCommit(source, payload);
    const token = await this.token(source.repositoryId, true);
    return githubRequest("/graphql", token, { method: "POST", body: payload, limit: 65536 });
  }
}

export async function githubPrincipal(principal) {
  insist(principal?.role === "super_admin" && typeof principal.issuer === "string" && typeof principal.subject === "string", "github_principal_required", 403);
  return digest(JSON.stringify([principal.issuer, principal.subject]));
}
export async function githubSources(owner, principal) {
  const actor = await githubPrincipal(principal); return (await owner.ctx.storage.get("githubSources") || []).filter(source => source.actor === actor).map(({ actor: ignored, ...source }) => source);
}
export async function githubRegister(owner, principal, input) {
  fields(input, ["repositoryId", "branch", "prefix", "accountId"]);
  insist(accountId(input.accountId), "github_account_invalid");
  const selected = (await owner.accounts()).find(row => row.id === input.accountId); insist(selected?.connected && selected.inferenceReady, "github_account_unavailable", 409);
  const source = await owner.githubBroker().source(input.repositoryId, input.branch, input.prefix), actor = await githubPrincipal(principal);
  const rows = await owner.ctx.storage.get("githubSources") || []; insist(rows.length < 100, "github_source_limit", 409);
  const stored = { ...source, id: crypto.randomUUID(), actor, accountId: input.accountId, generation: 1, enabled: true, createdAt: new Date().toISOString() };
  rows.push(stored); await owner.ctx.storage.put("githubSources", rows); await owner.audit(principal, "github.source.register", stored.id); return stored;
}
export async function githubAuthorize(owner, context) {
  insist(object(context) && /^[a-f0-9]{64}$/.test(context.actor || "") && typeof context.sourceId === "string", "github_context_invalid", 403);
  const source = (await owner.ctx.storage.get("githubSources") || []).find(row => row.id === context.sourceId && row.actor === context.actor);
  insist(source?.enabled && source.generation === context.generation && source.repositoryId === context.repositoryId && source.repository === context.repository && source.branch === context.branch && source.prefix === context.prefix && source.accountId === context.accountId, "github_source_changed", 403);
  // Stored issuer/subject must still be in the current SSO policy, even during a model tool call.
  let admins, pins; try { admins = JSON.parse(owner.env.SUPER_ADMIN_EMAILS || "[]"); pins = JSON.parse(owner.env.SUPER_ADMIN_SUBJECTS || "{}"); } catch { throw new GitHubError("github_principal_revoked", 403); }
  insist(context.issuer === owner.env.SSO_ISSUER && admins.includes(context.email) && (!Object.keys(pins).length || pins[context.email] === context.subject) && await githubPrincipal({ ...context, role: "super_admin" }) === context.actor, "github_principal_revoked", 403);
  const selected = (await owner.accounts()).find(row => row.id === source.accountId); insist(selected?.connected && selected.inferenceReady, "github_account_unavailable", 409);
  return source;
}
export async function githubContext(owner, principal, sourceId) {
  const actor = await githubPrincipal(principal), source = (await owner.ctx.storage.get("githubSources") || []).find(row => row.id === sourceId && row.actor === actor);
  insist(source, "github_source_not_found", 404);
  const context = { actor, issuer: principal.issuer, subject: principal.subject, email: principal.email, sourceId: source.id, generation: source.generation, repositoryId: source.repositoryId, repository: source.repository, branch: source.branch, prefix: source.prefix, accountId: source.accountId };
  await githubAuthorize(owner, context); return { context, objectName: `github-${await digest(JSON.stringify([actor, source.id, source.generation]))}`, baseOid: source.baseOid };
}


export { encoder, b64, digest, oid, operation, fields, filePath, fileContent, headline, insist, text };
