// OAuth 2.1 / MCP spec discovery documents.
//
// Two docs:
//   /.well-known/oauth-authorization-server (RFC 8414) — tells clients where our
//     authorize/token/register endpoints live.
//   /.well-known/oauth-protected-resource (RFC 9728, per MCP spec 2025-11-25) — tells
//     clients which auth server protects the /mcp resource.
//
// Both are read-only, cacheable JSON; same across all requests.
import { JWE_ISSUER } from './jwe.js';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // 10 min cache — spec says these can be cached. Not aggressive; room to iterate.
      'cache-control': 'public, max-age=600',
    },
  });
}

export function authorizationServerMetadata(): Response {
  return json({
    issuer: JWE_ISSUER,
    authorization_endpoint: `${JWE_ISSUER}/authorize`,
    token_endpoint: `${JWE_ISSUER}/token`,
    registration_endpoint: `${JWE_ISSUER}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp:all'],
    service_documentation: 'https://github.com/dzisner/roo-mcp',
  });
}

export function protectedResourceMetadata(): Response {
  return json({
    resource: `${JWE_ISSUER}/mcp`,
    authorization_servers: [JWE_ISSUER],
    scopes_supported: ['mcp:all'],
    bearer_methods_supported: ['header'],
  });
}
