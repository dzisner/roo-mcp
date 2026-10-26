// Token endpoint (RFC 6749).
//
// POST /token  (application/x-www-form-urlencoded)
// grant_type=authorization_code:
//   code, redirect_uri, client_id, code_verifier (PKCE S256) → access + refresh tokens
// grant_type=refresh_token:
//   refresh_token, client_id → fresh access + refresh tokens
import { createHash } from 'node:crypto';
import {
  decryptAuthCode,
  decryptRefreshToken,
  mintAccessToken,
  mintRefreshToken,
} from './jwe.js';

const ACCESS_TTL_SECONDS = 3600;

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

async function issueTokens(rooApiKey: string, clientId: string): Promise<Response> {
  const [accessToken, refreshToken] = await Promise.all([
    mintAccessToken({ rooApiKey, clientId }, ACCESS_TTL_SECONDS),
    mintRefreshToken({ rooApiKey, clientId }),
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

  return issueTokens(payload.rooApiKey, payload.clientId);
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
  return issueTokens(payload.rooApiKey, payload.clientId);
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
