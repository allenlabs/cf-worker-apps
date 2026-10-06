import { serveImageAsset } from "./image-tool.js";

const NATIVE = "https://app-store-api.channel.io/general/v1/native/functions", MAX_IMAGE = 5 * 1024 * 1024;
const id = value => typeof value === "string" && /^[A-Za-z0-9_:-]{1,255}$/.test(value);
const asset = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const insist = (value, code) => { if (!value) throw Error(code); };
const hash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
function origin(env) {
  let url; try { url = new URL(env.PUBLIC_ORIGIN); } catch { throw Error("image_channel_configuration_invalid"); }
  insist(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/", "image_channel_configuration_invalid");
  return url.origin;
}
const receipt = row => ({ status: row.status === "sending" ? "unknown" : row.status, ...(row.code ? { code: row.code } : {}), ...(row.replyId ? { replyId: row.replyId } : {}), ...(row.status === "sent" ? { fileCount: 1 } : {}) });
async function json(response) {
  const reader = response.body?.getReader(); insist(reader, "image_channel_send_unknown");
  const chunks = []; let size = 0;
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 262144) { await reader.cancel(); throw Error("image_channel_send_unknown"); } chunks.push(chunk.value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function copiedFile(file, image, base) {
  if (!file || typeof file !== "object" || Array.isArray(file) || file.mime !== undefined && file.mime !== image.mediaType || file.contentType !== undefined && file.contentType !== image.mediaType || file.size !== undefined && file.size !== image.bytes) return false;
  if (typeof file.key === "string" && /^[A-Za-z0-9._/-]{1,1024}$/.test(file.key) && typeof file.bucket === "string" && /^[A-Za-z0-9._-]{1,255}$/.test(file.bucket)) return true;
  try { const url = new URL(file.url); return url.href.length <= 2048 && url.protocol === "https:" && !url.username && !url.password && !url.hash && url.origin !== base && (url.hostname === "channel.io" || url.hostname.endsWith(".channel.io") || url.hostname === "channel.works" || url.hostname.endsWith(".channel.works")); } catch { return false; }
}

export async function deliverChannelImage({ env, ledger, actorId, target, sourceOperationId, image, access }) {
  if (env.IMAGE_CHANNEL_DELIVERY_ENABLED !== "true") return { status: "disabled" };
  let jobKey, row;
  try {
    insist(id(env.TENANT_ID) && /^[a-f0-9]{64}$/.test(actorId ?? "") && typeof sourceOperationId === "string" && /^[A-Za-z0-9_:-]{1,100}$/.test(sourceOperationId) && ledger?.transaction && env.IMAGE_ASSETS, "image_channel_input_invalid");
    insist(typeof access === "string" && access.length >= 8 && access.length <= 8192 && !/[\r\n]/.test(access), "image_channel_auth_failed");
    insist(target?.channelId === env.ALLOWED_CHANNEL_ID && target?.groupId === env.VISIT_MCP_GROUP_ID && id(target.rootMessageId) && id(target.channelId) && id(target.groupId), "image_channel_target_denied");
    insist(image?.status === "ready" && asset(image.assetId) && ["image/png", "image/webp"].includes(image.mediaType) && Number.isInteger(image.bytes) && image.bytes >= 30 && image.bytes <= MAX_IMAGE && Number.isInteger(image.width) && Number.isInteger(image.height) && image.width > 0 && image.height > 0 && image.width <= 4096 && image.height <= 4096, "image_channel_asset_denied");
    const generated = await ledger.get(`image-job:${await hash(JSON.stringify([env.TENANT_ID, sourceOperationId]))}`);
    insist(generated?.status === "ready" && generated.tenantId === env.TENANT_ID && ["assetId", "mediaType", "bytes", "width", "height"].every(key => generated[key] === image[key]), "image_channel_asset_denied");
    const stored = await env.IMAGE_ASSETS.head(`images/${await hash(env.TENANT_ID)}/${image.assetId}`);
    insist(stored?.customMetadata?.tenantId === env.TENANT_ID && stored.customMetadata.assetId === image.assetId && stored.size === image.bytes && stored.httpMetadata?.contentType === image.mediaType && (stored.customMetadata.width === undefined || stored.customMetadata.width === String(image.width)) && (stored.customMetadata.height === undefined || stored.customMetadata.height === String(image.height)), "image_channel_asset_denied");
    const base = origin(env), pin = await hash(JSON.stringify([actorId, target.channelId, target.groupId, target.rootMessageId, image.assetId]));
    jobKey = `image-delivery:${await hash(JSON.stringify([env.TENANT_ID, sourceOperationId]))}`;
    const token = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join(""), tokenHash = await hash(token);
    const claim = await ledger.transaction(async transaction => {
      const previous = await transaction.get(jobKey);
      if (previous) { insist(previous.pin === pin, "image_channel_operation_conflict"); return { created: false, row: previous }; }
      const expiresAt = Date.now() + 900000, row = { status: "sending", pin, tokenHash, expiresAt };
      await transaction.put(`image-transfer:${tokenHash}`, { tenantId: env.TENANT_ID, assetId: image.assetId, expiresAt });
      await transaction.put(jobKey, row); return { created: true, row };
    });
    row = claim.row;
    if (!claim.created) return receipt(row);
    let response, envelope;
    try {
      response = await fetch(NATIVE, { method: "PUT", redirect: "manual", signal: AbortSignal.timeout(15000), headers: { "content-type": "application/json", "x-access-token": access }, body: JSON.stringify({ method: "writeGroupMessage", params: { channelId: target.channelId, groupId: target.groupId, rootMessageId: target.rootMessageId, broadcast: false, dto: { plainText: "이미지를 생성했습니다.", botName: env.PRODUCT_NAME || "Cloud Agent", requestId: `img-${sourceOperationId}`, files: [{ url: `${base}/image-transfer/${actorId}/${token}`, mime: image.mediaType, fileName: `image-${image.assetId}.${image.mediaType === "image/png" ? "png" : "webp"}` }] } } }) });
      if (response.ok) envelope = await json(response);
    } catch { row = { ...row, status: "unknown", code: "image_channel_send_unknown" }; await ledger.put(jobKey, row); return receipt(row); }
    if (response.status >= 500 || response.status === 408) row = { ...row, status: "unknown", code: "image_channel_send_unknown" };
    else if (!response.ok || envelope?.error) row = { ...row, status: "failed", code: "image_channel_send_rejected" };
    else {
      const message = envelope?.result?.message;
      const capability = await ledger.get(`image-transfer:${row.tokenHash}`);
      const confirmed = Number.isSafeInteger(capability?.fetchedAt) && capability.fetchedAt > 0 && id(message?.id) && Array.isArray(message.files) && message.files.length === 1 && copiedFile(message.files[0], image, base);
      row = { ...row, status: confirmed ? "sent" : "unknown", ...(confirmed ? {} : { code: "image_channel_file_unconfirmed" }), ...(id(message?.id) ? { replyId: message.id } : {}) };
    }
    await ledger.put(jobKey, row);
    if (["sent", "failed"].includes(row.status)) await ledger.delete(`image-transfer:${row.tokenHash}`);
    return receipt(row);
  } catch (error) {
    const code = /^image_channel_[a-z_]+$/.test(error?.message) ? error.message : "image_channel_send_unknown";
    if (row && jobKey) { row = { ...row, status: "unknown", code: "image_channel_send_unknown" }; try { await ledger.put(jobKey, row); } catch {} return receipt(row); }
    return { status: "failed", code };
  }
}

export async function readImageTransfer({ env, ledger, token, method }) {
  const missing = () => new Response(null, { status: 404, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  try {
    if (env.IMAGE_CHANNEL_DELIVERY_ENABLED !== "true" || !["GET", "HEAD"].includes(method) || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || !id(env.TENANT_ID) || !ledger?.get) return missing();
    const key = `image-transfer:${await hash(token)}`, capability = await ledger.get(key);
    if (capability?.tenantId !== env.TENANT_ID || !asset(capability.assetId) || !Number.isSafeInteger(capability.expiresAt) || capability.expiresAt <= Date.now()) return missing();
    const response = await serveImageAsset(new Request(`${origin(env)}/assets/${capability.assetId}`, { method }), env, { tenantId: capability.tenantId });
    if (response.status !== 200) return missing();
    if (method === "GET" && !await ledger.transaction(async transaction => {
      const current = await transaction.get(key);
      if (current?.tenantId !== env.TENANT_ID || current.assetId !== capability.assetId || !Number.isSafeInteger(current.expiresAt) || current.expiresAt <= Date.now()) return false;
      await transaction.put(key, { ...current, fetchedAt: Date.now() }); return true;
    })) return missing();
    return response;
  } catch { return missing(); }
}
