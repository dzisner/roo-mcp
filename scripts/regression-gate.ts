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
const {
  mintAccessToken,
  mintAuthCode,
  mintRefreshToken,
  MCP_REQUIRED_SCOPE,
  MCP_RESOURCE,
  JWE_ISSUER,
} = await import('../src/oauth/jwe.js');
const { redactAddOnForModel } = await import('../src/tools/redact.js');
const { encodeRooId, validateRooId } = await import('../src/roo-client.js');
const { EncryptJWT } = await import('jose');
import { randomUUID, createHash, randomBytes } from 'node:crypto';

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

  // --- F01: /mcp rejects non-POST methods with 405 + Allow: POST BEFORE
  // consulting auth. GET is the SSE path in the MCP streamable-HTTP transport,
  // which we don't support in JSON-response mode.
  {
    for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS'] as const) {
      const res = await handler(mkEvent({ path: '/mcp', method }));
      assert('F01', `/mcp ${method} → 405`, res.statusCode === 405, `got ${res.statusCode}`);
      const allow = (res.headers as Record<string, string>)?.['allow'] ?? '';
      assert('F01', `/mcp ${method} 405 includes Allow: POST`, allow === 'POST', `got: ${allow}`);
    }
  }

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

  // --- F04: webhook secrets must not round-trip to the model. The redactor
  // strips endpoint path/query, every header value, every queryString value,
  // and any non-trivial body. Host is preserved so the model can still tell
  // which service the webhook posts to.
  {
    const input = {
      addOn: 'webhook' as const,
      enabled: true,
      data: {
        endpoint: 'https://hooks.slack.com/services/T1/B2/VERY_SECRET_TOKEN',
        headers: { Authorization: 'Bearer sk-live-12345', 'X-Not-Secret': 'ok' },
        queryString: { api_key: 'live-abcdef' },
        body: '{"text": "hi"}',
      },
    };
    const safe = redactAddOnForModel(input) as typeof input;
    const serialized = JSON.stringify(safe);
    assert('F04', 'webhook endpoint path redacted', !serialized.includes('VERY_SECRET_TOKEN'));
    assert('F04', 'webhook endpoint host preserved', serialized.includes('hooks.slack.com'));
    assert('F04', 'webhook Authorization header redacted', !serialized.includes('sk-live-12345'));
    assert('F04', 'webhook queryString value redacted', !serialized.includes('live-abcdef'));
    assert(
      'F04',
      'non-webhook add-ons pass through unchanged',
      JSON.stringify(
        redactAddOnForModel({
          addOn: 'scheduledRedirect' as const,
          enabled: true,
          data: { waypoints: [{ url: 'https://example.com', at: 'now' }] },
        }),
      ).includes('example.com'),
    );
  }

  // --- F05: shortlink IDs must be base64 alphabet, 4-256 chars. Anything
  // else is rejected BEFORE being URL-encoded and sent to Roo.
  {
    const bad: Array<[string, string]> = [
      ['abc', 'too short'],
      ['a'.repeat(300), 'too long'],
      ['bad id with space', 'invalid chars (space)'],
      ['bad-id-with-dashes', 'invalid chars (dash)'],
      ['../../etc/passwd', 'path traversal'],
      ['bad\u0000nul', 'control char'],
      ['中文中文', 'non-ASCII'],
    ];
    for (const [id, label] of bad) {
      let threw = false;
      try {
        validateRooId(id);
      } catch {
        threw = true;
      }
      assert('F05', `validateRooId rejects ${label}`, threw, `${label} did not throw`);
    }
    // Real-looking Roo IDs pass.
    const good = ['cm3abc123', 'ZXhhbXBsZS5jb20vYWJjZA==', 'cHJvZHVjdGlvbi9zbHVn'];
    for (const id of good) {
      let threw = false;
      try {
        validateRooId(id);
      } catch {
        threw = true;
      }
      assert('F05', `validateRooId accepts real id ${id.slice(0, 16)}...`, !threw);
    }
    // encodeRooId wraps validateRooId so every call site gets the check.
    let encodeThrew = false;
    try {
      encodeRooId('bad id');
    } catch {
      encodeThrew = true;
    }
    assert('F05', 'encodeRooId rejects invalid id', encodeThrew);
  }

  // --- F12: every registered tool has an `annotations:` block. We static-scan
  // the tool source files rather than probe the live MCP server, because the
  // SDK does not expose a stable introspection API. One `annotations:` key
  // per `registerTool(` call is the floor.
  {
    const fs = await import('node:fs/promises');
    const files = ['src/tools/account.ts', 'src/tools/addons.ts', 'src/tools/shortlinks.ts'];
    for (const f of files) {
      const src = await fs.readFile(new URL(`../${f}`, import.meta.url), 'utf8');
      const toolCount = (src.match(/\.registerTool\s*\(/g) ?? []).length;
      const annotationCount = (src.match(/^\s*annotations:\s*\{/gm) ?? []).length;
      assert(
        'F12',
        `${f}: every registerTool has annotations (${annotationCount}/${toolCount})`,
        toolCount > 0 && annotationCount >= toolCount,
      );
    }
  }

  // --- F03 (Wave 7): a code is consumed on FIRST redemption attempt, even if
  // the attempt fails PKCE. A later attempt with the correct verifier must
  // then fail with "already used".
  {
    __resetMemoryStoreForTests();
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const code = await mintAuthCode({
      rooApiKey: 'rk_test',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      redirectUri: 'http://localhost:9999/cb',
      clientId: 'c_test',
      jti: randomUUID(),
      scope: MCP_REQUIRED_SCOPE,
      resource: MCP_RESOURCE,
    });
    const tokenBody = (verifierToSend: string): URLSearchParams =>
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://localhost:9999/cb',
        client_id: 'c_test',
        code_verifier: verifierToSend,
      });
    // First attempt: WRONG verifier → fails. Code must still be burned.
    const first = await handler(
      mkEvent({
        path: '/token',
        method: 'POST',
        body: tokenBody('wrong-verifier-string-32chars-ok').toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
    assert('F03', 'bad PKCE on code redemption → 400', first.statusCode === 400);
    // Second attempt: RIGHT verifier. Must now fail as replayed-code.
    const second = await handler(
      mkEvent({
        path: '/token',
        method: 'POST',
        body: tokenBody(verifier).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
    const secondBody = JSON.parse(String(second.body ?? '{}'));
    assert(
      'F03',
      'correct PKCE on same code after bad attempt → already-used',
      second.statusCode === 400 && /already been used/i.test(String(secondBody.error_description)),
      `body: ${second.body}`,
    );
  }

  // --- F02 (Wave 7): client_id is REQUIRED on refresh grant.
  {
    __resetMemoryStoreForTests();
    const res = await handler(
      mkEvent({
        path: '/token',
        method: 'POST',
        body: 'grant_type=refresh_token&refresh_token=anything',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
    const body = JSON.parse(String(res.body ?? '{}'));
    assert('F02', 'refresh without client_id → invalid_request', body.error === 'invalid_request');
  }

  // --- F02 (Wave 7): refresh must match the client_id it was issued to.
  {
    __resetMemoryStoreForTests();
    const refresh = await mintRefreshToken({
      rooApiKey: 'rk_test',
      clientId: 'c_original',
      jti: randomUUID(),
      familyId: randomUUID(),
      scope: MCP_REQUIRED_SCOPE,
    });
    const res = await handler(
      mkEvent({
        path: '/token',
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refresh,
          client_id: 'c_different',
        }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
    const body = JSON.parse(String(res.body ?? '{}'));
    assert(
      'F02',
      'refresh with wrong client_id → invalid_grant',
      res.statusCode === 400 && body.error === 'invalid_grant',
    );
  }

  // --- F02 (Wave 7): refresh without v: 2 (legacy / pre-schema-rotation) is
  // rejected. Build a v: 1 token directly with jose to bypass the auto-stamp.
  {
    __resetMemoryStoreForTests();
    const key = Buffer.from(process.env.ROO_MCP_JWE_KEY!, 'base64');
    const legacy = await new EncryptJWT({
      rooApiKey: 'rk_test',
      clientId: 'c_test',
      jti: randomUUID(),
      familyId: randomUUID(),
      scope: MCP_REQUIRED_SCOPE,
      v: 1,
      use: 'refresh',
    })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setIssuer(JWE_ISSUER)
      .setIssuedAt()
      .setExpirationTime('30d')
      .encrypt(new Uint8Array(key));
    const res = await handler(
      mkEvent({
        path: '/token',
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: legacy,
          client_id: 'c_test',
        }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
    const body = JSON.parse(String(res.body ?? '{}'));
    assert(
      'F02',
      'legacy-v1 refresh rejected with reconnect hint',
      res.statusCode === 400 && /reconnect/i.test(String(body.error_description)),
    );
  }

  // --- F07 (Wave 7): invalid scope on /authorize bounces back to redirect_uri
  // with error=invalid_scope (OAuth 2.1 §4.1.2.1 — redirectable error) rather
  // than rendering an HTML page the client's own UI can't see.
  {
    // First register a client so we have a valid client_id + redirect_uri.
    const regRes = await handler(
      mkEvent({
        path: '/register',
        method: 'POST',
        body: JSON.stringify({
          redirect_uris: ['http://localhost:9999/cb'],
          client_name: 'gate-test',
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    const reg = JSON.parse(String(regRes.body ?? '{}'));
    const clientIdJwe = reg.client_id;
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientIdJwe,
      redirect_uri: 'http://localhost:9999/cb',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
      scope: 'bogus:scope',
      state: 'state-xyz',
    }).toString();
    const res = await handler(mkEvent({ path: '/authorize', method: 'GET', query }));
    const loc = (res.headers as Record<string, string>)?.['location'] ?? '';
    assert('F07', 'bad scope → 302 redirect-back', res.statusCode === 302, `got ${res.statusCode}`);
    assert('F07', 'bad scope redirect carries error=invalid_scope', /error=invalid_scope/.test(loc), loc);
    assert('F07', 'bad scope redirect carries state', /state=state-xyz/.test(loc), loc);
  }

  // --- F07 (Wave 7): unsupported resource → 302 error=invalid_target.
  {
    const regRes = await handler(
      mkEvent({
        path: '/register',
        method: 'POST',
        body: JSON.stringify({
          redirect_uris: ['http://localhost:9999/cb'],
          client_name: 'gate-test',
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    const reg = JSON.parse(String(regRes.body ?? '{}'));
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: 'http://localhost:9999/cb',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
      resource: 'https://wrong.example.com/api',
    }).toString();
    const res = await handler(mkEvent({ path: '/authorize', method: 'GET', query }));
    const loc = (res.headers as Record<string, string>)?.['location'] ?? '';
    assert('F07', 'wrong resource → 302 redirect-back', res.statusCode === 302);
    assert('F07', 'wrong resource carries error=invalid_target', /error=invalid_target/.test(loc), loc);
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
