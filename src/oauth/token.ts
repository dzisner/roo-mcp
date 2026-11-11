// Token endpoint (RFC 6749).
//
// POST /token  (application/x-www-form-urlencoded)
// grant_type=authorization_code:
//   code, redirect_uri, client_id, code_verifier (PKCE S256) → access + refresh tokens
// grant_type=refresh_token:
//   refresh_token, client_id → fresh access + refresh tokens (rotated)
//
// State lives in grants.ts: auth codes mark themselves consumed on first use
// (F03), and refresh tokens rotate with family-level replay detection (F02).
import { createHash, randomUUID } from 'node:crypto';
import {
  decryptAuthCode,
  decryptRefreshToken,
  mintAccessToken,
  mintRefreshToken,
} from './jwe.js';
import { markCodeUsed, rotateRefresh } from './grants.js';

const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 90;

function errorJson(status: number, error: string, description: string): Response {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    },
  );
}

function pkceMatches(verifier: string, expectedChallenge: string): boolean {
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return challenge === expectedChallenge;
}

interface IssueTokensOpts {
  rooApiKey: string;
  clientId: string;
  familyId: string;
}

async function issueTokens({
  rooApiKey,
  clientId,
  familyId,
}: IssueTokensOpts): Promise<Response> {
  const refreshJti = randomUUID();
  const [accessToken, refreshToken] = await Promise.all([
    mintAccessToken({ rooApiKey, clientId }, ACCESS_TTL_SECONDS),
    mintRefreshToken({ rooApiKey, clientId, jti: refreshJti, familyId }, REFRESH_TTL_SECONDS),
  ]);
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: 'mcp:all',
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        pragma: 'no-cache',
      },
    },
  );
}

async function handleAuthorizationCode(body: URLSearchParams): Promise<Response> {
  const code = body.get('code');
  const redirectUri = body.get('redirect_uri');
  const clientId = body.get('client_id');
  const codeVerifier = body.get('code_verifier');

  if (!code) return errorJson(400, 'invalid_request', 'Missing code.');
  if (!redirectUri) return errorJson(400, 'invalid_request', 'Missing redirect_uri.');
  if (!clientId) return errorJson(400, 'invalid_request', 'Missing client_id.');
  if (!codeVerifier) return errorJson(400, 'invalid_request', 'Missing code_verifier (PKCE).');

  let payload;
  try {
    payload = await decryptAuthCode(code);
  } catch {
    return errorJson(400, 'invalid_grant', 'Authorization code is invalid or expired.');
  }

  if (payload.redirectUri !== redirectUri) {
    return errorJson(400, 'invalid_grant', 'redirect_uri does not match the one bound to this code.');
  }
  if (payload.clientId !== clientId) {
    return errorJson(400, 'invalid_grant', 'client_id does not match the one bound to this code.');
  }
  if (!pkceMatches(codeVerifier, payload.codeChallenge)) {
    return errorJson(400, 'invalid_grant', 'PKCE verifier does not match code_challenge.');
  }

  // F03: single-use. First call wins; a replay — even one happening a few
  // milliseconds later from a stolen code — gets rejected here.
  const exp = typeof payload.exp === 'number' ? payload.exp : Math.floor(Date.now() / 1000) + 300;
  const used = await markCodeUsed(payload.jti, exp);
  if (used === 'replay') {
    return errorJson(400, 'invalid_grant', 'Authorization code has already been used.');
  }

  // New grant → new family. Later refresh rotations keep this familyId so
  // reuse-detection links them together.
  return issueTokens({
    rooApiKey: payload.rooApiKey,
    clientId: payload.clientId,
    familyId: randomUUID(),
  });
}

async function handleRefreshToken(body: URLSearchParams): Promise<Response> {
  const refreshToken = body.get('refresh_token');
  if (!refreshToken) return errorJson(400, 'invalid_request', 'Missing refresh_token.');

  let payload;
  try {
    payload = await decryptRefreshToken(refreshToken);
  } catch {
    return errorJson(400, 'invalid_grant', 'Refresh token is invalid or expired.');
  }

  // F02: rotate. If this jti is seen for the second time, the whole family dies.
  const exp = typeof payload.exp === 'number' ? payload.exp : Math.floor(Date.now() / 1000) + REFRESH_TTL_SECONDS;
  const result = await rotateRefresh(payload.jti, payload.familyId, exp);
  if (result === 'replay') {
    return errorJson(
      400,
      'invalid_grant',
      'Refresh token has already been used. All tokens in this session have been revoked for safety — reconnect to continue.',
    );
  }
  if (result === 'revoked') {
    return errorJson(
      400,
      'invalid_grant',
      'This session has been revoked. Reconnect to continue.',
    );
  }
  return issueTokens({
    rooApiKey: payload.rooApiKey,
    clientId: payload.clientId,
    familyId: payload.familyId,
  });
}

export async function handleToken(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return errorJson(405, 'invalid_request', 'POST required.');
  }
  const bodyText = await request.text();
  const body = new URLSearchParams(bodyText);
  const grantType = body.get('grant_type');

  if (grantType === 'authorization_code') return handleAuthorizationCode(body);
  if (grantType === 'refresh_token') return handleRefreshToken(body);

  return errorJson(
    400,
    'unsupported_grant_type',
    `Unsupported grant_type: ${grantType ?? '(missing)'}. Use "authorization_code" or "refresh_token".`,
  );
}
