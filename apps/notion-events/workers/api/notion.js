// Source contracts: https://developers.notion.com/reference/webhooks/comment-created
// https://developers.notion.com/reference/retrieve-comment
// https://developers.notion.com/reference/comment-object
const MAX_COMMENT_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (code, retryable = false) => Object.assign(new Error(code), { code, retryable });

function uuid(value) {
  if (typeof value !== 'string' || !/^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(value)) return null;
  const hex = value.replaceAll('-', '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value.slice(0, 10) && Number(value.slice(11, 13)) < 24;
}

export function sourceConfig(env) {
  const workspaceId = uuid(env?.NOTION_WORKSPACE_ID);
  const integrationId = uuid(env?.NOTION_INTEGRATION_ID);
  const subscriptionId = uuid(env?.NOTION_SUBSCRIPTION_ID);
  const botUserId = uuid(env?.NOTION_BOT_USER_ID);
  let pages, ignored;
  try { pages = JSON.parse(env?.NOTION_PAGE_IDS); ignored = JSON.parse(env?.NOTION_IGNORED_AUTHOR_IDS ?? '[]'); } catch { throw error('invalid_source_config'); }
  if (!workspaceId || !integrationId || !subscriptionId || !botUserId || !Array.isArray(pages) || !pages.length || pages.some(page => !uuid(page)) || !Array.isArray(ignored) || ignored.some(author => !uuid(author))) throw error('invalid_source_config');
  return { workspaceId, integrationId, subscriptionId, pageIds: [...new Set(pages.map(uuid))], botUserId, ...(ignored.length ? { ignoredAuthorIds: [...new Set(ignored.map(uuid))] } : {}) };
}

export function normalizeSource(payload, config) {
  if (!record(payload)) throw error('invalid_source');
  if (payload.type !== 'comment.created') return { skip: 'event_type' };
  const id = uuid(payload.id), workspaceId = uuid(payload.workspace_id), integrationId = uuid(payload.integration_id), subscriptionId = uuid(payload.subscription_id);
  const pageId = uuid(payload.data?.page_id), commentId = uuid(payload.entity?.id), parentId = uuid(payload.data?.parent?.id);
  const parentType = payload.data?.parent?.type;
  const hasDiscussion = Object.hasOwn(payload.data ?? {}, 'discussion_id');
  const discussionId = hasDiscussion ? uuid(payload.data.discussion_id) : undefined;
  if (!id || !workspaceId || !integrationId || !subscriptionId || !pageId || !commentId || !parentId || !timestamp(payload.timestamp) || payload.entity?.type !== 'comment' ||
      (parentType !== undefined && !['page', 'block'].includes(parentType)) || (parentType === 'page' && parentId !== pageId) ||
      (hasDiscussion && !discussionId) || !Array.isArray(payload.authors) || !payload.authors.length ||
      payload.authors.some(author => !record(author) || !uuid(author.id) || !['person', 'bot', 'agent'].includes(author.type))) throw error('invalid_source');
  if (workspaceId !== config.workspaceId) return { skip: 'workspace_mismatch' };
  if (integrationId !== config.integrationId) return { skip: 'integration_mismatch' };
  if (subscriptionId !== config.subscriptionId) return { skip: 'subscription_mismatch' };
  if (!config.pageIds.includes(pageId)) return { skip: 'out_of_scope' };
  const authors = payload.authors.map(author => ({ id: uuid(author.id), type: author.type }));
  if (authors.some(author => author.id === config.botUserId)) return { skip: 'self_authored' };
  if (authors.some(author => config.ignoredAuthorIds?.includes(author.id))) return { skip: 'ignored_author' };
  return {
    id, timestamp: payload.timestamp, pageId, commentId,
    parent: { id: parentId, ...(parentType === undefined ? {} : { type: parentType }) },
    authors, workspaceId, integrationId, subscriptionId,
    ...(hasDiscussion ? { discussionId } : {})
  };
}

// Verify raw bytes, before parsing JSON. Re-serializing changes the signed payload.
export async function verifySourceSignature(bytes, header, verificationToken) {
  if (typeof header !== 'string' || !/^sha256=[a-fA-F\d]{64}$/.test(header) || typeof verificationToken !== 'string' || !verificationToken ||
      !(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes))) return false;
  const signature = Uint8Array.from(header.slice(7).match(/../g), pair => Number.parseInt(pair, 16));
  try {
    const key = await crypto.subtle.importKey('raw', encoder.encode(verificationToken), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('HMAC', key, signature, bytes);
  } catch { return false; }
}

function discard(body) {
  // Cleanup must not change an already-known HTTP or size failure.
  try { body?.cancel().catch(() => {}); } catch {}
}

async function commentBytes(response) {
  if (Number(response.headers.get('content-length')) > MAX_COMMENT_BYTES) {
    discard(response.body);
    throw error('notion_body_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_COMMENT_BYTES) {
        discard(reader);
        throw error('notion_body_too_large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function retryAfter(value) {
  const milliseconds = Number(value) * 1000;
  if (value !== null && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(milliseconds)) return milliseconds;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1000;
}

export async function hydrateComment(source, env, fetcher = fetch) {
  const config = sourceConfig(env);
  const commentId = uuid(source?.commentId), parentId = uuid(source?.parent?.id), pageId = uuid(source?.pageId);
  if (!commentId || !parentId || !pageId || (source.parent.type !== undefined && !['page', 'block'].includes(source.parent.type)) ||
      !config.pageIds.includes(pageId) || source.workspaceId !== config.workspaceId || source.integrationId !== config.integrationId || source.subscriptionId !== config.subscriptionId ||
      (source.discussionId !== undefined && !uuid(source.discussionId))) throw error('invalid_source');
  if (typeof env.NOTION_API_TOKEN !== 'string' || !env.NOTION_API_TOKEN.trim()) throw error('notion_token_missing');
  const signal = AbortSignal.timeout(10000);
  let response, bytes;
  try {
    response = await fetcher(`https://api.notion.com/v1/comments/${commentId}`, {
      method: 'GET', redirect: 'manual', signal,
      headers: { Authorization: `Bearer ${env.NOTION_API_TOKEN}`, 'Notion-Version': '2026-03-11' }
    });
    if (!response.ok) {
      const failure = error(`notion_http_${response.status}`, response.status === 429 || response.status >= 500);
      if ([429, 529].includes(response.status)) {
        failure.retryAfterMs = retryAfter(response.headers.get('retry-after'));
        try {
          const detail = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await commentBytes(response)));
          if (response.status === 429 && detail?.additional_data?.rate_limit_reason === 'public_api_request_blocked') failure.retryable = false;
        } catch { /* Keep the known HTTP failure if the bounded error body is invalid. */ }
      } else discard(response.body);
      throw failure;
    }
    bytes = await commentBytes(response);
  } catch (failure) {
    if (failure?.code && typeof failure.retryable === 'boolean') throw failure;
    throw error(signal.aborted || ['TimeoutError', 'AbortError'].includes(failure?.name) ? 'notion_timeout' : 'notion_network', true);
  }
  let comment;
  try { comment = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw error('notion_invalid_json'); }
  const type = comment?.parent?.type;
  const fetchedParentId = ['page_id', 'block_id'].includes(type) ? uuid(comment.parent[type]) : null;
  if (!record(comment) || comment.object !== 'comment' || !uuid(comment.id) || !fetchedParentId || !uuid(comment.created_by?.id) || !uuid(comment.discussion_id) ||
      !Array.isArray(comment.rich_text) || comment.rich_text.some(part => !record(part) || typeof part.plain_text !== 'string')) throw error('notion_invalid_comment');
  if (uuid(comment.id) !== commentId || fetchedParentId !== parentId || (type === 'page_id' && fetchedParentId !== pageId) ||
      (source.parent.type !== undefined && `${source.parent.type}_id` !== type) ||
      (source.discussionId !== undefined && uuid(comment.discussion_id) !== uuid(source.discussionId))) throw error('source_mismatch');
  if (uuid(comment.created_by.id) === config.botUserId) return { skip: 'self_authored' };
  if (config.ignoredAuthorIds?.includes(uuid(comment.created_by.id))) return { skip: 'ignored_author' };
  return { comment, text: comment.rich_text.map(part => part.plain_text).join(''), observedAt: new Date().toISOString() };
}
