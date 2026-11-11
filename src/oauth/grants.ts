// Grants table — the one piece of OAuth state we keep.
//
// Everything else (auth codes, access/refresh tokens, client registrations) is a
// stateless JWE. This module adds the minimum state needed to make OAuth 2.1 safe:
//
//   - F03: authorization codes are single-use. We write a "used" marker on first
//          redemption; a replay hits the ConditionExpression and is rejected.
//   - F02: refresh tokens rotate on every use and detect replay. Each refresh
//          carries a family id; reusing a rotated refresh revokes the whole family.
//   - F08: per-IP / per-endpoint rate limiting on /authorize and /token.
//
// One DynamoDB table backs all three, keyed by a prefixed `pk`, with DDB TTL on
// the `ttl` attribute cleaning items up automatically so the table never grows.
//
// When ROO_MCP_GRANTS_TABLE is unset (local smoke test, unit tests), this falls
// back to an in-process Map with the same semantics. Prod ALWAYS sets it — the
// SAM template wires it in from the CloudFormation Ref.
import {
  DynamoDBClient,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = process.env.ROO_MCP_GRANTS_TABLE;
const REGION = process.env.AWS_REGION ?? 'us-east-1';

// A conditional put/update that depends on "item does not exist". DDB signals this
// one way; the in-memory adapter has to simulate it.
class ConditionFailed extends Error {
  constructor() {
    super('condition_failed');
    this.name = 'ConditionFailed';
  }
}

interface GrantsAdapter {
  // Succeeds once per pk until the item expires or is overwritten. A second call
  // with the same pk before expiry throws ConditionFailed.
  putIfAbsent(pk: string, exp: number): Promise<void>;
  // Looks up an item by pk. Returns null if missing or TTL-expired. Only used for
  // the family-revoked check so we keep the payload tiny.
  getItem(pk: string): Promise<Record<string, unknown> | null>;
  // Writes/overwrites a marker item unconditionally.
  putItem(pk: string, attrs: Record<string, unknown>, exp: number): Promise<void>;
  // Atomic counter with TTL. Returns the new count after incrementing by 1.
  // Used for rate limits; TTL == windowEnd so counters self-expire.
  increment(pk: string, windowEnd: number): Promise<number>;
}

// ---------- DynamoDB adapter ----------

let cachedDdb: DynamoDBDocumentClient | null = null;
function ddb(): DynamoDBDocumentClient {
  if (!cachedDdb) {
    cachedDdb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return cachedDdb;
}

const ddbAdapter: GrantsAdapter = {
  async putIfAbsent(pk, exp) {
    try {
      await ddb().send(
        new PutCommand({
          TableName: TABLE_NAME!,
          Item: { pk, ttl: exp },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) throw new ConditionFailed();
      throw err;
    }
  },
  async getItem(pk) {
    const res = await ddb().send(
      new GetCommand({ TableName: TABLE_NAME!, Key: { pk } }),
    );
    if (!res.Item) return null;
    // Belt-and-braces: DDB's TTL sweeper runs every few hours, so an item past
    // its TTL may still be returned by a GetItem. Filter here too.
    const ttl = typeof res.Item['ttl'] === 'number' ? (res.Item['ttl'] as number) : 0;
    if (ttl && ttl <= Math.floor(Date.now() / 1000)) return null;
    return res.Item;
  },
  async putItem(pk, attrs, exp) {
    await ddb().send(
      new PutCommand({
        TableName: TABLE_NAME!,
        Item: { pk, ttl: exp, ...attrs },
      }),
    );
  },
  async increment(pk, windowEnd) {
    const res = await ddb().send(
      new UpdateCommand({
        TableName: TABLE_NAME!,
        Key: { pk },
        UpdateExpression: 'ADD #c :one SET #t = if_not_exists(#t, :ttl)',
        ExpressionAttributeNames: { '#c': 'count', '#t': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':ttl': windowEnd },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    const count = res.Attributes?.['count'];
    return typeof count === 'number' ? count : 1;
  },
};

// ---------- In-memory adapter (local dev, smoke tests) ----------

interface MemoryItem {
  attrs: Record<string, unknown>;
  exp: number;
}

const memStore = new Map<string, MemoryItem>();

function memPurge(now: number): void {
  for (const [k, v] of memStore) if (v.exp && v.exp <= now) memStore.delete(k);
}

const memoryAdapter: GrantsAdapter = {
  async putIfAbsent(pk, exp) {
    const now = Math.floor(Date.now() / 1000);
    memPurge(now);
    if (memStore.has(pk)) throw new ConditionFailed();
    memStore.set(pk, { attrs: {}, exp });
  },
  async getItem(pk) {
    const now = Math.floor(Date.now() / 1000);
    memPurge(now);
    const item = memStore.get(pk);
    return item ? item.attrs : null;
  },
  async putItem(pk, attrs, exp) {
    memStore.set(pk, { attrs, exp });
  },
  async increment(pk, windowEnd) {
    const now = Math.floor(Date.now() / 1000);
    memPurge(now);
    const existing = memStore.get(pk);
    const prev = typeof existing?.attrs['count'] === 'number' ? (existing.attrs['count'] as number) : 0;
    const next = prev + 1;
    memStore.set(pk, { attrs: { count: next }, exp: existing?.exp ?? windowEnd });
    return next;
  },
};

function adapter(): GrantsAdapter {
  return TABLE_NAME ? ddbAdapter : memoryAdapter;
}

// Exposed for tests only. Clears the in-memory store so test ordering is stable.
export function __resetMemoryStoreForTests(): void {
  memStore.clear();
}

// ---------- Public surface ----------

// F03: authorization code single-use. Call this on redemption; if it returns
// 'replay', reject the token request as invalid_grant.
export async function markCodeUsed(
  jti: string,
  codeExp: number,
): Promise<'fresh' | 'replay'> {
  try {
    // Keep the marker a minute past the code's own expiry so a replay attempt
    // right at the boundary still trips the condition.
    await adapter().putIfAbsent(`code#${jti}`, codeExp + 60);
    return 'fresh';
  } catch (err) {
    if (err instanceof ConditionFailed) return 'replay';
    throw err;
  }
}

// F02: refresh token rotation + replay detection.
//
// On every refresh request we try to atomically record the presented jti as
// "consumed". Three outcomes:
//   - 'fresh':    first time this jti is seen. Caller should mint new tokens
//                 (new jti, SAME familyId, so later rotations stay linked).
//   - 'revoked':  the family itself was marked revoked earlier. Deny.
//   - 'replay':   this jti was already consumed. We revoke the whole family
//                 (so any still-outstanding refresh in this chain fails) and
//                 deny this request. This is the classic reuse-detection trap.
export type RefreshRotateResult = 'fresh' | 'replay' | 'revoked';

export async function rotateRefresh(
  jti: string,
  familyId: string,
  refreshExp: number,
): Promise<RefreshRotateResult> {
  // 1. Short-circuit on an already-revoked family.
  const family = await adapter().getItem(`family#${familyId}`);
  if (family?.['revoked'] === true) return 'revoked';

  // 2. Try to record this jti as consumed. If it was already consumed, this is a
  // replay; revoke the family so every outstanding refresh in it dies next time.
  try {
    await adapter().putIfAbsent(`refresh#${jti}`, refreshExp + 60);
    return 'fresh';
  } catch (err) {
    if (err instanceof ConditionFailed) {
      await revokeFamily(familyId, refreshExp);
      return 'replay';
    }
    throw err;
  }
}

export async function revokeFamily(familyId: string, exp: number): Promise<void> {
  // Keep the revocation marker a week past the latest refresh's expiry so a
  // dangling token minted earlier in the chain cannot slip through on the
  // boundary.
  await adapter().putItem(
    `family#${familyId}`,
    { revoked: true },
    exp + 60 * 60 * 24 * 7,
  );
}

// F08: fixed-window rate limit. Returns 'ok' if the request is under the limit
// for this (bucket, window), otherwise 'throttled'. The window is identified by
// floor(now / windowSeconds) so counters reset automatically every window.
//
// `bucket` should name the endpoint plus the identifier (usually source IP):
//   rl#authorize_post#203.0.113.5
// Picking the identifier is the caller's job — different endpoints may want
// different scoping.
export interface RateLimitOpts {
  bucket: string;
  limit: number;
  windowSeconds: number;
}

export async function rateLimit(
  opts: RateLimitOpts,
): Promise<{ ok: boolean; count: number; retryAfter: number }> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / opts.windowSeconds) * opts.windowSeconds;
  const windowEnd = windowStart + opts.windowSeconds;
  const pk = `rl#${opts.bucket}#${windowStart}`;
  const count = await adapter().increment(pk, windowEnd + 60);
  return {
    ok: count <= opts.limit,
    count,
    retryAfter: windowEnd - now,
  };
}
