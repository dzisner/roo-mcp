// Dynamic Client Registration (RFC 7591).
//
// We don't persist registrations. The returned `client_id` is itself a JWE
// containing the registered `redirect_uris` and `client_name`, so /authorize
// can validate the submitted redirect_uri belongs to this client without a DB.
//
// Only validates what the authorize/token flow actually relies on:
//   - redirect_uris present and non-empty
//   - each redirect_uri is HTTPS (or http://localhost / http://127.0.0.1 for dev tools)
import { mintClientId } from './jwe.js';

interface RegistrationRequest {
  redirect_uris?: unknown;
  client_name?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  scope?: unknown;
  application_type?: unknown;
}

function errorResponse(status: number, error: string, description: string): Response {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function isAllowedRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  // Allow http on loopback for local dev tools (CLI OAuth clients).
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return true;
  }
  return false;
}

export async function handleRegister(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return errorResponse(405, 'invalid_request', 'POST required.');
  }
  let body: RegistrationRequest;
  try {
    body = (await request.json()) as RegistrationRequest;
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be JSON.');
  }

  const rawRedirects = body.redirect_uris;
  if (!Array.isArray(rawRedirects) || rawRedirects.length === 0) {
    return errorResponse(
      400,
      'invalid_redirect_uri',
      'redirect_uris is required and must contain at least one URI.',
    );
  }
  const redirectUris: string[] = [];
  for (const uri of rawRedirects) {
    if (!isAllowedRedirectUri(uri)) {
      return errorResponse(
        400,
        'invalid_redirect_uri',
        `redirect_uri "${String(uri)}" must be HTTPS (or http://localhost for dev tools).`,
      );
    }
    redirectUris.push(uri);
  }

  const clientName = typeof body.client_name === 'string' ? body.client_name : 'Unknown Client';

  const clientId = await mintClientId({ redirectUris, clientName });
  const now = Math.floor(Date.now() / 1000);

  return new Response(
    JSON.stringify({
      client_id: clientId,
      client_id_issued_at: now,
      redirect_uris: redirectUris,
      client_name: clientName,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'mcp:all',
      application_type: typeof body.application_type === 'string' ? body.application_type : 'web',
    }),
    {
      status: 201,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    },
  );
}
