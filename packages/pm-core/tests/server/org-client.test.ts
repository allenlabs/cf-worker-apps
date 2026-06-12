import { describe, expect, it, vi } from 'vitest';
import {
  createTeam,
  inviteMember,
  listTeamMembers,
  removeMember,
  setMemberRole,
  signOrg,
  signedRequest,
} from '@allenlabs/pm-core/server/org-client';

const env = {
  AUTH_API_URL: 'https://auth-api.test',
  PM_ORG_HMAC_CLIENT_ID: 'pm',
  PM_ORG_HMAC_SECRET: 'test-org-hmac-secret-1234567890abcd',
};

function okFetcher(payload: unknown, capture?: (url: string, init: RequestInit) => void) {
  return vi.fn(async (url: string, init: RequestInit) => {
    capture?.(url, init);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('signOrg', () => {
  it('produces a deterministic base64 signature for a fixed ts+body', async () => {
    const a = await signOrg('secret', 1000, 'body');
    const b = await signOrg('secret', 1000, 'body');
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('changes when the timestamp or body changes', async () => {
    const base = await signOrg('secret', 1000, 'body');
    expect(await signOrg('secret', 1001, 'body')).not.toBe(base);
    expect(await signOrg('secret', 1000, 'other')).not.toBe(base);
  });
});

describe('signedRequest', () => {
  it('signs POST requests over the JSON body with the HMAC headers', async () => {
    let seenUrl = '';
    let seenInit: RequestInit = {};
    const fetcher = okFetcher({ ok: true }, (u, i) => {
      seenUrl = u;
      seenInit = i;
    });
    const out = await signedRequest(env, 'POST', '/sso/org/x', { a: 1 }, {
      fetcher,
      now: () => 12345,
    });
    expect(out).toEqual({ ok: true });
    expect(seenUrl).toBe('https://auth-api.test/sso/org/x');
    const headers = seenInit.headers as Record<string, string>;
    expect(headers['X-Client-Id']).toBe('pm');
    expect(headers['X-Timestamp']).toBe('12345');
    expect(headers['X-Signature']).toBe(
      await signOrg(env.PM_ORG_HMAC_SECRET, 12345, JSON.stringify({ a: 1 })),
    );
    expect(seenInit.body).toBe(JSON.stringify({ a: 1 }));
  });

  it('signs GET requests over an empty body and sends no body', async () => {
    let seenInit: RequestInit = {};
    const fetcher = okFetcher({ members: [] }, (_u, i) => {
      seenInit = i;
    });
    await signedRequest(env, 'GET', '/sso/org/team-members?teamId=t', undefined, {
      fetcher,
      now: () => 999,
    });
    expect(seenInit.body).toBeUndefined();
    const headers = seenInit.headers as Record<string, string>;
    expect(headers['X-Signature']).toBe(await signOrg(env.PM_ORG_HMAC_SECRET, 999, ''));
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('signs an empty-object body when POST body is null', async () => {
    let seenInit: RequestInit = {};
    const fetcher = okFetcher({ ok: true }, (_u, i) => {
      seenInit = i;
    });
    await signedRequest(env, 'POST', '/sso/org/x', null, { fetcher, now: () => 1 });
    expect(seenInit.body).toBe('{}');
  });

  it('strips a trailing slash from AUTH_API_URL', async () => {
    let seenUrl = '';
    const fetcher = okFetcher({ ok: true }, (u) => {
      seenUrl = u;
    });
    await signedRequest(
      { ...env, AUTH_API_URL: 'https://auth-api.test/' },
      'POST',
      '/sso/org/x',
      {},
      { fetcher, now: () => 1 },
    );
    expect(seenUrl).toBe('https://auth-api.test/sso/org/x');
  });

  it('throws with status + truncated body on non-2xx', async () => {
    const fetcher = vi.fn(async () =>
      new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(
      signedRequest(env, 'POST', '/sso/org/x', {}, { fetcher }),
    ).rejects.toThrow(/auth-api \/sso\/org\/x 500: boom/);
  });
});

describe('high-level helpers', () => {
  it('createTeam posts to /sso/org/create-team', async () => {
    let url = '';
    const fetcher = okFetcher({ teamId: 'team_1', slug: 'demo' }, (u) => {
      url = u;
    });
    const out = await createTeam(env, { actingUserId: 'u1', name: 'Demo', slug: 'demo' }, { fetcher });
    expect(out.teamId).toBe('team_1');
    expect(url).toContain('/sso/org/create-team');
  });

  it('inviteMember posts to /sso/org/invite', async () => {
    let url = '';
    const fetcher = okFetcher({ ok: true, invitationId: 'inv1', via: 'api' }, (u) => {
      url = u;
    });
    const out = await inviteMember(
      env,
      { actingUserId: 'u1', teamId: 't1', email: 'a@b.com', role: 'viewer' },
      { fetcher },
    );
    expect(out.invitationId).toBe('inv1');
    expect(url).toContain('/sso/org/invite');
  });

  it('setMemberRole posts to /sso/org/set-member-role', async () => {
    let url = '';
    const fetcher = okFetcher({ ok: true, userId: 'u2', role: 'maintainer' }, (u) => {
      url = u;
    });
    const out = await setMemberRole(
      env,
      { actingUserId: 'u1', teamId: 't1', targetUserId: 'u2', role: 'maintainer' },
      { fetcher },
    );
    expect(out.role).toBe('maintainer');
    expect(url).toContain('/sso/org/set-member-role');
  });

  it('removeMember posts to /sso/org/remove-member', async () => {
    let url = '';
    const fetcher = okFetcher({ ok: true, userId: 'u2' }, (u) => {
      url = u;
    });
    const out = await removeMember(env, { actingUserId: 'u1', teamId: 't1', targetUserId: 'u2' }, { fetcher });
    expect(out.userId).toBe('u2');
    expect(url).toContain('/sso/org/remove-member');
  });

  it('listTeamMembers GETs /sso/org/team-members with the teamId query', async () => {
    let url = '';
    const fetcher = okFetcher(
      { members: [{ userId: 'u', email: 'e', name: null, username: null, preferredName: null, role: 'owner' }], invitations: [] },
      (u) => {
        url = u;
      },
    );
    const out = await listTeamMembers(env, 'team with space', { fetcher });
    expect(out.members).toHaveLength(1);
    expect(url).toContain('/sso/org/team-members?teamId=team%20with%20space');
  });
});
