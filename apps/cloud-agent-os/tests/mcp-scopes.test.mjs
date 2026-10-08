import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configuredOAuthScope } from '../overlay/packages/mcp-shared/src/oauth-scope.ts';

test('MCP OAuth scopes match the whole endpoint without borrowing scopes from another path', () => {
  const raw = JSON.stringify({ 'https://mcp.example.com/team/mcp': ['openid', 'example.read'] });
  assert.equal(configuredOAuthScope(raw, 'https://mcp.example.com/team/mcp'), 'openid example.read');
  assert.equal(configuredOAuthScope(raw, 'https://mcp.example.com/other/mcp'), undefined);
  assert.equal(configuredOAuthScope(raw, 'https://mcp.example.com/team/mcp/'), undefined);
  assert.equal(configuredOAuthScope(undefined, 'https://mcp.example.com/team/mcp'), undefined);
});

test('bad OAuth scope policy fails instead of falling back to server-advertised write scopes', () => {
  for (const value of [null, [], {},
    { 'https://mcp.example.com/team/mcp': [] },
    { 'https://mcp.example.com/team/mcp': ['read', 'read'] },
    { 'https://mcp.example.com/team/mcp': ['read write'] },
    { 'https://mcp.example.com/team/mcp': [7] },
    { 'http://mcp.example.com/team/mcp': ['read'] },
    { 'https://user:secret@mcp.example.com/team/mcp': ['read'] },
    { 'https://mcp.example.com/team/mcp#fragment': ['read'] },
  ]) assert.throws(() => configuredOAuthScope(JSON.stringify(value), 'https://mcp.example.com/team/mcp'));
  assert.throws(() => configuredOAuthScope('{broken', 'https://mcp.example.com/team/mcp'));
});
