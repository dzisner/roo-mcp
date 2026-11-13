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
import {
  decryptAccessToken,
  JWE_ISSUER,
  MCP_REQUIRED_SCOPE,
  scopeIncludes,
} from '../oauth/jwe.js';
import { rateLimit } from '../oauth/grants.js';

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

// 405 for anything that isn't POST on /mcp. We run the transport in
// enableJsonResponse mode, so GET (SSE) is not supported — rejecting it here
// gives a clean, machine-readable response instead of whatever the transport
// would say. RFC 7231 §6.5.5 requires the Allow header on 405.
function methodNotAllowedMcp(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32600,
        message:
          'Only POST is allowed on /mcp. This server runs in JSON-response mode and does not support SSE streaming (GET).',
      },
      id: null,
    }),
    {
      status: 405,
      headers: {
        'content-type': 'application/json',
        allow: 'POST',
      },
    },
  );
}

// 403 for tokens that decrypt but don't carry the scope /mcp requires. RFC 6750
// §3.1 says to use `insufficient_scope` and advertise the required scope so the
// client knows what to ask for on its next /authorize.
function forbiddenInsufficientScope(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message:
          `Token lacks the required scope. Request "${MCP_REQUIRED_SCOPE}" at /authorize and try again.`,
      },
      id: null,
    }),
    {
      status: 403,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': `Bearer error="insufficient_scope", scope="${MCP_REQUIRED_SCOPE}", resource_metadata="${JWE_ISSUER}/.well-known/oauth-protected-resource"`,
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

// Outcome of auth on /mcp:
//   ok              → go serve the MCP request with the resolved Roo key
//   unauthenticated → 401, send client back through OAuth
//   insufficient_scope → 403, the token decrypts but doesn't carry mcp:all
type McpAuth =
  | { kind: 'ok'; apiKey: string }
  | { kind: 'unauthenticated' }
  | { kind: 'insufficient_scope' };

async function authenticateMcp(event: APIGatewayProxyEventV2): Promise<McpAuth> {
  const auth = event.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    try {
      const payload = await decryptAccessToken(auth.slice(7).trim());
      // F01 scope check. The token's `aud` was already verified by
      // decryptAccessToken (it binds the token to this /mcp resource).
      if (!scopeIncludes(payload.scope, MCP_REQUIRED_SCOPE)) {
        return { kind: 'insufficient_scope' };
      }
      return { kind: 'ok', apiKey: payload.rooApiKey };
    } catch {
      return { kind: 'unauthenticated' };
    }
  }
  // Legacy direct-key path (Claude Desktop/CLI). No OAuth scope to check — the
  // bearer IS the Roo API key.
  const apiKey = event.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    return { kind: 'ok', apiKey };
  }
  return { kind: 'unauthenticated' };
}

async function handleMcp(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  // F01: only POST is valid on /mcp. Rejecting other methods (GET, HEAD, PUT,
  // DELETE, OPTIONS, etc.) here means the auth path and the transport only ever
  // see requests they are built to handle.
  if (event.requestContext.http.method !== 'POST') {
    return toApiGwResponse(methodNotAllowedMcp());
  }
  const auth = await authenticateMcp(event);
  if (auth.kind === 'unauthenticated') return toApiGwResponse(unauthorizedMcp());
  if (auth.kind === 'insufficient_scope') return toApiGwResponse(forbiddenInsufficientScope());

  const server = buildServer({ apiKey: auth.apiKey });
  const transport = new WebStandardStreamableHTTPServerTransport({
    // API Gateway buffers responses; MCP spec allows a single JSON body.
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(toRequest(event));
  return toApiGwResponse(response);
}

// Pick a client identifier for rate limiting. API Gateway's $default route exposes
// the source IP via requestContext.http.sourceIp, and (if the upstream is Cloudflare
// or similar) x-forwarded-for carries the real client. Prefer the first IP in that
// list so a single abuser behind a CDN can still be limited independently; fall
// back to sourceIp when nothing is forwarded.
function clientIp(event: APIGatewayProxyEventV2): string {
  const xff = event.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return event.requestContext.http.sourceIp ?? 'unknown';
}

interface LimitSpec {
  bucket: string;
  limit: number;
  windowSeconds: number;
}

function tooManyRequests(retryAfter: number): APIGatewayProxyStructuredResultV2 {
  // Keep the body minimal and generic. OAuth clients retry on 429 with a cap;
  // we just need to give them the Retry-After hint.
  return {
    statusCode: 429,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'retry-after': String(Math.max(1, retryAfter)),
    },
    body: JSON.stringify({
      error: 'slow_down',
      error_description: 'Too many requests. Try again shortly.',
    }),
  };
}

async function enforceLimit(spec: LimitSpec): Promise<APIGatewayProxyStructuredResultV2 | null> {
  try {
    const result = await rateLimit(spec);
    return result.ok ? null : tooManyRequests(result.retryAfter);
  } catch (err) {
    // Fail open. If DDB is down, we'd rather take the hit than start 429ing
    // legitimate OAuth flows. The error still goes to CloudWatch for alerting.
    process.stderr.write(
      JSON.stringify({ evt: 'rate_limit_backend_error', msg: String(err instanceof Error ? err.message : err) }) + '\n',
    );
    return null;
  }
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const method = event.requestContext.http.method;
  const path = event.rawPath || '/';

  if (path === '/health') {
    // F10 (Wave 8): surface the package version + build SHA so a client can
    // tell exactly which build is live without reading CloudWatch. Both are
    // injected by the deploy workflow from package.json + github.sha; unset
    // in local runs shows 'unknown'.
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({
        ok: true,
        version: process.env.ROO_MCP_VERSION ?? 'unknown',
        sha: process.env.ROO_MCP_BUILD_SHA ?? 'unknown',
      }),
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
  // Rate limits on the auth plane (F08). Numbers are per-IP, per-60s. They are
  // deliberately generous for real users (who click through /authorize once)
  // and deliberately cheap for attackers (who need thousands of tries to be
  // useful). Adjust in one place if abuse shifts the shape.
  const ip = clientIp(event);

  // Dynamic Client Registration is unauthenticated and stateless; nothing stops
  // one IP from generating a million client_ids and burning CPU/log volume.
  // Cap it tight — honest clients register once.
  if (path === '/register') {
    const throttled = await enforceLimit({ bucket: `register:${ip}`, limit: 10, windowSeconds: 60 });
    if (throttled) return throttled;
    return toApiGwResponse(await handleRegister(toRequest(event)));
  }

  if (path === '/authorize' && method === 'GET') {
    const throttled = await enforceLimit({ bucket: `authorize_get:${ip}`, limit: 30, windowSeconds: 60 });
    if (throttled) return throttled;
    return toApiGwResponse(await handleAuthorizeGet(toRequest(event)));
  }
  if (path === '/authorize' && method === 'POST') {
    // POST hits the Roo API to validate the key, so it's the expensive path.
    const throttled = await enforceLimit({ bucket: `authorize_post:${ip}`, limit: 10, windowSeconds: 60 });
    if (throttled) return throttled;
    return toApiGwResponse(await handleAuthorizePost(toRequest(event)));
  }
  if (path === '/token') {
    const throttled = await enforceLimit({ bucket: `token:${ip}`, limit: 30, windowSeconds: 60 });
    if (throttled) return throttled;
    return toApiGwResponse(await handleToken(toRequest(event)));
  }

  return {
    statusCode: 404,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      error:
        'Not Found. Endpoints: /mcp, /health, /authorize, /token, /register, /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource.',
    }),
  };
};
