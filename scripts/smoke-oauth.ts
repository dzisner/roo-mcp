// Local end-to-end OAuth smoke test.
//
// Invokes the Lambda handler in-process with fake APIGW events, walking the full
// OAuth 2.1 flow against the shim:
//   1. DCR          → client_id
//   2. GET /authorize → form renders with the correct client name
//   3. POST /authorize → mints auth code, 302s back to redirect_uri
//   4. POST /token   → exchanges code (with PKCE verifier) for access + refresh
//   5. POST /mcp with Bearer → initialize + tools/list succeed
//   6. POST /token refresh_token → mints a fresh pair
//
// Requires ROO_API_KEY in env or .env. Generates a transient JWE key if
// ROO_MCP_JWE_SECRET isn't set — fine for one-shot local tests.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Set env BEFORE importing the handler (jwe.ts reads these at module init).
process.env.ROO_MCP_JWE_KEY ??= randomBytes(32).toString('base64');
process.env.ROO_MCP_ISSUER ??= 'http://localhost';

const { handler } = await import('../src/http/lambda.js');
type Event = Parameters<typeof handler>[0];
type Result = Awaited<ReturnType<typeof handler>>;

function loadRooApiKey(): string {
  const env = process.env.ROO_API_KEY;
  if (env) return env;
  try {
    const dotenv = readFileSync('.env', 'utf8');
    const m = dotenv.match(/^ROO_API_KEY=(.+)$/m);
    if (m?.[1]) return m[1].trim();
  } catch {
    /* no .env file */
  }
  console.error('ROO_API_KEY is required (set in env or .env).');
  process.exit(1);
}

interface MakeEventOpts {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  queryString?: string;
}

function makeEvent({
  method,
  path,
  headers = {},
  body,
  queryString = '',
}: MakeEventOpts): Event {
  const now = Date.now();
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: queryString,
    headers: {
      host: 'localhost',
      'x-forwarded-proto': 'http',
      ...headers,
    },
    requestContext: {
      accountId: '000000000000',
      apiId: 'local',
      domainName: 'localhost',
      domainPrefix: 'local',
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'smoke-oauth',
      },
      requestId: 'req',
      routeKey: '$default',
      stage: '$default',
      time: new Date(now).toISOString(),
      timeEpoch: now,
    },
    isBase64Encoded: false,
    ...(body !== undefined ? { body } : {}),
  } as Event;
}

function expectStatus(label: string, resp: Result, expected: number): void {
  if (resp.statusCode !== expected) {
    console.error(`[FAIL] ${label}: expected ${expected}, got ${resp.statusCode}`);
    console.error('  body:', resp.body?.slice(0, 500));
    process.exit(1);
  }
  console.log(`[OK]   ${label}: ${resp.statusCode}`);
}

async function main(): Promise<void> {
  const rooApiKey = loadRooApiKey();
  const REDIRECT_URI = 'http://localhost:9999/callback';
  const CLIENT_NAME = 'SmokeTest';

  // 1. Dynamic Client Registration
  const regResp = await handler(
    makeEvent({
      method: 'POST',
      path: '/register',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT_URI],
        client_name: CLIENT_NAME,
        token_endpoint_auth_method: 'none',
      }),
    }),
  );
  expectStatus('register', regResp, 201);
  const regBody = JSON.parse(regResp.body ?? '{}') as { client_id: string };
  const { client_id: clientId } = regBody;
  console.log(`       client_id length: ${clientId.length}`);

  // 2. Generate PKCE
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  // 3. GET /authorize
  const authQuery = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'opaque-state',
    scope: 'mcp:all',
  }).toString();
  const authGet = await handler(
    makeEvent({ method: 'GET', path: '/authorize', queryString: authQuery }),
  );
  expectStatus('authorize GET', authGet, 200);
  if (!authGet.body?.includes(CLIENT_NAME)) {
    console.error('[FAIL] authorize page did not render the client name');
    process.exit(1);
  }
  console.log('[OK]   authorize page renders client name');

  // 4. POST /authorize
  const authPost = await handler(
    makeEvent({
      method: 'POST',
      path: '/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'opaque-state',
        scope: 'mcp:all',
        api_key: rooApiKey,
      }).toString(),
    }),
  );
  expectStatus('authorize POST', authPost, 302);
  const location = authPost.headers?.['location'] ?? authPost.headers?.['Location'];
  if (typeof location !== 'string') {
    console.error('[FAIL] no Location header on authorize redirect');
    process.exit(1);
  }
  const code = new URL(location).searchParams.get('code');
  if (!code) {
    console.error('[FAIL] no code in Location');
    process.exit(1);
  }
  console.log(`[OK]   authorize code length: ${code.length}`);

  // 5. POST /token (authorization_code grant)
  const tokenResp = await handler(
    makeEvent({
      method: 'POST',
      path: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    }),
  );
  expectStatus('token exchange', tokenResp, 200);
  const tokens = JSON.parse(tokenResp.body ?? '{}') as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  if (!tokens.access_token || !tokens.refresh_token) {
    console.error('[FAIL] missing tokens in response');
    process.exit(1);
  }
  console.log(`[OK]   access_token length: ${tokens.access_token.length}, expires_in: ${tokens.expires_in}`);

  // 6. POST /mcp with Bearer — initialize
  const initResp = await handler(
    makeEvent({
      method: 'POST',
      path: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-oauth', version: '0.0.0' },
        },
      }),
    }),
  );
  expectStatus('mcp initialize (Bearer)', initResp, 200);

  // 7. POST /mcp with Bearer — tools/list
  const toolsResp = await handler(
    makeEvent({
      method: 'POST',
      path: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      }),
    }),
  );
  expectStatus('mcp tools/list (Bearer)', toolsResp, 200);
  if (!toolsResp.body?.includes('roo_whoami')) {
    console.error('[FAIL] tools/list did not include roo_whoami');
    process.exit(1);
  }
  console.log('[OK]   tools/list includes roo_whoami');

  // 8. POST /mcp — call roo_whoami via Bearer
  const callResp = await handler(
    makeEvent({
      method: 'POST',
      path: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'roo_whoami', arguments: {} },
      }),
    }),
  );
  expectStatus('mcp roo_whoami (Bearer)', callResp, 200);
  if (!callResp.body?.includes('Roo account:')) {
    console.error('[FAIL] roo_whoami did not return account summary');
    console.error('  body:', callResp.body?.slice(0, 500));
    process.exit(1);
  }
  console.log('[OK]   roo_whoami returned account summary');

  // 9. 401 with WWW-Authenticate when no auth provided
  const noAuth = await handler(
    makeEvent({
      method: 'POST',
      path: '/mcp',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  expectStatus('mcp no-auth 401', noAuth, 401);
  const wwwAuth = noAuth.headers?.['www-authenticate'] ?? noAuth.headers?.['WWW-Authenticate'];
  if (typeof wwwAuth !== 'string' || !wwwAuth.includes('resource_metadata=')) {
    console.error('[FAIL] 401 missing WWW-Authenticate with resource_metadata');
    process.exit(1);
  }
  console.log('[OK]   401 WWW-Authenticate carries resource_metadata');

  // 10. Refresh token exchange
  const refreshResp = await handler(
    makeEvent({
      method: 'POST',
      path: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      }).toString(),
    }),
  );
  expectStatus('refresh token exchange', refreshResp, 200);

  // 11. Discovery docs
  const authSvr = await handler(
    makeEvent({ method: 'GET', path: '/.well-known/oauth-authorization-server' }),
  );
  expectStatus('oauth-authorization-server', authSvr, 200);
  const pr = await handler(
    makeEvent({ method: 'GET', path: '/.well-known/oauth-protected-resource' }),
  );
  expectStatus('oauth-protected-resource', pr, 200);

  console.log('\n✓ All OAuth smoke checks passed.');
}

await main();
