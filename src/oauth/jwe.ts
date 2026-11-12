// Symmetric JWE helpers for OAuth tokens.
// All OAuth artifacts we mint — authorization codes, access tokens, refresh tokens —
// are JWEs encrypted directly with A256GCM. The payload embeds the user's Roo API
// key, so encryption (not just signing) is mandatory: anyone holding a signed-only
// JWT could extract the key.
//
// Key material comes from env vars:
//   ROO_MCP_JWE_KEY          (required) — base64 of 32 bytes. Mint uses this.
//   ROO_MCP_JWE_KEY_PREVIOUS (optional) — base64 of 32 bytes, present only during
//     rotation. Decrypt tries current first, falls back to previous.
//
// Rotation flow: generate a new key, move the old value into KEY_PREVIOUS, put the
// new value in KEY. Redeploy. Old tokens still decrypt. Drop KEY_PREVIOUS once
// pre-rotation tokens have expired.
//
// Generate with: openssl rand -base64 32
import { EncryptJWT, jwtDecrypt, type JWTPayload } from 'jose';

interface KeySet {
  current: Uint8Array;
  previous: Uint8Array | null;
}

function parseKey(b64: string): Uint8Array {
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length !== 32) {
    throw new Error(
      `JWE key must decode to 32 bytes (got ${bytes.length}). Generate with: openssl rand -base64 32`,
    );
  }
  return new Uint8Array(bytes);
}

function loadKeys(): KeySet {
  const current = process.env.ROO_MCP_JWE_KEY;
  if (!current) {
    throw new Error(
      'ROO_MCP_JWE_KEY is required (base64 of 32 random bytes). Generate with: openssl rand -base64 32',
    );
  }
  const previous = process.env.ROO_MCP_JWE_KEY_PREVIOUS;
  return {
    current: parseKey(current),
    // Empty string from a conditionally-unset CloudFormation parameter counts as "no previous".
    previous: previous && previous.length > 0 ? parseKey(previous) : null,
  };
}

let cachedKeys: KeySet | null = null;
function getKeys(): KeySet {
  if (!cachedKeys) cachedKeys = loadKeys();
  return cachedKeys;
}

export const JWE_ISSUER = process.env.ROO_MCP_ISSUER ?? 'https://mcp.roo.bz';

// The one resource an access token can reach. Set as the token's `aud` claim and
// verified on /mcp. RFC 8707 resource indicators: a token for /mcp cannot be
// replayed against a hypothetical /admin that we add later without re-minting.
export const MCP_RESOURCE = `${JWE_ISSUER}/mcp`;

// The only scope we currently issue. Discovery advertises this same value.
export const DEFAULT_SCOPE = 'mcp:all';

// The scope value /mcp requires any access token to carry. When we introduce
// finer scopes (e.g. mcp:read vs mcp:write) later, clients can keep requesting
// `mcp:all` and the check stays sound.
export const MCP_REQUIRED_SCOPE = 'mcp:all';

export type TokenKind = 'code' | 'access' | 'refresh' | 'client';

export interface AuthCodePayload extends JWTPayload {
  rooApiKey: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  redirectUri: string;
  clientId: string;
  // Random per-code identifier. /token writes a "used" marker keyed on this to
  // enforce single-use (F03). Required on every newly-minted code.
  jti: string;
  // Space-separated OAuth scope string the client asked for and we granted.
  // Carried forward into the access token so /mcp can enforce it (F01).
  scope: string;
  use: 'code';
}

export interface AccessTokenPayload extends JWTPayload {
  rooApiKey: string;
  clientId: string;
  // Granted scope. /mcp rejects tokens that don't contain the required scope
  // with `insufficient_scope` per RFC 6750 §3.1.
  scope: string;
  use: 'access';
}

export interface RefreshTokenPayload extends JWTPayload {
  rooApiKey: string;
  clientId: string;
  // Per-refresh identifier; /token marks this consumed on use so a replay is
  // rejected and triggers family revocation (F02).
  jti: string;
  // Chain identifier. All refresh tokens descended from the same auth_code grant
  // share this; revoking it (on replay detection) kills every outstanding
  // refresh in the family.
  familyId: string;
  // Granted scope; forwarded to the rotated access token on every refresh.
  scope: string;
  use: 'refresh';
}

// Client registrations are stateless: the JWE itself IS the client_id.
// We embed the registered redirect_uris so /authorize can verify them without a DB.
export interface ClientIdPayload extends JWTPayload {
  redirectUris: string[];
  clientName: string;
  use: 'client';
}

interface MintOptions {
  payload: Record<string, unknown>;
  ttlSeconds: number;
  // Optional audience claim. Only access tokens carry this today — it binds the
  // token to /mcp so it cannot be replayed against a future endpoint added under
  // the same issuer without being re-minted for that audience (RFC 8707).
  audience?: string;
}

async function mint({ payload, ttlSeconds, audience }: MintOptions): Promise<string> {
  const keys = getKeys();
  const now = Math.floor(Date.now() / 1000);
  let builder = new EncryptJWT(payload)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuer(JWE_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds);
  if (audience) builder = builder.setAudience(audience);
  return builder.encrypt(keys.current);
}

interface DecryptOptions {
  expectedUse: TokenKind;
  // When set, jose verifies the token's `aud` matches. We use this to reject an
  // access token minted for one resource against a different one (F01 / RFC 8707).
  expectedAudience?: string;
}

async function decryptWithRotation<T extends JWTPayload>(
  jwe: string,
  opts: DecryptOptions,
): Promise<T> {
  const keys = getKeys();
  const candidates = keys.previous ? [keys.current, keys.previous] : [keys.current];
  let lastErr: unknown;
  for (const key of candidates) {
    try {
      const { payload } = await jwtDecrypt(jwe, key, {
        issuer: JWE_ISSUER,
        ...(opts.expectedAudience ? { audience: opts.expectedAudience } : {}),
      });
      if (payload['use'] !== opts.expectedUse) {
        throw new Error(
          `Token use mismatch: expected ${opts.expectedUse}, got ${String(payload['use'])}`,
        );
      }
      return payload as T;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('JWE decryption failed');
}

export function mintAuthCode(
  payload: Omit<AuthCodePayload, 'use' | keyof JWTPayload>,
  ttlSeconds = 300,
): Promise<string> {
  return mint({ payload: { ...payload, use: 'code' }, ttlSeconds });
}

export function decryptAuthCode(jwe: string): Promise<AuthCodePayload> {
  return decryptWithRotation<AuthCodePayload>(jwe, { expectedUse: 'code' });
}

export function mintAccessToken(
  payload: Omit<AccessTokenPayload, 'use' | keyof JWTPayload>,
  ttlSeconds = 3600,
): Promise<string> {
  return mint({
    payload: { ...payload, use: 'access' },
    ttlSeconds,
    audience: MCP_RESOURCE,
  });
}

export function decryptAccessToken(jwe: string): Promise<AccessTokenPayload> {
  return decryptWithRotation<AccessTokenPayload>(jwe, {
    expectedUse: 'access',
    expectedAudience: MCP_RESOURCE,
  });
}

export function mintRefreshToken(
  payload: Omit<RefreshTokenPayload, 'use' | keyof JWTPayload>,
  ttlSeconds = 60 * 60 * 24 * 90,
): Promise<string> {
  return mint({ payload: { ...payload, use: 'refresh' }, ttlSeconds });
}

export function decryptRefreshToken(jwe: string): Promise<RefreshTokenPayload> {
  return decryptWithRotation<RefreshTokenPayload>(jwe, { expectedUse: 'refresh' });
}

export function mintClientId(
  payload: Omit<ClientIdPayload, 'use' | keyof JWTPayload>,
  ttlSeconds = 60 * 60 * 24 * 365 * 10,
): Promise<string> {
  return mint({ payload: { ...payload, use: 'client' }, ttlSeconds });
}

export function decryptClientId(jwe: string): Promise<ClientIdPayload> {
  return decryptWithRotation<ClientIdPayload>(jwe, { expectedUse: 'client' });
}

// Convenience: does this space-separated scope string contain the required
// scope token? `scope` may be '' (empty) or undefined for pre-F01 tokens; those
// return false and /mcp will then issue a 403.
export function scopeIncludes(scope: string | undefined, required: string): boolean {
  if (!scope) return false;
  return scope.split(/\s+/).includes(required);
}
