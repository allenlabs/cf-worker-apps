import { isIP } from 'node:net';
import { encoder, callbackUrl, bodyText, fail } from '../../../mcp-events/workers/api/protocol.js';

export function archivePage(text, cursor = '0', limit = 32768) {
  if (typeof cursor !== 'string' || !/^(0|[1-9]\d*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) fail('Invalid archive cursor');
  if (!Number.isSafeInteger(limit) || limit < 32 || limit > 65536) fail('Archive limit must be 32–65536 bytes');
  const bytes = encoder.encode(text), start = Number(cursor);
  if (start > bytes.length || (bytes[start] & 0xc0) === 0x80) fail('Invalid archive cursor');
  let end = Math.min(bytes.length, start + limit);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return { cursor, next_cursor: end < bytes.length ? String(end) : null, total_bytes: bytes.length, encoding: 'utf-8', text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start, end)) };
}

function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes('.')) return false;
  const [first, second] = address.toLowerCase().split(':').map(value => parseInt(value || '0', 16));
  // Accept global unicast only; reject special-purpose, documentation and transition ranges.
  return (first & 0xe000) === 0x2000 && first !== 0x2002 && !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) && first !== 0x3fff;
}

export async function verifyCallbackDestination(value, fetcher = fetch) {
  const url = callbackUrl(value);
  const host = new URL(url).hostname;
  const results = await Promise.all(['A', 'AAAA'].map(async type => {
    const resolver = new URL('https://cloudflare-dns.com/dns-query');
    resolver.searchParams.set('name', host);
    resolver.searchParams.set('type', type);
    const response = await fetcher(resolver.href, { headers: { Accept: 'application/dns-json' }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Callback DNS lookup failed');
    const result = JSON.parse(await bodyText(response, 65536));
    if (result.Status !== 0 || result.TC === true || (result.Answer !== undefined && !Array.isArray(result.Answer))) throw new Error('Callback DNS answer is invalid');
    return (result.Answer ?? []).filter(answer => answer.type === 1 || answer.type === 28).map(answer => {
      if (typeof answer.data !== 'string' || !publicAddress(answer.data) || isIP(answer.data) !== (answer.type === 1 ? 4 : 6)) throw new Error('Callback DNS address is not public');
      return answer.data;
    });
  }));
  if (!results.flat().length) throw new Error('Callback DNS has no public addresses');
  return url;
}
