// F04 — redact secrets from add-on payloads before they reach the model.
//
// Context: a webhook configured on a shortlink typically carries secrets in
// one or more of:
//   - endpoint       (e.g. https://hooks.slack.com/services/T.../B.../SECRET)
//   - headers        (Authorization, X-API-Key, X-Signing-Secret…)
//   - queryString    (?api_key=…, ?signature=…)
//   - body           (user-templated; may embed a secret)
//
// The model never needs to SEE the current value to reconfigure it — it
// already has the shortlink id and can issue roo_set_webhook. Returning the
// raw endpoint to the model is equivalent to handing it the bearer token.
//
// Redaction rules:
//   - Webhook endpoint → keep scheme + host + port only, replace path+query with
//     "/[redacted]". Host is still useful ("this webhook posts to slack vs
//     zapier") without being a credential.
//   - Header values   → "[redacted]" (keys stay; "Authorization" present is
//     useful information about the webhook's shape).
//   - Query string values → "[redacted]" (keys stay for the same reason).
//   - Body            → "[redacted]" wholesale. The body is a free-form
//     string; sniffing it for secrets is unreliable and leaving it raw has
//     burned other products.
//
// Non-webhook add-ons (scheduled/clickcount redirect, preview link, QR) carry
// destination URLs or display assets, not secrets. Those pass through
// unchanged. The destination URL of the shortlink itself is public by
// definition (that's the point of a shortener) and is not redacted either.
import type { RooAddOn } from '../types.js';

const REDACTED = '[redacted]';

export function redactAddOnForModel(addOn: RooAddOn): RooAddOn {
  if (addOn.addOn !== 'webhook') return addOn;
  return { ...addOn, data: redactWebhookData(addOn.data) };
}

export function redactWebhookData(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const obj = data as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };

  if (typeof obj.endpoint === 'string') {
    out.endpoint = redactEndpointUrl(obj.endpoint);
  }
  if (obj.headers && typeof obj.headers === 'object' && !Array.isArray(obj.headers)) {
    out.headers = redactStringMap(obj.headers as Record<string, unknown>);
  }
  if (obj.queryString && typeof obj.queryString === 'object' && !Array.isArray(obj.queryString)) {
    out.queryString = redactStringMap(obj.queryString as Record<string, unknown>);
  }
  if (typeof obj.body === 'string' && obj.body.length > 0 && obj.body !== '{}') {
    out.body = REDACTED;
  }
  return out;
}

// Keep the scheme + host + port so the caller can still identify the
// destination service. Everything after the authority — path, query,
// fragment — is replaced, because that's where webhook tokens live.
function redactEndpointUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const authority = `${u.protocol}//${u.host}`;
    return `${authority}/[redacted]`;
  } catch {
    // Unparseable URL — treat the whole string as sensitive.
    return REDACTED;
  }
}

function redactStringMap(m: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === 'string' && v.length > 0) out[k] = REDACTED;
    else out[k] = typeof v === 'string' ? v : REDACTED;
  }
  return out;
}
