// In-process regression gate for the F01-F12 security register.
//
// This runs in CI on every push and PR (see .github/workflows/ci.yml).
// Each assertion pins to a finding ID from SECURITY.md so a red build points
// directly at the section that explains what regressed.
//
// Scope: only encode behaviors that are TRUE TODAY on main. New hardening lands
// with its own assertion in the same PR, so the gate grows one notch per wave
// and CI stays green across the whole plan.
//
// Not a smoke test. Zero network, zero AWS, zero process.env leakage into
// CloudWatch. The in-memory adapter in grants.ts handles state.
import { randomBytes } from 'node:crypto';

// Setup must happen BEFORE importing anything that calls getKeys().
process.env.ROO_MCP_JWE_KEY ??= randomBytes(32).toString('base64');
delete process.env.ROO_MCP_GRANTS_TABLE; // force in-memory adapter

const { handler } = await import('../src/http/lambda.js');
const { markCodeUsed, rotateRefresh, __resetMemoryStoreForTests } = await import(
  '../src/oauth/grants.js'
);
const { mintAccessToken, MCP_REQUIRED_SCOPE } = await import('../src/oauth/jwe.js');

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';

let failures = 0;
let passes = 0;

function assert(id: string, name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passes++;
    console.log(`  \x1b[32mOK\x1b[0m   ${id.padEnd(5)} ${name}`);
  } else {
    failures++;
    console.error(
      `  \x1b[31mFAIL\x1b[0m ${id.padEnd(5)} ${name}${detail ? ` — ${detail}` : ''}`,
    );
  }
}

function mkEvent(overrides: {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  query?: string;
}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: overrides.path,
    rawQueryString: overrides.query ?? '',
    headers: overrides.headers ?? {},
    requestContext: {
      accountId: '0',
      apiId: 'test',
      domainName: 'mcp.roo.bz',
      domainPrefix: 'mcp',
      http: {
        method: overrides.method ?? 'POST',
        path: overrides.path,
        protocol: 'HTTP/1.1',
        sourceIp: `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.1`,
        userAgent: 'regression-gate',
      },
      requestId: 'r',
      routeKey: '$default',
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    isBase64Encoded: false,
    body: overrides.body,
  } as APIGatewayProxyEventV2;
}

async function run(): Promise<void> {
  console.log('\n== Security regression gate ==\n');

  // --- F01: /mcp without any credentials → 401 + WWW-Authenticate pointing at
  // the resource_metadata URL so OAuth clients can discover the AS.
  {
    const res = await handler(mkEvent({ path: '/mcp', method: 'POST', body: '{}' }));
    assert('F01', '/mcp unauth → 401', res.statusCode === 401);
    const wa = (res.headers as Record<string, string>)?.['www-authenticate'] ?? '';
    assert(
      'F01',
      '/mcp 401 advertises resource_metadata',
      wa.includes('resource_metadata='),
      `got: ${wa}`,
    );
  }

  // --- F01: /mcp with a Bearer token missing the required scope → 403
  // `insufficient_scope` (RFC 6750 §3.1), and the required scope is advertised
  // so the client knows what to re-request.
  {
    // Mint a token with the wrong scope.
    const token = await mintAccessToken(
      { rooApiKey: 'rk_test', clientId: 'c_test', scope: 'other' },
      60,
    );
    const res = await handler(
      mkEvent({
        path: '/mcp',
        method: 'POST',
        body: '{}',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    assert('F01', '/mcp scoped token missing → 403', res.statusCode === 403);
    const wa = (res.headers as Record<string, string>)?.['www-authenticate'] ?? '';
    assert(
      'F01',
      '/mcp 403 advertises insufficient_scope + required scope',
      wa.includes('insufficient_scope') && wa.includes(MCP_REQUIRED_SCOPE),
      `got: ${wa}`,
    );
  }

  // --- F11: /mcp with a garbled Bearer → 401 (not 500, not a stack trace, not
  // a jose error message leaking through).
  {
    const res = await handler(
      mkEvent({
        path: '/mcp',
        method: 'POST',
        body: '{}',
        headers: { authorization: 'Bearer not-a-jwe' },
      }),
    );
    assert('F11', 'garbled Bearer → clean 401', res.statusCode === 401);
    const body = typeof res.body === 'string' ? res.body : '';
    assert(
      'F11',
      'garbled Bearer response does not leak crypto error',
      !/jose|decrypt|JWE|JWA/i.test(body),
      body.slice(0, 200),
    );
  }

  // --- F03: markCodeUsed is single-use. Same jti twice → 'fresh' then 'replay'.
  {
    __resetMemoryStoreForTests();
    const exp = Math.floor(Date.now() / 1000) + 300;
    const first = await markCodeUsed('code-abc', exp);
    const second = await markCodeUsed('code-abc', exp);
    assert('F03', 'auth code first use returns fresh', first === 'fresh');
    assert('F03', 'auth code replay returns replay', second === 'replay');
  }

  // --- F02: rotateRefresh rotates; replay revokes the family; a subsequent
  // refresh in that family returns 'revoked' even with a NEW jti.
  {
    __resetMemoryStoreForTests();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const r1 = await rotateRefresh('rt-1', 'fam-1', exp);
    const r2 = await rotateRefresh('rt-1', 'fam-1', exp); // same jti → replay
    const r3 = await rotateRefresh('rt-2', 'fam-1', exp); // new jti, same family
    assert('F02', 'refresh first use returns fresh', r1 === 'fresh');
    assert('F02', 'refresh replay returns replay', r2 === 'replay');
    assert('F02', 'post-replay family refresh returns revoked', r3 === 'revoked');
  }

  // --- F08: rate limit on /register. Limit is 10/min per IP. Hit 11 times
  // from the SAME source IP and the 11th gets 429 with Retry-After.
  {
    __resetMemoryStoreForTests();
    const ip = '203.0.113.42';
    const body = JSON.stringify({
      redirect_uris: ['https://example.com/cb'],
      client_name: 'test',
    });
    const fire = (): Promise<APIGatewayProxyStructuredResultV2> =>
      handler({
        ...mkEvent({
          path: '/register',
          method: 'POST',
          body,
          headers: { 'content-type': 'application/json' },
        }),
        requestContext: {
          ...mkEvent({ path: '/register' }).requestContext,
          http: {
            ...mkEvent({ path: '/register' }).requestContext.http,
            sourceIp: ip,
            method: 'POST',
            path: '/register',
          },
        },
      } as APIGatewayProxyEventV2);
    const results: APIGatewayProxyStructuredResultV2[] = [];
    for (let i = 0; i < 11; i++) results.push(await fire());
    const twelfth = results[10];
    assert('F08', '/register 11th request from same IP is throttled', twelfth?.statusCode === 429);
    const retry = (twelfth?.headers as Record<string, string>)?.['retry-after'];
    assert('F08', '/register 429 includes Retry-After', Number(retry) > 0, `got: ${retry}`);
  }

  // --- F07: /authorize GET returns HTML with CSP and Referrer-Policy headers.
  {
    const res = await handler(
      mkEvent({ path: '/authorize', method: 'GET', query: 'client_id=invalid' }),
    );
    // We expect either a 400 (invalid client_id shape) or 200 — both acceptable
    // if the SECURITY HEADERS are present. We're testing the headers, not the
    // request-shape validation.
    const h = (res.headers as Record<string, string>) ?? {};
    assert(
      'F07',
      '/authorize response carries Content-Security-Policy',
      typeof h['content-security-policy'] === 'string' &&
        h['content-security-policy'].length > 0,
    );
    assert(
      'F07',
      '/authorize response carries Referrer-Policy',
      typeof h['referrer-policy'] === 'string' && h['referrer-policy'].length > 0,
    );
  }

  // --- F10: package.json uses the scoped name clients will install.
  {
    const pkg = JSON.parse(
      await (await import('node:fs/promises')).readFile(
        new URL('../package.json', import.meta.url),
        'utf8',
      ),
    );
    assert('F10', 'package.json name is @roo-bz/roo-mcp', pkg.name === '@roo-bz/roo-mcp');
  }

  // --- Summary
  console.log(`\nPass: ${passes}   Fail: ${failures}\n`);
  if (failures > 0) {
    console.error('Regression gate FAILED — see SECURITY.md for finding IDs.\n');
    process.exit(1);
  }
}

await run();
