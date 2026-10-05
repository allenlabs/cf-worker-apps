const encoder = new TextEncoder();
const positiveTtl = 6 * 60 * 60 * 1000;
const negativeTtl = 60 * 1000;
const identifier = value => typeof value === "string" && /^[A-Za-z0-9_:-]{1,255}$/.test(value);
const tenant = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const name = value => typeof value === "string" && value.trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && encoder.encode(value).length <= 256 ? value.trim() : null;
const fallback = managerId => ({ managerId, displayName: `직원 ${managerId}`, state: "fallback" });

export const MANAGER_DIRECTORY_SCHEMA = `CREATE TABLE IF NOT EXISTS manager_directory (
  tenant_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  manager_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('resolved', 'fallback')),
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, channel_id, manager_id)
) STRICT;`;

/**
 * @typedef {{managerId: string, displayName: string, state: 'resolved'|'fallback'}} ManagerDisplay
 * @typedef {{manager: {id: string, name?: unknown, channelId?: string}}} ManagerLookupResult
 */

async function lookupDisplay(lookup, channelId, managerId) {
  const controller = new AbortController();
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => lookup({ channelId, managerId }, { signal: controller.signal })),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("manager_lookup_timeout")); }, 2000); })
    ]);
    const manager = object(result) && object(result.manager) ? result.manager : null;
    const displayName = manager && manager.id === managerId && (manager.channelId === undefined || manager.channelId === channelId) ? name(manager.name) : null;
    return displayName ? { managerId, displayName, state: "resolved" } : fallback(managerId);
  } catch { return fallback(managerId); }
  finally { clearTimeout(timer); controller.abort(); }
}

/**
 * Resolve only sender IDs already observed by the server in its fixed channel.
 * The caller derives tenant/channel from deployment configuration and owns the
 * authenticated getManager callback. This helper never receives credentials.
 * Returned displayName is untrusted text: render with textContent or escaping.
 * @param {{db: D1Database, tenantId: string, channelId: string, managerIds: readonly string[], lookup: (params: {channelId: string, managerId: string}, options: {signal: AbortSignal}) => Promise<ManagerLookupResult>, now?: () => number}} input
 * @returns {Promise<Map<string, ManagerDisplay>>}
 */
export async function resolveManagers({ db, tenantId, channelId, managerIds, lookup, now = Date.now }) {
  if (!tenant(tenantId) || !identifier(channelId) || !Array.isArray(managerIds) || managerIds.length > 50 || managerIds.some(id => !identifier(id)) || typeof lookup !== "function" || typeof now !== "function") throw new Error("manager_directory_invalid");
  const at = now();
  if (!Number.isSafeInteger(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - positiveTtl) throw new Error("manager_directory_invalid");
  const ids = [...new Set(managerIds)], displays = new Map();
  if (!ids.length) return displays;
  const query = db.prepare(`SELECT manager_id, display_name, state, fetched_at, expires_at FROM manager_directory
    WHERE tenant_id = ? AND channel_id = ? AND manager_id IN (${ids.map(() => "?").join(",")})`).bind(tenantId, channelId, ...ids);
  const readCache = async () => {
    const rows = await query.all();
    if (rows.success === false || !Array.isArray(rows.results)) throw new Error("manager_directory_read_failed");
    for (const row of rows.results) {
      const ttl = row.state === "resolved" ? positiveTtl : negativeTtl;
      if (!ids.includes(row.manager_id) || !["resolved", "fallback"].includes(row.state) || !Number.isSafeInteger(row.fetched_at) || row.fetched_at < 0 || !Number.isSafeInteger(row.expires_at) || row.expires_at - row.fetched_at !== ttl || row.expires_at <= at) continue;
      if (row.state === "resolved" && name(row.display_name)) displays.set(row.manager_id, { managerId: row.manager_id, displayName: name(row.display_name), state: "resolved" });
      if (row.state === "fallback" && row.display_name === fallback(row.manager_id).displayName) displays.set(row.manager_id, fallback(row.manager_id));
    }
  };
  await readCache();
  const missing = ids.filter(id => !displays.has(id)), fetched = [];
  // ponytail: a page has at most 50 IDs and 5 concurrent 2s lookups; batchGetManagers is the upgrade path.
  for (let offset = 0; offset < missing.length; offset += 5) fetched.push(...await Promise.all(missing.slice(offset, offset + 5).map(id => lookupDisplay(lookup, channelId, id))));
  if (fetched.length) {
    const result = await db.batch(fetched.map(display => db.prepare(`INSERT INTO manager_directory
      (tenant_id, channel_id, manager_id, display_name, state, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, channel_id, manager_id) DO UPDATE SET display_name = excluded.display_name,
        state = excluded.state, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at
      WHERE excluded.fetched_at >= manager_directory.fetched_at`).bind(tenantId, channelId, display.managerId, display.displayName, display.state, at, at + (display.state === "resolved" ? positiveTtl : negativeTtl))));
    if (result.some(row => row.success === false)) throw new Error("manager_directory_write_failed");
    await readCache();
    if (ids.some(id => !displays.has(id))) throw new Error("manager_directory_write_unconfirmed");
  }
  return new Map(ids.map(id => [id, displays.get(id)]));
}
