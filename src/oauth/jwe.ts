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

export type TokenKind = 'code' | 'access' | 'refresh' | 'client';

export interface AuthCodePayload extends JWTPayload {
  rooApiKey: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  redirectUri: string;
  clientId: string;
  use: 'code';
}

export interface AccessTokenPayload extends JWTPayload {
  rooApiKey: string;
  clientId: string;
  use: 'access';
}

export interface RefreshTokenPayload extends JWTPayload {
  rooApiKey: string;
  clientId: string;
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
}

async function mint({ payload, ttlSeconds }: MintOptions): Promise<string> {
  const keys = getKeys();
  const now = Math.floor(Date.now() / 1000);
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuer(JWE_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .encrypt(keys.current);
}

async function decryptWithRotation<T extends JWTPayload>(
  jwe: string,
  expectedUse: TokenKind,
): Promise<T> {
  const keys = getKeys();
  const candidates = keys.previous ? [keys.current, keys.previous] : [keys.current];
  let lastErr: unknown;
  for (const key of candidates) {
    try {
      const { payload } = await jwtDecrypt(jwe, key, { issuer: JWE_ISSUER });
      if (payload['use'] !== expectedUse) {
        throw new Error(
          `Token use mismatch: expected ${expectedUse}, got ${String(payload['use'])}`,
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
  return decryptWithRotation<AuthCodePayload>(jwe, 'code');
}

export function mintAccessToken(
  payload: Omit<AccessTokenPayload, 'use' | keyof JWTPayload>,
  ttlSeconds = 3600,
): Promise<string> {
  return mint({ payload: { ...payload, use: 'access' }, ttlSeconds });
}

export function decryptAccessToken(jwe: string): Promise<AccessTokenPayload> {
  return decryptWithRotation<AccessTokenPayload>(jwe, 'access');
}

export function mintRefreshToken(
  payload: Omit<RefreshTokenPayload, 'use' | keyof JWTPayload>,
  ttlSeconds = 60 * 60 * 24 * 90,
): Promise<string> {
  return mint({ payload: { ...payload, use: 'refresh' }, ttlSeconds });
}

export function decryptRefreshToken(jwe: string): Promise<RefreshTokenPayload> {
  return decryptWithRotation<RefreshTokenPayload>(jwe, 'refresh');
}

export function mintClientId(
  payload: Omit<ClientIdPayload, 'use' | keyof JWTPayload>,
  ttlSeconds = 60 * 60 * 24 * 365 * 10,
): Promise<string> {
  return mint({ payload: { ...payload, use: 'client' }, ttlSeconds });
}

export function decryptClientId(jwe: string): Promise<ClientIdPayload> {
  return decryptWithRotation<ClientIdPayload>(jwe, 'client');
}
