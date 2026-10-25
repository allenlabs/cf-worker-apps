import { publicOrigin } from '../../../mcp-events/workers/api/protocol.js';

export const SCOPE = 'notion:events';

// Scheduled grant checks need valid SDK handlers without importing the HTTP router.
const unusedHandler = { fetch: () => new Response(null, { status: 404 }) };
export const oauthOptions = (env, { apiHandler = unusedHandler, defaultHandler = unusedHandler } = {}) => ({
  apiRoute: '/mcp', apiHandler, defaultHandler,
  authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
  scopesSupported: [SCOPE], requiredScopes: [SCOPE], accessTokenTTL: 3600, refreshTokenTTL: 30 * 86400,
  resourceMetadata: { resource: `${publicOrigin(env)}/mcp`, authorization_servers: [publicOrigin(env)] },
  clientIdMetadataDocumentEnabled: true, onError: () => {}
});
