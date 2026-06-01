// Image upload + public serve for the editor.
//
// Upload path is HMAC-gated (POST /v1/files/upload) — the web worker signs a
// base64 image payload and we store it in R2 under `editor/<uuid>.<ext>`.
// Serve path is PUBLIC (GET /files/*) so <img src> works without signing; it
// only ever reads keys under `editor/`.

const MAX_BYTES = 10 * 1024 * 1024; // ~10MB

const PUBLIC_BASE = 'https://editor-api.allenlabs.org/files/';

/** image/png → png, image/jpeg → jpg, image/svg+xml → svg, etc. */
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

export interface UploadInput {
  filename?: string;
  contentType: string;
  dataBase64: string;
}

export interface UploadResult {
  ok: true;
  url: string;
  key: string;
}

export type UploadError =
  | { ok: false; status: 400; error: 'not an image' }
  | { ok: false; status: 400; error: 'invalid base64' }
  | { ok: false; status: 413; error: 'too large' };

/** Decode a base64 string to bytes. Throws on malformed input. */
export function decodeBase64(b64: string): Uint8Array {
  const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Validate + decode an upload, returning bytes + the R2 key (or a typed error). */
export function prepareUpload(
  input: UploadInput,
  randomUUID: () => string,
): { bytes: Uint8Array; key: string; contentType: string } | UploadError {
  const ct = input.contentType.toLowerCase();
  const ext = EXT_BY_TYPE[ct];
  if (!ct.startsWith('image/') || !ext) {
    return { ok: false, status: 400, error: 'not an image' };
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(input.dataBase64);
  } catch {
    return { ok: false, status: 400, error: 'invalid base64' };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, status: 400, error: 'invalid base64' };
  }
  if (bytes.byteLength > MAX_BYTES) {
    return { ok: false, status: 413, error: 'too large' };
  }
  const key = `editor/${randomUUID()}.${ext}`;
  return { bytes, key, contentType: ct };
}

/** The public URL for a stored key. */
export function publicUrlFor(key: string): string {
  return PUBLIC_BASE + key;
}

/**
 * Pull the R2 key out of a `/files/...` request path. Returns null for
 * anything that isn't a safe key under `editor/` (no traversal, no other
 * prefixes).
 */
export function keyFromPath(pathname: string): string | null {
  const m = /^\/files\/(.+)$/.exec(pathname);
  if (!m) return null;
  const key = decodeURIComponent(m[1]!);
  if (!key.startsWith('editor/')) return null;
  if (key.includes('..') || key.includes('//')) return null;
  return key;
}
