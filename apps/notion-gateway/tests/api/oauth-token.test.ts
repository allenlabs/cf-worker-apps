import { describe, expect, it } from 'vitest';
import { signRequest, verifyRequest } from '@shared/crypto';
import { oauthStartTokenImpl } from '../../workers/api/src/handlers/oauth';

describe('oauthStartTokenImpl', () => {
  it('returns a URL whose `sig` re-verifies against the consumer-app payload', async () => {
    const appClient = {
      id: 7,
      clientId: 'pm',
      name: 'PM',
      hmacSecret: 'secret-xyz',
      allowedReturnOrigins: ['https://x.example'],
    };
    const out = await oauthStartTokenImpl(
      appClient,
      'https://notion.allen.company/',
      { app_resource: 'project/42', return_to: 'https://x.example/back' },
    );
    expect(out.start_url.startsWith('https://notion.allen.company/oauth/start?')).toBe(true);

    const url = new URL(out.start_url);
    expect(url.searchParams.get('app')).toBe('pm');
    expect(url.searchParams.get('resource')).toBe('project/42');
    expect(url.searchParams.get('return_to')).toBe('https://x.example/back');

    const sig = url.searchParams.get('sig')!;
    // The /oauth/start route re-computes the signature with the same
    // payload + timestamp=0.  This test mirrors that path.
    const expected = await signRequest(
      'secret-xyz',
      `7\nproject/42\nhttps://x.example/back`,
      0,
    );
    expect(sig).toBe(expected);
    // verifyRequest with timestamp=0 falls within the default skew window
    // for unit tests in 1970-distant epochs — but for completeness we
    // re-derive and compare directly instead.
    expect(typeof sig).toBe('string');
    expect(sig.length).toBeGreaterThan(20);
    // verifyRequest path with the same secret+payload should accept.
    expect(
      await verifyRequest(
        appClient.hmacSecret,
        `7\nproject/42\nhttps://x.example/back`,
        0,
        sig,
        Number.MAX_SAFE_INTEGER,
      ),
    ).toBe(true);
  });

  it('handles publicBaseUrl with no trailing slash', async () => {
    const appClient = {
      id: 1,
      clientId: 'a',
      name: 'A',
      hmacSecret: 's',
      allowedReturnOrigins: [],
    };
    const out = await oauthStartTokenImpl(
      appClient,
      'https://example.com',
      { app_resource: 'r', return_to: 'https://r' },
    );
    expect(out.start_url.startsWith('https://example.com/oauth/start?')).toBe(true);
  });
});
