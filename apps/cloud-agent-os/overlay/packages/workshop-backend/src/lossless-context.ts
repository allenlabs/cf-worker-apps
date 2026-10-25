/** The caller supplies a synchronous, atomic store scoped to its authorized workspace. */
export interface LosslessTextStore {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  transaction<T>(callback: () => T): T;
}

import type { TextArtifactRef, TextArtifactPage } from '@gadgets/workshop-shared/api';
export type { TextArtifactRef, TextArtifactPage } from '@gadgets/workshop-shared/api';

export type TextArtifactReadOptions = { cursor?: string; maxBytes?: number };

const CHUNK_BYTES = 32 * 1024;
const PAGE_BYTES = 8 * 1024;
const encoder = new TextEncoder();
const digestPattern = /^[a-f0-9]{64}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const lowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const highSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

type ChunkInfo = { start: number; chars: number; bytes: number; sha256: string };
type Manifest = { version: 1; chatId: number; id: string; sha256: string; chars: number; bytes: number; chunks: ChunkInfo[] };
type Cursor = { version: 1; chatId: number; artifactId: string; offset: number };

function requireChatId(chatId: number) {
  if (!natural(chatId)) throw new Error('Invalid text artifact chat ID');
}

function requireUnicode(text: string) {
  if (typeof text !== 'string') throw new Error('Text artifact must contain a string');
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (highSurrogate(code)) {
      if (!lowSurrogate(text.charCodeAt(++i))) throw new Error('Text artifact requires well-formed Unicode');
    } else if (lowSurrogate(code)) throw new Error('Text artifact requires well-formed Unicode');
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

const keyPrefix = (chatId: number, id: string) => `chat-text:${chatId}:${id}:`;
const cursorAt = (chatId: number, artifactId: string, offset: number) =>
  JSON.stringify({ version: 1, chatId, artifactId, offset } satisfies Cursor);
const reference = (manifest: Manifest): TextArtifactRef => ({
  id: manifest.id, sha256: manifest.sha256, chars: manifest.chars, bytes: manifest.bytes,
  startCursor: cursorAt(manifest.chatId, manifest.id, 0),
});

function requireManifest(value: unknown, chatId: number, id: string): Manifest {
  if (!record(value) || value.version !== 1 || value.chatId !== chatId || value.id !== id || value.sha256 !== id ||
      !natural(value.chars) || !natural(value.bytes) || !Array.isArray(value.chunks) || value.chunks.length > value.chars) {
    throw new Error('Text artifact manifest is corrupt');
  }
  let chars = 0, bytes = 0;
  for (const chunk of value.chunks) {
    if (!record(chunk) || chunk.start !== chars || !natural(chunk.chars) || chunk.chars === 0 ||
        !natural(chunk.bytes) || chunk.bytes < chunk.chars || chunk.bytes > CHUNK_BYTES || chunk.bytes > chunk.chars * 3 ||
        typeof chunk.sha256 !== 'string' || !digestPattern.test(chunk.sha256)) {
      throw new Error('Text artifact chunk manifest is corrupt');
    }
    chars += chunk.chars;
    bytes += chunk.bytes;
  }
  if (chars !== value.chars || bytes !== value.bytes) throw new Error('Text artifact manifest totals are corrupt');
  return value as Manifest;
}

/**
 * Content-addressed originals have no expiry and are never replaced by a preview or summary.
 * All hashes are computed before the synchronous transaction; chunks and manifest commit together.
 * Keys use `chat-text:<chatId>:` so explicit chat deletion can remove the entire archive.
 */
export async function archiveText(store: LosslessTextStore, chatId: number, text: string,
    onCommit?: (reference: TextArtifactRef) => void): Promise<TextArtifactRef> {
  requireChatId(chatId);
  requireUnicode(text);
  const chunks: string[] = [];
  let start = 0, bytes = 0, jsonBytes = 2;
  for (let i = 0; i < text.length;) {
    const point = text.codePointAt(i)!;
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    // Typed stores serialize strings as JSON: control characters can expand sixfold.
    // Bound both the original UTF-8 and its serialized storage representation.
    const jsonSize = point <= 0x1f ? 6 : point === 0x22 || point === 0x5c ? 2 : size;
    if (bytes + size > CHUNK_BYTES || jsonBytes + jsonSize > CHUNK_BYTES) {
      chunks.push(text.slice(start, i));
      start = i;
      bytes = 0;
      jsonBytes = 2;
    }
    bytes += size;
    jsonBytes += jsonSize;
    i += point > 0xffff ? 2 : 1;
  }
  if (start < text.length) chunks.push(text.slice(start));
  const id = await sha256(text);
  const hashes = await Promise.all(chunks.map(chunk => sha256(chunk)));
  let offset = 0;
  const manifest: Manifest = { version: 1, chatId, id, sha256: id, chars: text.length,
    bytes: encoder.encode(text).byteLength, chunks: chunks.map((chunk, index) => {
      const info = { start: offset, chars: chunk.length, bytes: encoder.encode(chunk).byteLength, sha256: hashes[index] };
      offset += chunk.length;
      return info;
    }) };
  const prefix = keyPrefix(chatId, id);
  store.transaction(() => {
    const existing = store.get(`${prefix}manifest`);
    if (existing !== undefined) {
      const saved = requireManifest(existing, chatId, id);
      if (JSON.stringify(saved) !== JSON.stringify(manifest) || chunks.some((chunk, index) => store.get(`${prefix}chunk:${index}`) !== chunk)) {
        throw new Error('Existing text artifact is missing data or failed integrity validation');
      }
      onCommit?.(reference(manifest));
      return;
    }
    chunks.forEach((chunk, index) => store.put(`${prefix}chunk:${index}`, chunk));
    store.put(`${prefix}manifest`, manifest);
    onCommit?.(reference(manifest));
  });
  return reference(manifest);
}

/**
 * Return a complete JSON-serializable envelope, even when the original is itself large JSON.
 * `content` is a text fragment; concatenate pages before parsing the original. Limits include
 * JSON escaping and metadata. Cursors are chat/content-bound UTF-16 offsets at scalar boundaries.
 */
export async function readTextArtifact(store: LosslessTextStore, chatId: number, artifactId: string,
    options: TextArtifactReadOptions = {}): Promise<TextArtifactPage> {
  requireChatId(chatId);
  if (typeof artifactId !== 'string' || !digestPattern.test(artifactId)) throw new Error('Invalid text artifact ID');
  const maxBytes = options.maxBytes ?? PAGE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > PAGE_BYTES) throw new Error('Text artifact page limit must be 1024–8192 bytes');
  const prefix = keyPrefix(chatId, artifactId);
  const saved = store.get(`${prefix}manifest`);
  if (saved === undefined) throw new Error('Text artifact not found in this chat');
  const manifest = requireManifest(saved, chatId, artifactId);
  const cursor = options.cursor ?? cursorAt(chatId, artifactId, 0);
  let parsed: unknown;
  try {
    if (typeof cursor !== 'string' || cursor.length > 512) throw new Error();
    parsed = JSON.parse(cursor);
  } catch { throw new Error('Invalid text artifact cursor'); }
  if (!record(parsed) || parsed.version !== 1 || parsed.chatId !== chatId || parsed.artifactId !== artifactId ||
      !natural(parsed.offset) || parsed.offset > manifest.chars || Object.keys(parsed).length !== 4) {
    throw new Error('Text artifact cursor does not match this chat, artifact, or range');
  }
  const start = parsed.offset;
  const wantedEnd = Math.min(manifest.chars, start + maxBytes);
  let candidate = '';
  for (let index = 0; index < manifest.chunks.length; index++) {
    const info = manifest.chunks[index];
    if (info.start + info.chars <= start) continue;
    if (info.start >= wantedEnd) break;
    const chunk = store.get(`${prefix}chunk:${index}`);
    if (typeof chunk !== 'string') throw new Error('Text artifact chunk is missing or corrupt');
    requireUnicode(chunk);
    if (chunk.length !== info.chars || encoder.encode(chunk).byteLength !== info.bytes || await sha256(chunk) !== info.sha256) {
      throw new Error('Text artifact chunk failed integrity validation');
    }
    const localStart = Math.max(0, start - info.start);
    if (lowSurrogate(chunk.charCodeAt(localStart))) throw new Error('Text artifact cursor splits a Unicode character');
    let localEnd = Math.min(chunk.length, wantedEnd - info.start);
    if (highSurrogate(chunk.charCodeAt(localEnd - 1))) --localEnd;
    candidate += chunk.slice(localStart, localEnd);
  }
  const pageAt = (chars: number): TextArtifactPage => {
    const end = start + chars;
    const eof = end === manifest.chars;
    return { artifactId, sha256: manifest.sha256, totalChars: manifest.chars, totalBytes: manifest.bytes,
      cursor, start, end, content: candidate.slice(0, chars),
      nextCursor: eof ? null : cursorAt(chatId, artifactId, end), eof };
  };
  let page = pageAt(candidate.length);
  if (encoder.encode(JSON.stringify(page)).byteLength <= maxBytes && (page.eof || candidate.length > 0)) return page;
  let lower = 0, upper = candidate.length, best = 0;
  while (lower <= upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    const chars = highSurrogate(candidate.charCodeAt(midpoint - 1)) ? midpoint - 1 : midpoint;
    const proposed = pageAt(chars);
    if (encoder.encode(JSON.stringify(proposed)).byteLength <= maxBytes) {
      best = chars;
      lower = midpoint + 1;
    } else upper = midpoint - 1;
  }
  page = pageAt(best);
  if (!page.eof && best === 0) throw new Error('Text artifact page limit cannot fit the next character');
  if (encoder.encode(JSON.stringify(page)).byteLength > maxBytes) throw new Error('Text artifact page limit cannot fit metadata');
  return page;
}
