// The five add-on tools. Each maps internally to PATCH /v1/urls/{id}/add-on
// with the discriminated envelope { addOn, enabled: true, data: {...} }.
// See SPEC-NOTES.md for the exact wire shapes and per-type gotchas.
//
// Design note: the data builders (buildXData) and input field shapes (xFields)
// are exported so roo_create_shortlink can compose byte-identical add-on
// payloads when the caller supplies add_ons up front for POST /v1/urls's
// addOns array. Any behavioral divergence between PATCH-set and POST-create
// would be a refactor bug — the wire format is the same in both cases.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RooClient } from '../roo-client.js';
import { encodeRooId } from '../roo-client.js';
import type { RooShortlinkUpdated, RooAddOnType } from '../types.js';
import { RooError } from '../errors.js';

// ── shared helpers ───────────────────────────────────────────────────────

async function setAddOn(
  client: RooClient,
  id: string,
  addOn: RooAddOnType,
  data: unknown,
): Promise<RooShortlinkUpdated> {
  return client.patch<RooShortlinkUpdated>(
    `/v1/urls/${encodeRooId(id)}/add-on`,
    { addOn, enabled: true, data },
  );
}

/** Convert either an ISO 8601 datetime string or a positive epoch-seconds integer to epoch seconds. */
export function parseAt(v: string | number): number {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) throw new RooError('validation', `Invalid epoch seconds: ${v}`);
    return Math.floor(v);
  }
  const parsed = Date.parse(v);
  if (Number.isNaN(parsed)) throw new RooError('validation', `Invalid datetime string: "${v}"`);
  return Math.floor(parsed / 1000);
}

function fenceJson(v: unknown): string {
  return '```json\n' + JSON.stringify(v, null, 2) + '\n```';
}

// ── input field shapes (exported so roo_create_shortlink can reuse) ──────

export const AtSchema = z
  .union([
    z.string().describe('ISO 8601 datetime string, e.g. "2026-08-15T10:00:00Z".'),
    z.number().int().positive().describe('Unix epoch seconds.'),
  ])
  .describe('When the waypoint activates — ISO 8601 datetime or Unix epoch seconds.');

export const scheduledRedirectFields = {
  waypoints: z
    .array(
      z.object({
        url: z.string().min(1).describe('Destination URL to switch to at this waypoint.'),
        at: AtSchema,
      }),
    )
    .min(1)
    .describe(
      "Ordered waypoints. Roo models these as switch points, not windows: at time T the redirect switches to `url` and stays there until the next waypoint. Times before the first waypoint fall through to the shortlink's base url. The tool re-sorts chronologically for safety.",
    ),
} as const;

export const clickCountRedirectFields = {
  thresholds: z
    .array(
      z.object({
        url: z.string().min(1).describe('Destination URL after this many clicks.'),
        click_count: z
          .number()
          .int()
          .min(1)
          .describe('Cumulative click count at which the redirect switches to `url`.'),
      }),
    )
    .min(1)
    .describe(
      'Ordered thresholds (cumulative). After the shortlink accumulates click_count clicks, the destination switches to `url` and stays there until the next threshold. The tool re-sorts ascending for safety.',
    ),
} as const;

export const webhookFields = {
  endpoint: z.string().min(1).describe('Webhook target URL — Roo POSTs (or your chosen method) here on every click.'),
  name: z.string().optional().describe('Display name for the webhook (default: derived from context).'),
  method: z
    .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    .optional()
    .describe('HTTP method (default POST).'),
  content_type: z
    .enum([
      'application/json',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      'application/xml',
      'text/plain',
      'application/octet-stream',
    ])
    .optional()
    .describe('Body content type (default application/json).'),
  body: z
    .string()
    .optional()
    .describe('Request body as a raw STRING (JSON as a string, not an object). Default "{}".'),
  headers: z.record(z.string(), z.string()).optional().describe('Custom HTTP headers.'),
  query_string: z
    .record(z.string(), z.string())
    .optional()
    .describe('Query-string parameters appended to endpoint.'),
  add_metadata: z
    .boolean()
    .optional()
    .describe('Include Roo click metadata (referrer, IP, etc.) in the webhook payload (default true).'),
} as const;

export const previewLinkFields = {
  title: z.string().min(1).describe('Preview title (Open Graph og:title).'),
  description: z.string().min(1).describe('Preview description (Open Graph og:description).'),
  image: z
    .string()
    .optional()
    .describe(
      'Optional preview image. Accepts either a base64 data URI (data:image/...;base64,...) for a new upload, OR a previously-returned image_url to persist the existing image.',
    ),
} as const;

export const qrCodeFields = {
  code_color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional()
    .describe('QR foreground color, hex #RRGGBB (default #000000).'),
  background_color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional()
    .describe('QR background color, hex #RRGGBB (default #FFFFFF).'),
  style: z
    .enum(['mode_1', 'mode_2', 'mode_3', 'mode_4', 'mode_5', 'mode_6', 'mode_7', 'mode_8', 'mode_9'])
    .optional()
    .describe("Dot/corner style — Roo's `qtType` (default mode_1)."),
  scale: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Size multiplier 1-10 (default 4).'),
  logo: z
    .string()
    .optional()
    .describe('Center logo as base64 data URI, or empty string for no logo (default "").'),
  display_roo_logo: z
    .boolean()
    .optional()
    .describe('Show Roo branding on the QR (default false).'),
} as const;

// ── data builders (pure; exported for reuse by roo_create_shortlink) ─────

export interface ScheduledRedirectInput {
  waypoints: Array<{ url: string; at: string | number }>;
}
export interface ScheduledRedirectData {
  schedule: Array<{ url: string; timestamp: number }>;
}
export function buildScheduledRedirectData(input: ScheduledRedirectInput): ScheduledRedirectData {
  const schedule = input.waypoints
    .map((w) => ({ url: w.url, timestamp: parseAt(w.at) }))
    .sort((a, b) => a.timestamp - b.timestamp);
  return { schedule };
}

export interface ClickCountRedirectInput {
  thresholds: Array<{ url: string; click_count: number }>;
}
export interface ClickCountRedirectData {
  schedule: Array<{ url: string; clickCount: number }>;
}
export function buildClickCountRedirectData(input: ClickCountRedirectInput): ClickCountRedirectData {
  const schedule = input.thresholds
    .map((t) => ({ url: t.url, clickCount: t.click_count }))
    .sort((a, b) => a.clickCount - b.clickCount);
  return { schedule };
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type WebhookContentType =
  | 'application/json'
  | 'application/x-www-form-urlencoded'
  | 'multipart/form-data'
  | 'application/xml'
  | 'text/plain'
  | 'application/octet-stream';
export interface WebhookInput {
  endpoint: string;
  name?: string | undefined;
  method?: HttpMethod | undefined;
  content_type?: WebhookContentType | undefined;
  body?: string | undefined;
  headers?: Record<string, string> | undefined;
  query_string?: Record<string, string> | undefined;
  add_metadata?: boolean | undefined;
}
export interface WebhookData {
  name: string;
  method: HttpMethod;
  body: string;
  contentType: WebhookContentType;
  endpoint: string;
  addMetadata: boolean;
  headers: Record<string, string>;
  queryString: Record<string, string>;
}
/**
 * Build webhook wire data. When contextId is provided (e.g. shortlink id in
 * roo_set_webhook), use its prefix in the default name. In the create flow,
 * no id exists yet — pass undefined and get the generic default.
 */
export function buildWebhookData(input: WebhookInput, contextId?: string): WebhookData {
  return {
    name: input.name ?? (contextId ? `roo-mcp-${contextId.slice(0, 8)}` : 'roo-mcp-webhook'),
    method: input.method ?? 'POST',
    body: input.body ?? '{}',
    contentType: input.content_type ?? 'application/json',
    endpoint: input.endpoint,
    addMetadata: input.add_metadata ?? true,
    headers: input.headers ?? {},
    queryString: input.query_string ?? {},
  };
}

export interface PreviewLinkInput {
  title: string;
  description: string;
  image?: string | undefined;
}
export type PreviewImageKind = 'data_uri' | 'hosted_url' | 'none';
export interface PreviewLinkData {
  title: string;
  description: string;
  image?: string;
  image_url?: string;
}
export interface BuiltPreviewLink {
  data: PreviewLinkData;
  image_kind: PreviewImageKind;
}
/** Sniffs `image` into `image` (data URI upload) vs `image_url` (persist existing). */
export function buildPreviewLinkData(input: PreviewLinkInput): BuiltPreviewLink {
  const data: PreviewLinkData = { title: input.title, description: input.description };
  let image_kind: PreviewImageKind = 'none';
  if (input.image !== undefined) {
    if (input.image.startsWith('data:')) {
      data.image = input.image;
      image_kind = 'data_uri';
    } else {
      data.image_url = input.image;
      image_kind = 'hosted_url';
    }
  }
  return { data, image_kind };
}

export type QrStyle =
  | 'mode_1' | 'mode_2' | 'mode_3' | 'mode_4' | 'mode_5' | 'mode_6' | 'mode_7' | 'mode_8' | 'mode_9';
export interface QrCodeInput {
  code_color?: string | undefined;
  background_color?: string | undefined;
  style?: QrStyle | undefined;
  scale?: number | undefined;
  logo?: string | undefined;
  display_roo_logo?: boolean | undefined;
}
export interface QrCodeData {
  codeColor: string;
  backgroundColor: string;
  qtType: QrStyle;
  scale: number;
  logo: string;
  displayRooLogo: boolean;
}
export function buildQrCodeData(input: QrCodeInput = {}): QrCodeData {
  return {
    codeColor: input.code_color ?? '#000000',
    backgroundColor: input.background_color ?? '#FFFFFF',
    qtType: input.style ?? 'mode_1',
    scale: input.scale ?? 4,
    logo: input.logo ?? '',
    displayRooLogo: input.display_roo_logo ?? false,
  };
}

// ── tool input schemas (id prefix + field shape) ─────────────────────────

const idField = { id: z.string().min(1).describe('Shortlink id.') };

const ScheduledRedirectToolInput = { ...idField, ...scheduledRedirectFields };
const ClickCountRedirectToolInput = { ...idField, ...clickCountRedirectFields };
const WebhookToolInput = { ...idField, ...webhookFields };
const PreviewLinkToolInput = { ...idField, ...previewLinkFields };
const QrAddonToolInput = { ...idField, ...qrCodeFields };

// ── registration ─────────────────────────────────────────────────────────

export function registerAddOnTools(server: McpServer, client: RooClient): void {
  server.registerTool(
    'roo_set_scheduled_redirect',
    {
      title: 'Roo — set scheduled redirect',
      description:
        'Time-based redirect: attach or replace waypoints on the shortlink. Each waypoint is a { url, at } pair — at time T the redirect switches to `url` and stays until the next waypoint. Before the first waypoint the shortlink falls through to its base url. Roo has no timezone or per-waypoint end field.',
      inputSchema: ScheduledRedirectToolInput,
    },
    async ({ id, waypoints }) => {
      const data = buildScheduledRedirectData({ waypoints });
      await setAddOn(client, id, 'scheduledRedirect', data);
      return {
        content: [
          {
            type: 'text',
            text: `Set scheduled redirect on ${id} with ${data.schedule.length} waypoint${data.schedule.length === 1 ? '' : 's'}.`,
          },
          { type: 'text', text: fenceJson({ id, schedule: data.schedule }) },
        ],
      };
    },
  );

  server.registerTool(
    'roo_set_click_count_redirect',
    {
      title: 'Roo — set click-count redirect',
      description:
        'Click-count redirect: attach or replace cumulative thresholds on the shortlink. After the shortlink accumulates click_count clicks, the destination switches to `url` and stays until the next threshold. Order thresholds by increasing click_count; the tool re-sorts.',
      inputSchema: ClickCountRedirectToolInput,
    },
    async ({ id, thresholds }) => {
      const data = buildClickCountRedirectData({ thresholds });
      await setAddOn(client, id, 'clickCountRedirect', data);
      return {
        content: [
          {
            type: 'text',
            text: `Set click-count redirect on ${id} with ${data.schedule.length} threshold${data.schedule.length === 1 ? '' : 's'}.`,
          },
          { type: 'text', text: fenceJson({ id, schedule: data.schedule }) },
        ],
      };
    },
  );

  server.registerTool(
    'roo_set_webhook',
    {
      title: 'Roo — set webhook',
      description:
        'Fire an HTTP request to `endpoint` on every click. Roo requires 8 fields; this tool defaults 7 of them — you only need to provide the endpoint. The webhook does NOT change where the shortlink redirects to; the destination is unchanged.',
      inputSchema: WebhookToolInput,
    },
    async ({ id, endpoint, name, method, content_type, body, headers, query_string, add_metadata }) => {
      const data = buildWebhookData(
        { endpoint, name, method, content_type, body, headers, query_string, add_metadata },
        id,
      );
      await setAddOn(client, id, 'webhook', data);
      return {
        content: [
          { type: 'text', text: `Set webhook on ${id}: ${data.method} ${endpoint}` },
          { type: 'text', text: fenceJson({ id, data }) },
        ],
      };
    },
  );

  server.registerTool(
    'roo_set_preview_link',
    {
      title: 'Roo — set preview link',
      description:
        "Control how the shortlink unfurls on social/chat (Open Graph title/description/image). `image` accepts either a base64 data URI for a new upload, or a previously-returned image_url to keep the current image.",
      inputSchema: PreviewLinkToolInput,
    },
    async ({ id, title, description, image }) => {
      const { data, image_kind } = buildPreviewLinkData({ title, description, image });
      await setAddOn(client, id, 'previewLink', data);
      return {
        content: [
          {
            type: 'text',
            text: `Set preview link on ${id}: "${title}"${image_kind !== 'none' ? ` (image: ${image_kind})` : ''}`,
          },
          { type: 'text', text: fenceJson({ id, title, description, image_kind }) },
        ],
      };
    },
  );

  server.registerTool(
    'roo_set_qr_addon',
    {
      title: 'Roo — configure QR add-on',
      description:
        'Configure and enable the QR code add-on on a shortlink. Roo requires all 6 fields; the tool defaults them all. After this succeeds, use roo_get_qr_code to fetch the rendered image.',
      inputSchema: QrAddonToolInput,
    },
    async ({ id, code_color, background_color, style, scale, logo, display_roo_logo }) => {
      const data = buildQrCodeData({ code_color, background_color, style, scale, logo, display_roo_logo });
      await setAddOn(client, id, 'qrCode', data);
      return {
        content: [
          {
            type: 'text',
            text: `Configured QR add-on on ${id} (style=${data.qtType}, scale=${data.scale}, code=${data.codeColor} on ${data.backgroundColor}).`,
          },
          { type: 'text', text: fenceJson({ id, data }) },
        ],
      };
    },
  );
}
