// Thin fetch wrapper around the Roo REST API.
// - Auth: x-api-key header (confirmed via spec + probes; NOT Bearer).
// - Base URL: https://api.roo.bz — versioned paths (e.g. /v1/me) are passed by the caller.
// - Every response is parsed as JSON; non-2xx statuses raise a normalized RooError via errors.ts.
// - Never logs the API key.
import { normalizeHttpError } from './errors.js';

const DEFAULT_BASE_URL = 'https://api.roo.bz';

/**
 * Encode a Roo shortlink id for use as a URL path segment.
 *
 * Roo mints ids as `base64(host + "/" + slug)`, which produces trailing `=` padding
 * whenever the encoded string length is not divisible by 3. Roo's URL routing accepts
 * padded ids with raw `=` in the path but **rejects the URL-encoded `%3D` form** with
 * 404 (or, on GET, a 500-ish "Cannot read properties of null" error). This affects
 * roughly 2/3 of possible slug lengths — i.e. most real shortlinks.
 *
 * `encodeURIComponent` encodes `=` → `%3D`, which triggers the bug. This helper
 * encodes only the characters that are genuinely unsafe in a URL path segment
 * (`+` and `/`), leaving `=` raw. Verified 2026-07-05 against every relevant
 * endpoint (GET/PATCH/PATCH-addon/PATCH-permanent-shortlink/GET-qr-code) on a
 * padded id — all succeeded with raw `=`, all failed with `%3D`. See SPEC-NOTES.md.
 */
export function encodeRooId(id: string): string {
  // F05 — validate FIRST so a crafted id cannot reach the Roo API as part of a
  // URL path, even indirectly. Every call site that builds a Roo path via this
  // helper gets the check for free.
  validateRooId(id);
  // `+` and `/` are the base64 characters that would break the path; everything else
  // in a Roo id is alphanumeric or `=`, all of which pass through untouched.
  return id.replace(/[+/]/g, (c) => encodeURIComponent(c));
}

/**
 * F05 — validate a shortlink id before it reaches the Roo API.
 *
 * Roo mints ids as `base64(host + "/" + slug)`, so the id is always drawn from
 * the standard base64 alphabet (`A-Z a-z 0-9 + / =`). Anything outside that
 * alphabet — control chars, Unicode tricks, path-traversal segments, URL-
 * injection payloads — is guaranteed to be either a mistake or an attack, and
 * MUST be rejected at the tool boundary rather than URL-encoded and sent to
 * Roo. Length bounds are generous (host+slug keeps ids short in practice; the
 * upper bound catches obvious abuse without being tight to today's usage).
 *
 * Throws RooError('invalid_id', ...) rather than returning false so callers
 * can't accidentally forget to check the return value.
 */
const ROO_ID_PATTERN = /^[A-Za-z0-9+/=]+$/;
const ROO_ID_MIN_LENGTH = 4;
const ROO_ID_MAX_LENGTH = 256;

export function validateRooId(id: string, label: string = 'id'): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${label} is required.`);
  }
  if (id.length < ROO_ID_MIN_LENGTH || id.length > ROO_ID_MAX_LENGTH) {
    throw new Error(
      `${label} must be between ${ROO_ID_MIN_LENGTH} and ${ROO_ID_MAX_LENGTH} characters (got ${id.length}).`,
    );
  }
  if (!ROO_ID_PATTERN.test(id)) {
    throw new Error(
      `${label} contains characters outside the Roo shortlink alphabet (A-Z, a-z, 0-9, +, /, =). This is not a valid Roo shortlink id.`,
    );
  }
}

export interface RooClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export class RooClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RooClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    // Bind to globalThis so storing the global `fetch` as a property doesn't strip its receiver.
    // Required on Cloudflare Workers (otherwise: "Illegal invocation: function called with incorrect `this` reference").
    this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
  }

  async request<T = unknown>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const url = this.baseUrl + path;
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (cause) {
      throw normalizeHttpError({ kind: 'network', method, path, cause });
    }
    const text = await res.text();
    let parsed: unknown;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      throw normalizeHttpError({ kind: 'http', method, path, status: res.status, body: parsed });
    }
    return parsed as T;
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }
}
