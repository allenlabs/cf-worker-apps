/** Resolve an explicit OAuth scope only for the exact configured MCP endpoint. */
export function configuredOAuthScope(raw: string | undefined, endpoint: string): string | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("MCP_OAUTH_SCOPES must be a JSON endpoint-to-scope-list object."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MCP_OAUTH_SCOPES must be a JSON endpoint-to-scope-list object.");
  }
  const scopesByEndpoint = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    const url = new URL(key);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.href !== key) {
      throw new Error("MCP OAuth scope keys must be exact canonical HTTPS endpoints without credentials or fragments.");
    }
    if (!isScopeList(value) || new Set(value).size !== value.length) {
      throw new Error("MCP OAuth scopes must be a nonempty list of unique OAuth scope tokens.");
    }
    scopesByEndpoint.set(key, value.join(" "));
  }
  if (scopesByEndpoint.size === 0) throw new Error("MCP_OAUTH_SCOPES must configure at least one endpoint.");
  return scopesByEndpoint.get(endpoint);
}

function isScopeList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(
    (scope: unknown) => typeof scope === "string" && /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope),
  );
}
