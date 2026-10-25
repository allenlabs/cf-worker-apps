import { digest, fail } from '../../../mcp-events/workers/api/protocol.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = value => typeof value === 'string' && value.isWellFormed();
function uuid(value) {
  if (typeof value !== 'string' || !/^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(value)) return null;
  const hex = value.replaceAll('-', '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function revision(value) {
  if (!text(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return false;
  return new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10);
}

function canonicalJSON(value, depth = 0, ancestors = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (text(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || depth >= 32 || ancestors.has(value) || Object.getOwnPropertySymbols(value).length ||
      !(Array.isArray(value) || record(value))) throw new Error('Unsupported JSON snapshot');
  const keys = Object.keys(value);
  const names = Object.getOwnPropertyNames(value).filter(key => !(Array.isArray(value) && key === 'length'));
  if (names.length !== keys.length || keys.some(key => !text(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw new Error('Unsupported JSON snapshot');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (keys.length !== value.length || Array.from({ length: value.length }, (_, index) => index).some(index => !Object.hasOwn(value, index))) throw new Error('Unsupported JSON snapshot');
      return `[${value.map(child => canonicalJSON(child, depth + 1, ancestors)).join(',')}]`;
    }
    return `{${keys.sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key], depth + 1, ancestors)}`).join(',')}}`;
  } finally { ancestors.delete(value); }
}

function richPart(value) {
  if (!record(value) || !['text', 'mention', 'equation'].includes(value.type) || !record(value[value.type])) return false;
  if (Object.hasOwn(value, 'plain_text') && !text(value.plain_text) || Object.hasOwn(value, 'href') && value.href !== null && !text(value.href)) return false;
  if (Object.hasOwn(value, 'annotations')) {
    if (!record(value.annotations) || ['bold', 'italic', 'strikethrough', 'underline', 'code'].some(key => Object.hasOwn(value.annotations, key) && typeof value.annotations[key] !== 'boolean') ||
        Object.hasOwn(value.annotations, 'color') && !text(value.annotations.color)) return false;
  }
  if (value.type === 'text') return text(value.text.content) && (value.text.link === undefined || value.text.link === null || record(value.text.link) && text(value.text.link.url));
  if (value.type === 'equation') return text(value.equation.expression);
  const mention = value.mention;
  if (!['user', 'page', 'database', 'date', 'link_preview', 'template_mention', 'custom_emoji'].includes(mention.type) || !record(mention[mention.type])) return false;
  const part = mention[mention.type];
  if (['user', 'page', 'database', 'custom_emoji'].includes(mention.type)) return Boolean(uuid(part.id));
  if (mention.type === 'link_preview') return text(part.url);
  if (mention.type === 'date') return text(part.start) && ['end', 'time_zone'].every(key => !Object.hasOwn(part, key) || part[key] === null || text(part[key]));
  return part.type === 'template_mention_user' && part.template_mention_user === 'me' ||
    part.type === 'template_mention_date' && ['today', 'now'].includes(part.template_mention_date);
}

/** A content/revision tuple only. It cannot identify the human or application that wrote it. */
export async function fingerprintComment(comment) {
  try {
    if (!record(comment) || comment.object !== undefined && comment.object !== 'comment' || !uuid(comment.id) || !revision(comment.last_edited_time) ||
        !Array.isArray(comment.rich_text) || Object.hasOwn(comment, 'attachments') && (!Array.isArray(comment.attachments) || comment.attachments.length) ||
        Object.hasOwn(comment, 'has_pending_attachments') && comment.has_pending_attachments !== false) return null;
    const canonical = canonicalJSON(comment.rich_text);
    if (!comment.rich_text.every(richPart)) return null;
    return { commentId: uuid(comment.id), revision: comment.last_edited_time, hashVersion: 'notion-rich-text-v1', contentHash: await digest(canonical) };
  } catch { return null; }
}

/** An owner's exact acknowledged snapshot is diagnostic evidence, never causal writer proof. */
export async function postedReceipt(args, config) {
  const invalid = () => fail('Exact acknowledged comment snapshot required');
  if (!record(args) || Object.keys(args).length !== 2 || !Object.hasOwn(args, 'page_id') || !Object.hasOwn(args, 'comment') ||
      !uuid(args.page_id) || !Array.isArray(config?.pageIds) || !config.pageIds.length || config.pageIds.some(page => !uuid(page)) ||
      !config.pageIds.some(page => uuid(page) === uuid(args.page_id))) invalid();
  const fingerprint = await fingerprintComment(args.comment);
  if (!fingerprint) invalid();
  const parent = args.comment.parent;
  if (parent !== undefined && (!record(parent) || !(parent.type === 'page_id' && uuid(parent.page_id) === uuid(args.page_id) ||
      parent.type === 'block_id' && uuid(parent.block_id)))) invalid();
  let ack;
  try { canonicalJSON(args.comment); ack = JSON.stringify(args.comment); } catch { invalid(); }
  return { pageId: uuid(args.page_id), ...fingerprint, ack };
}
