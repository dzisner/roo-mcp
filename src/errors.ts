// Normalize every failure into a structured RooError.
// Never leak the API key. Strip stack-trace-like content from server messages
// (Roo occasionally leaks JS TypeError text — see SPEC-NOTES.md).

export type RooErrorCode =
  | 'auth'
  | 'not_found'
  | 'qr_not_enabled'
  | 'validation'
  | 'quota'
  | 'rate_limited'
  | 'transient'
  | 'server'
  | 'network'
  | 'unknown';

export class RooError extends Error {
  readonly code: RooErrorCode;
  readonly status: number | undefined;
  readonly details: unknown;

  constructor(code: RooErrorCode, message: string, status?: number, details?: unknown) {
    super(message);
    this.name = 'RooError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

type HttpErrorArgs =
  | { kind: 'network'; method: string; path: string; cause: unknown }
  | { kind: 'http'; method: string; path: string; status: number; body: unknown };

const STACK_TRACE_PATTERN = /at\s+[^\n]+\n/g;

function safeMessage(body: unknown): string | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return sanitize(body);
  if (typeof body === 'object') {
    const rec = body as Record<string, unknown>;
    if (typeof rec['message'] === 'string') return sanitize(rec['message']);
    if (typeof rec['error'] === 'string') return sanitize(rec['error']);
  }
  return undefined;
}

function sanitize(s: string): string {
  // Roo leaks e.g. "Cannot read properties of null (reading 'permanent')" — pass through
  // (it's short and useful), but strip anything that looks like a stack trace.
  return s.replace(STACK_TRACE_PATTERN, '').trim();
}

export function normalizeHttpError(args: HttpErrorArgs): RooError {
  if (args.kind === 'network') {
    const cause = args.cause;
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    return new RooError('network', `Network error contacting Roo (${args.method} ${args.path}): ${causeMsg}`);
  }
  const { status, body, method, path } = args;
  const msg = safeMessage(body);

  if (status === 401 || status === 403) {
    return new RooError('auth', 'Roo API key is missing or invalid.', status, body);
  }
  if (status === 404) {
    // Special-case the QR-not-enabled 404 per SPEC-NOTES: instruct the caller to set the qrCode add-on first.
    if (msg && /QR settings not enabled/i.test(msg)) {
      return new RooError(
        'qr_not_enabled',
        'This shortlink does not have a QR add-on configured. Call roo_set_qr_addon on it first, then re-fetch the QR code.',
        status,
        body,
      );
    }
    return new RooError('not_found', `Roo could not find that resource (${method} ${path}).`, status, body);
  }
  if (status === 429) {
    return new RooError('rate_limited', msg ?? 'Roo API rate limit exceeded. Retry after a short delay.', status, body);
  }
  if (status >= 400 && status < 500) {
    // 400/422/etc — validation, could also be a quota rejection.
    // Quota shape is not yet known; if/when we see one, add pattern matching here.
    return new RooError(
      'validation',
      msg ?? `Roo rejected the request (${status} on ${method} ${path}).`,
      status,
      body,
    );
  }
  if (status >= 500) {
    return new RooError('server', msg ?? `Roo server error (${status}). Try again shortly.`, status, body);
  }
  return new RooError('unknown', msg ?? `Unexpected ${status} from Roo.`, status, body);
}
