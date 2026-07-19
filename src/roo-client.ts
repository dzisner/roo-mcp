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
  // `+` and `/` are the base64 characters that would break the path; everything else
  // in a Roo id is alphanumeric or `=`, all of which pass through untouched.
  return id.replace(/[+/]/g, (c) => encodeURIComponent(c));
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
    this.fetchImpl = opts.fetch ?? fetch;
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
