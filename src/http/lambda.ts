// AWS Lambda handler for API Gateway HTTP API v2 ($default route).
// Routes to MCP, OAuth, and discovery endpoints. For /mcp, converts the APIGW event
// to a Fetch Request, runs the SDK's web-standard streamable HTTP transport in
// JSON-response mode (API Gateway buffers responses — SSE is a non-starter), and
// converts the Response back.
//
// Auth on /mcp: accepts either `x-api-key: <roo-key>` (what Claude Desktop/CLI uses
// today) OR `Authorization: Bearer <jwt>` where the JWT is a JWE whose payload
// contains the Roo API key (what ChatGPT uses after OAuth). Both paths resolve to a
// Roo API key that gets wired into the per-request MCP server.
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildServer } from '../server.js';
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
} from '../oauth/discovery.js';
import { handleRegister } from '../oauth/register.js';
import { handleAuthorizeGet, handleAuthorizePost } from '../oauth/authorize.js';
import { handleToken } from '../oauth/token.js';
import { decryptAccessToken, JWE_ISSUER } from '../oauth/jwe.js';

function unauthorizedMcp(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message:
          'Missing or invalid credentials. Send either "x-api-key: YOUR_ROO_KEY" or "Authorization: Bearer <token>" (get an OAuth token at ' +
          JWE_ISSUER +
          '/authorize).',
      },
      id: null,
    }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': `Bearer resource_metadata="${JWE_ISSUER}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}

function toRequest(event: APIGatewayProxyEventV2): Request {
  const method = event.requestContext.http.method;
  const scheme = event.headers['x-forwarded-proto'] ?? 'https';
  const host = event.headers['host'] ?? 'localhost';
  const path = event.rawPath || '/';
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const url = `${scheme}://${host}${path}${qs}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers)) {
    if (typeof v === 'string') headers.set(k, v);
  }

  const init: RequestInit = { method, headers };
  if (event.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = event.isBase64Encoded
      ? Uint8Array.from(Buffer.from(event.body, 'base64'))
      : event.body;
  }
  return new Request(url, init);
}

async function toApiGwResponse(res: Response): Promise<APIGatewayProxyStructuredResultV2> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const bodyText = await res.text();
  return { statusCode: res.status, headers, body: bodyText };
}

async function extractApiKey(event: APIGatewayProxyEventV2): Promise<string | null> {
  const auth = event.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    try {
      const payload = await decryptAccessToken(auth.slice(7).trim());
      return payload.rooApiKey;
    } catch {
      return null;
    }
  }
  const apiKey = event.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.length > 0) return apiKey;
  return null;
}

async function handleMcp(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const apiKey = await extractApiKey(event);
  if (!apiKey) return toApiGwResponse(unauthorizedMcp());

  const server = buildServer({ apiKey });
  const transport = new WebStandardStreamableHTTPServerTransport({
    // API Gateway buffers responses; MCP spec allows a single JSON body.
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(toRequest(event));
  return toApiGwResponse(response);
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const method = event.requestContext.http.method;
  const path = event.rawPath || '/';

  if (path === '/health') {
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    };
  }

  if (path === '/mcp') return handleMcp(event);

  // OAuth / discovery routes.
  if (path === '/.well-known/oauth-authorization-server' && method === 'GET') {
    return toApiGwResponse(authorizationServerMetadata());
  }
  if (path === '/.well-known/oauth-protected-resource' && method === 'GET') {
    return toApiGwResponse(protectedResourceMetadata());
  }
  if (path === '/register') return toApiGwResponse(await handleRegister(toRequest(event)));
  if (path === '/authorize' && method === 'GET') return toApiGwResponse(await handleAuthorizeGet(toRequest(event)));
  if (path === '/authorize' && method === 'POST') return toApiGwResponse(await handleAuthorizePost(toRequest(event)));
  if (path === '/token') return toApiGwResponse(await handleToken(toRequest(event)));

  return {
    statusCode: 404,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      error:
        'Not Found. Endpoints: /mcp, /health, /authorize, /token, /register, /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource.',
    }),
  };
};
