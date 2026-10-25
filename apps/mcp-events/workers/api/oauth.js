import { AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';
import { bodyText, equal } from './protocol.js';

const escape = value => String(value).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

export async function ownerConsent(request, env, { scope, productName, description, metadata }) {
  if (!env.OWNER_LOGIN_KEY || env.OWNER_LOGIN_KEY.length < 32) return new Response('Owner sign-in is not configured', { status: 503 });
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      if (!details.scope.includes(scope) || details.scope.some(value => value !== scope)) return new Response('Unsupported access scope', { status: 400 });
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(productName)} access</title><body><h1>Connect ${escape(productName)}</h1><p>Client: <strong>${escape(details.clientName)}</strong>${details.clientDomain ? `, published by ${escape(details.clientDomain)}` : ' (self-registered name)'}</p><p>Access returns to <strong>${escape(details.redirectHost)}</strong>.</p>${details.redirectIsLoopback ? '<p>This sends access to an app on your computer. Continue only if you started this sign-in.</p>' : ''}<p>Scope: ${escape(details.scope.join(' '))}. ${escape(description)}</p><form method="post"><input type="hidden" name="handle" value="${escape(consent.handle)}"><label>Owner access key <input name="owner_key" type="password" autocomplete="off" required maxlength="256"></label><p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny" formnovalidate>Deny</button></p></form></body></html>`, { headers: consent.headers });
    }
    if (request.method === 'POST') {
      const form = new URLSearchParams(await bodyText(request, 16384));
      const handle = form.get('handle') ?? '';
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        denied.headers.set('Location', denied.redirectTo);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const key = form.get('owner_key') ?? '';
      if (key.length > 256 || !await equal(key, env.OWNER_LOGIN_KEY)) return new Response('Invalid owner access key. Restart connection.', { status: 401 });
      const approved = await oauth.approveConsent(request, handle, { scope: [scope] });
      const { redirectTo } = await oauth.completeAuthorization({ request: approved.request, userId: env.OAUTH_OWNER_ID, scope: [scope], metadata, props: { userId: env.OAUTH_OWNER_ID } });
      approved.headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    return new Response(null, { status: 405 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) return new Response('Authorization expired or invalid. Restart connection.', { status: 400 });
    return new Response('Authorization unavailable', { status: 500 });
  }
}
