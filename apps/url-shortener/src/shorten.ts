// Pure shorten/lookup logic — testable without Hono / wrangler.
import { customAlphabet } from 'nanoid';

// Avoid ambiguous glyphs (0/O, 1/l/I).
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';

export interface LinkRecord {
  url: string;
  createdAt: number;
  ownerEmail?: string;
  clicks: number;
}

export class ShortenError extends Error {}

export async function shortenImpl(opts: {
  kv: KVNamespace;
  url: string;
  ownerEmail?: string;
  codeLength: number;
  customCode?: string;
}): Promise<{ code: string; url: string }> {
  if (!/^https?:\/\//.test(opts.url)) {
    throw new ShortenError('URL must start with http:// or https://');
  }
  try {
    new URL(opts.url);
  } catch {
    throw new ShortenError('URL is not parseable.');
  }

  const code = await mintCode(opts.kv, {
    length: opts.codeLength,
    custom: opts.customCode,
  });
  const record: LinkRecord = {
    url: opts.url,
    createdAt: Date.now(),
    ownerEmail: opts.ownerEmail,
    clicks: 0,
  };
  await opts.kv.put(code, JSON.stringify(record));
  return { code, url: opts.url };
}

export async function resolveImpl(
  kv: KVNamespace,
  code: string,
): Promise<LinkRecord | null> {
  const raw = await kv.get(code);
  if (!raw) return null;
  return JSON.parse(raw) as LinkRecord;
}

export async function incrementClicks(kv: KVNamespace, code: string): Promise<void> {
  const record = await resolveImpl(kv, code);
  if (!record) return;
  record.clicks += 1;
  await kv.put(code, JSON.stringify(record));
}

async function mintCode(
  kv: KVNamespace,
  opts: { length: number; custom?: string },
): Promise<string> {
  if (opts.custom) {
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(opts.custom)) {
      throw new ShortenError(
        'Custom code must be 3–32 chars of [A-Za-z0-9_-].',
      );
    }
    const existing = await kv.get(opts.custom);
    if (existing) throw new ShortenError(`Code "${opts.custom}" already in use.`);
    return opts.custom;
  }
  const nano = customAlphabet(ALPHABET, opts.length);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = nano();
    if (!(await kv.get(code))) return code;
  }
  throw new ShortenError('Failed to mint a unique short code; KV is unusually full.');
}
