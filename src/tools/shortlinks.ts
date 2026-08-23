// Shortlink CRUD tools.
// Wire-level notes (see SPEC-NOTES.md for the full picture):
// - Destination URL field is `url` on write, `Attributes.TargetUrl` on read.
// - Custom domain is `customDomain` on write (lowercase c), `CustomDomain` on read (uppercase C).
// - `id` on read lives in `PK` as "URL#<id>" — strip the prefix.
// - List items don't include shortUrl / shortUrlNoProtocol / top-level slug — derive from CustomDomain.
// - Pagination: request `limit` + `lastKey`; response returns `nextKey`. No `search` param exists.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import { isAbsolute as pathIsAbsolute } from 'node:path';
import type { RooClient } from '../roo-client.js';
import { encodeRooId } from '../roo-client.js';
import type {
  RooShortlinkRecord,
  RooShortlinkList,
  RooShortlinkCreated,
  RooShortlinkUpdated,
  RooAddOn,
  RooFolderPath,
  RooShortlinkCreateBody,
  RooShortlinkPatchBody,
  RooPermanentSettingsPatchBody,
  RooQrCodeResponse,
  RooCustomDomainsResponse,
  RooCustomDomainRecord,
} from '../types.js';
import { RooError } from '../errors.js';
import {
  scheduledRedirectFields,
  clickCountRedirectFields,
  webhookFields,
  previewLinkFields,
  qrCodeFields,
  buildScheduledRedirectData,
  buildClickCountRedirectData,
  buildWebhookData,
  buildPreviewLinkData,
  buildQrCodeData,
  type ScheduledRedirectInput,
  type ClickCountRedirectInput,
  type WebhookInput,
  type PreviewLinkInput,
  type QrCodeInput,
} from './addons.js';

// ── Input schemas ────────────────────────────────────────────────────────

const CustomDomainInput = z.object({
  domain: z
    .string()
    .min(1)
    .optional()
    .describe('The custom domain host (e.g. "roo.ws" or your verified domain).'),
  slug: z
    .string()
    .min(1)
    .optional()
    .describe('The desired slug (the path after the domain). Must be unique for the domain.'),
  alternative_slug: z
    .boolean()
    .optional()
    .describe('If true and the requested slug is taken, Roo falls back to a random slug instead of erroring.'),
});

const ListInputSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max shortlinks to return in this page (Roo picks a server-side default if omitted)."),
  cursor: z
    .string()
    .optional()
    .describe("Pagination cursor. Pass the `next_cursor` from the previous page's response."),
};

// Nested add-on schemas — reuse the SAME Zod field shapes as the roo_set_* tools,
// so the LLM fills identical structures whether via create-with-addons or via the
// individual set-tools. Wire-format equivalence is guaranteed by Phase 1's builders.
const AddOnsInput = z
  .object({
    scheduled_redirect: z
      .object(scheduledRedirectFields)
      .optional()
      .describe('Time-based redirect. See roo_set_scheduled_redirect for waypoint semantics.'),
    click_count_redirect: z
      .object(clickCountRedirectFields)
      .optional()
      .describe('Cumulative click-count redirect. See roo_set_click_count_redirect for threshold semantics.'),
    webhook: z
      .object(webhookFields)
      .optional()
      .describe('Fire an HTTP request on every click. See roo_set_webhook for defaulting.'),
    preview_link: z
      .object(previewLinkFields)
      .optional()
      .describe('Open Graph unfurl override. See roo_set_preview_link for image handling.'),
    qr: z
      .object(qrCodeFields)
      .optional()
      .describe('Enable QR code add-on. See roo_set_qr_addon for defaults. When present, the create response includes the pre-rendered QR image inline — no follow-up roo_get_qr_code needed.'),
  })
  .describe(
    'Optional add-ons to attach in the SAME request as create — atomic and one API call instead of six. When absent, you can still add these later via roo_set_* tools.',
  );

const CreateInputSchema = {
  url: z.string().min(1).describe('Destination URL the shortlink redirects to.'),
  custom_domain: CustomDomainInput
    .optional()
    .describe('Optional: attach to a custom domain and/or request a specific slug.'),
  add_ons: AddOnsInput.optional(),
};

const GetInputSchema = {
  id: z.string().min(1).describe('Shortlink id (as returned by create or list).'),
};

const UpdateInputSchema = {
  id: z.string().min(1).describe('Shortlink id to update.'),
  url: z.string().min(1).optional().describe('New destination URL.'),
  custom_domain: CustomDomainInput
    .optional()
    .describe('Change the custom-domain/slug binding.'),
};

const MakePermanentInputSchema = {
  id: z.string().min(1).describe("Shortlink id to mark permanent (opts the link out of the plan's auto-expiry)."),
};

const UpdatePermanentSettingsInputSchema = {
  id: z.string().min(1).describe('Shortlink id.'),
  permanent: z
    .boolean()
    .optional()
    .describe('Set false to un-make a link permanent (allow it to auto-expire again); true to make it permanent.'),
};

const GetQrCodeInputSchema = {
  id: z.string().min(1).describe('Shortlink id.'),
  save_to: z
    .string()
    .optional()
    .describe(
      'Optional ABSOLUTE filesystem path. If provided, the QR image is decoded and written to that path; the tool returns the path instead of embedding the image. Parent directory must already exist.',
    ),
};

const ListCustomDomainsInputSchema = {
  status_filter: z
    .string()
    .optional()
    .describe(
      'Optional status filter. Known values: "Issued" (verified + active), "Pending" (verification in progress). Omit to return all domains regardless of status.',
    ),
};

// ── Normalized output shapes (snake_case, for the model) ─────────────────

// Roo-owned domains that shortlinks may live on WITHOUT counting as a
// customer custom domain. Verified against GET /v1/account/custom-domains
// on an account with a real custom domain — `roo.ws` and `roo.bz` never
// appear there, only actual customer-owned domains do.
const DEFAULT_ROO_DOMAINS = new Set(['roo.ws', 'roo.bz']);
function isRooDefault(domain: string | null | undefined): boolean {
  return domain != null && DEFAULT_ROO_DOMAINS.has(domain);
}

interface NormalizedAddOn {
  type: string;
  enabled: boolean;
  data: unknown;
}

interface NormalizedShortlink {
  id: string;
  slug: string | null;
  short_url: string | null;
  short_url_no_protocol: string | null;
  destination_url: string | null;
  created_at: string | null;
  updated_at: string | null;
  click_count: number;
  permanent: boolean;
  folder_id: string | null;
  folder_paths: RooFolderPath[];
  description: string | null;
  /** The hosting domain — "roo.ws" (Roo's default) or the account's custom domain. */
  domain: string | null;
  /** True iff `domain` is a custom domain (i.e. not "roo.ws"). Populated from CustomDomain.domain on read. */
  is_custom_domain: boolean;
  add_ons: NormalizedAddOn[];
}

interface CompactShortlink {
  id: string;
  slug: string | null;
  short_url: string | null;
  destination_url: string | null;
  created_at: string | null;
  click_count: number;
  permanent: boolean;
  domain: string | null;
  is_custom_domain: boolean;
  add_on_types: string[];
}

// ── Tool registration ────────────────────────────────────────────────────

export function registerShortlinkTools(server: McpServer, client: RooClient): void {
  server.registerTool(
    'roo_list_shortlinks',
    {
      title: 'Roo — list shortlinks',
      description:
        'List shortlinks on the account (cursor-paginated, most-recent first). Returns compact items — call roo_get_shortlink for full detail on one.',
      inputSchema: ListInputSchema,
    },
    async ({ limit, cursor }) => {
      const q = new URLSearchParams();
      if (limit != null) q.set('limit', String(limit));
      if (cursor != null) q.set('lastKey', cursor);
      const path = q.toString() ? `/v1/urls?${q.toString()}` : '/v1/urls';
      const res = await client.get<RooShortlinkList>(path);
      const items = (res.items ?? []).map(normalizeShortlink).map(toCompact);
      const payload = { items, next_cursor: res.nextKey ?? null };
      return {
        content: [
          { type: 'text', text: renderListSummary(items, res.nextKey) },
          { type: 'text', text: fenceJson(payload) },
        ],
      };
    },
  );

  server.registerTool(
    'roo_create_shortlink',
    {
      title: 'Roo — create shortlink',
      description:
        'Create a shortlink that redirects to `url`. Optionally attach to a custom domain, request a slug, and/or configure add-ons up front. Passing `add_ons` creates the shortlink AND attaches every listed add-on in a single API call. When `add_ons.qr` is included, the pre-rendered QR image comes back inline in the response.',
      inputSchema: CreateInputSchema,
    },
    async ({ url, custom_domain, add_ons }) => {
      const body: RooShortlinkCreateBody = { url };
      const cd = toWireCustomDomain(custom_domain);
      if (cd !== undefined) body.customDomain = cd;

      // Build addOns[] by delegating to Phase 1 builders. Same wire format as PATCH set-tools.
      // No contextId is available (shortlink id doesn't exist yet) — buildWebhookData picks
      // the generic default name.
      const addOnEntries = buildAddOnEntries(add_ons);
      if (addOnEntries.length > 0) body.addOns = addOnEntries;

      const res = await client.post<RooShortlinkCreated>('/v1/urls', body);

      const requestedAddOnTypes = addOnEntries.map((a) => a.addOn);
      const payload = {
        id: res.id,
        short_url: res.shortUrl ?? null,
        short_url_no_protocol: res.shortUrlNoProtocol ?? null,
        slug: res.slug ?? null,
        add_ons_attached: requestedAddOnTypes,
        ...(res.qrCode ? { qr_code_inline: { mime_type: res.qrCode.mimeType, bytes: qrByteLength(res.qrCode.base64) } } : {}),
      };

      const summaryLines: string[] = [
        `Created ${res.shortUrl ?? '(no short URL returned)'} → ${url}`,
        `id: ${res.id}${res.slug ? `   slug: ${res.slug}` : ''}`,
      ];
      if (requestedAddOnTypes.length > 0) {
        summaryLines.push(`add-ons attached in the same call: ${requestedAddOnTypes.join(', ')}`);
      }

      const content: Array<
        { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
      > = [
        { type: 'text', text: summaryLines.join('\n') },
      ];

      // Surface the pre-rendered QR image inline (Phase 5 behavior — no follow-up call needed).
      if (res.qrCode) {
        const rawB64 = res.qrCode.base64.replace(/^data:[^;]+;base64,/, '');
        content.push({ type: 'image', data: rawB64, mimeType: res.qrCode.mimeType });
      }

      content.push({ type: 'text', text: fenceJson(payload) });

      return { content };
    },
  );

  server.registerTool(
    'roo_get_shortlink',
    {
      title: 'Roo — get shortlink',
      description:
        'Fetch full detail of one shortlink by id — destination, custom domain, click count, permanence, folder, description, and any add-ons.',
      inputSchema: GetInputSchema,
    },
    async ({ id }) => {
      const res = await client.get<RooShortlinkRecord>(`/v1/urls/${encodeRooId(id)}`);
      const norm = normalizeShortlink(res);
      return {
        content: [
          { type: 'text', text: renderShortlinkSummary(norm) },
          { type: 'text', text: fenceJson(norm) },
        ],
      };
    },
  );

  server.registerTool(
    'roo_update_shortlink',
    {
      title: 'Roo — update shortlink',
      description:
        'Update a shortlink. Change the destination URL and/or the custom-domain binding. Only fields you pass are sent. To change add-ons, use the roo_set_* tools; to make/unmake permanent, use roo_make_permanent.',
      inputSchema: UpdateInputSchema,
    },
    async ({ id, url, custom_domain }) => {
      const body: RooShortlinkPatchBody = {};
      if (url !== undefined) body.url = url;
      const cd = toWireCustomDomain(custom_domain);
      if (cd !== undefined) body.customDomain = cd;
      if (Object.keys(body).length === 0) {
        throw new RooError(
          'validation',
          'roo_update_shortlink requires at least one of: url, custom_domain.',
        );
      }
      const res = await client.patch<RooShortlinkUpdated>(`/v1/urls/${encodeRooId(id)}`, body);
      const payload = { id: res.id ?? id, message: res.message ?? '' };
      const summary = `Updated ${id}${res.message ? ` — ${res.message}` : ''}`;
      return {
        content: [
          { type: 'text', text: summary },
          { type: 'text', text: fenceJson(payload) },
        ],
      };
    },
  );

  server.registerTool(
    'roo_make_permanent',
    {
      title: 'Roo — make shortlink permanent',
      description:
        "Mark a shortlink as permanent — it stops participating in the plan's auto-expiry (Hop = 90 days). Counts against the account's permanent-shortlink limit. To un-make a link permanent, use roo_update_permanent_settings with { permanent: false }.",
      inputSchema: MakePermanentInputSchema,
    },
    async ({ id }) => {
      const body: RooPermanentSettingsPatchBody = { permanent: true };
      const res = await client.patch<RooShortlinkUpdated>(
        `/v1/urls/${encodeRooId(id)}/permanent-shortlink`,
        body,
      );
      const payload = { id: res.id ?? id, permanent: true, message: res.message ?? '' };
      return {
        content: [
          { type: 'text', text: `Marked ${id} permanent.` },
          { type: 'text', text: fenceJson(payload) },
        ],
      };
    },
  );

  server.registerTool(
    'roo_update_permanent_settings',
    {
      title: 'Roo — update permanent settings',
      description:
        "Update permanent-mode settings on a shortlink. Today the only verified field is `permanent` (true/false) — additional fields may be accepted by the endpoint in the future; only fields you pass are sent.",
      inputSchema: UpdatePermanentSettingsInputSchema,
    },
    async ({ id, permanent }) => {
      const body: RooPermanentSettingsPatchBody = {};
      if (permanent !== undefined) body.permanent = permanent;
      if (Object.keys(body).length === 0) {
        throw new RooError(
          'validation',
          'roo_update_permanent_settings requires at least one field to update (currently: permanent).',
        );
      }
      const res = await client.patch<RooShortlinkUpdated>(
        `/v1/urls/${encodeRooId(id)}/permanent-shortlink`,
        body,
      );
      const payload = { id: res.id ?? id, applied: body, message: res.message ?? '' };
      return {
        content: [
          { type: 'text', text: `Updated permanent settings for ${id}: ${JSON.stringify(body)}` },
          { type: 'text', text: fenceJson(payload) },
        ],
      };
    },
  );

  server.registerTool(
    'roo_list_custom_domains',
    {
      title: 'Roo — list custom domains',
      description:
        'List every custom domain attached to the account, with each one\'s status and verification details. Authoritative — this is the same data the Roo web app uses. Distinct from the domain a particular SHORTLINK is on (a shortlink can be on `roo.ws` or `roo.bz` — Roo-owned defaults — without any custom domain being attached).',
      inputSchema: ListCustomDomainsInputSchema,
    },
    async ({ status_filter }) => {
      const q = new URLSearchParams();
      if (status_filter !== undefined) q.set('filter', status_filter);
      const path = q.toString() ? `/v1/account/custom-domains?${q.toString()}` : '/v1/account/custom-domains';
      const res = await client.get<RooCustomDomainsResponse>(path);
      const domains = (res.domains ?? []).map(normalizeCustomDomain);
      const payload = {
        domains,
        count: domains.length,
        ...(status_filter !== undefined ? { status_filter } : {}),
      };
      const summary =
        domains.length === 0
          ? status_filter
            ? `No custom domains with status "${status_filter}".`
            : 'No custom domains attached to this account.'
          : `${domains.length} custom domain${domains.length === 1 ? '' : 's'}:\n` +
            domains
              .map((d) => `  ${d.domain}${d.subdomain ? ` (subdomain: ${d.subdomain})` : ''} — ${d.status ?? '(no status)'}${d.created_at ? `, added ${d.created_at.slice(0, 10)}` : ''}`)
              .join('\n');
      return {
        content: [
          { type: 'text', text: summary },
          { type: 'text', text: fenceJson(payload) },
        ],
      };
    },
  );

  server.registerTool(
    'roo_get_qr_code',
    {
      title: 'Roo — get shortlink QR image',
      description:
        'Fetch the QR image for a shortlink. Requires the qrCode add-on to already be configured on the shortlink (via roo_set_qr_addon) — otherwise Roo returns a qr_not_enabled error. By default returns the image inline as an MCP image content block; pass save_to (absolute path) to write the bytes to a file instead.',
      inputSchema: GetQrCodeInputSchema,
    },
    async ({ id, save_to }) => {
      const res = await client.get<RooQrCodeResponse>(
        `/v1/urls/${encodeRooId(id)}/qr-code`,
      );
      if (!res.success || !res.data) {
        throw new RooError(
          'server',
          `Roo returned an unexpected QR response${res.message ? ` — ${res.message}` : ''}.`,
        );
      }
      const { mimeType, base64: dataUri } = res.data;
      const rawBase64 = dataUri.replace(/^data:[^;]+;base64,/, '');
      const bytes = Buffer.from(rawBase64, 'base64');

      if (save_to !== undefined) {
        if (!pathIsAbsolute(save_to)) {
          throw new RooError('validation', 'save_to must be an absolute filesystem path.');
        }
        try {
          await writeFile(save_to, bytes);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new RooError('unknown', `Failed to write QR image to ${save_to}: ${msg}`);
        }
        return {
          content: [
            { type: 'text', text: `Saved ${bytes.length}-byte ${mimeType} QR for ${id} → ${save_to}` },
            { type: 'text', text: fenceJson({ id, saved_to: save_to, mime_type: mimeType, bytes: bytes.length }) },
          ],
        };
      }

      return {
        content: [
          { type: 'text', text: `QR code for ${id} (${mimeType}, ${bytes.length} bytes):` },
          { type: 'image', data: rawBase64, mimeType },
          { type: 'text', text: fenceJson({ id, mime_type: mimeType, bytes: bytes.length }) },
        ],
      };
    },
  );
}

// ── Normalization ────────────────────────────────────────────────────────

function normalizeShortlink(raw: RooShortlinkRecord): NormalizedShortlink {
  const idFromPk = raw.PK?.replace(/^URL#/, '');
  const rawDomain = raw.CustomDomain?.domain ?? null;
  const slug = raw.slug ?? raw.CustomDomain?.slug ?? null;
  const shortUrl =
    raw.shortUrl ?? (rawDomain && slug ? `https://${rawDomain}/${slug}` : null);
  const shortUrlNoProtocol =
    raw.shortUrlNoProtocol ??
    (shortUrl ? shortUrl.replace(/^https?:\/\//, '') : null);
  const id = idFromPk ?? slug ?? '';
  return {
    id,
    slug,
    short_url: shortUrl,
    short_url_no_protocol: shortUrlNoProtocol,
    destination_url: raw.Attributes?.TargetUrl ?? null,
    created_at: epochToIso(raw.CreatedDate),
    updated_at: epochToIso(raw.UpdatedDate),
    click_count: typeof raw.Counter === 'number' ? raw.Counter : 0,
    permanent: raw.Attributes?.Permanent === true,
    folder_id: raw.FolderId ?? null,
    folder_paths: Array.isArray(raw.FolderPaths) ? raw.FolderPaths : [],
    description: raw.Description ?? null,
    domain: rawDomain,
    is_custom_domain: rawDomain != null && !isRooDefault(rawDomain),
    add_ons: (raw.addOns ?? []).map(normalizeAddOn),
  };
}

function normalizeAddOn(a: RooAddOn): NormalizedAddOn {
  return { type: a.addOn, enabled: a.enabled, data: a.data };
}

interface NormalizedCustomDomain {
  id: string;
  domain: string | null;
  subdomain: string | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
  verification: {
    acm_cnames: Array<{ name: string | null; type: string | null; value: string | null }>;
    cloudfront_cname: string | null;
  };
}

function normalizeCustomDomain(raw: RooCustomDomainRecord): NormalizedCustomDomain {
  const idFromPk = raw.PK?.replace(/^DOMAIN#/, '') ?? '';
  return {
    id: idFromPk,
    domain: raw.Attributes?.domain ?? null,
    subdomain: raw.Attributes?.subdomain ?? null,
    status: raw.Status ?? null,
    created_at: epochToIso(raw.CreatedDate),
    updated_at: epochToIso(raw.UpdatedDate),
    verification: {
      acm_cnames: (raw.Attributes?.acm?.cname ?? []).map((c) => ({
        name: c.name ?? null,
        type: c.type ?? null,
        value: c.value ?? null,
      })),
      cloudfront_cname: raw.Attributes?.cloudfront?.cname ?? null,
    },
  };
}

function toCompact(n: NormalizedShortlink): CompactShortlink {
  return {
    id: n.id,
    slug: n.slug,
    short_url: n.short_url,
    destination_url: n.destination_url,
    created_at: n.created_at,
    click_count: n.click_count,
    permanent: n.permanent,
    domain: n.domain,
    is_custom_domain: n.is_custom_domain,
    add_on_types: n.add_ons.map((a) => a.type),
  };
}

/**
 * Compose the addOns[] array for POST /v1/urls from the tool's nested add_ons input.
 * Every present sub-key produces one entry via the exact same builder used by roo_set_*,
 * so the wire format is byte-identical whether the caller uses this path or the PATCH tools.
 * Exported for HAR-fixture regression tests in scripts/.
 */
export function buildAddOnEntries(
  input:
    | {
        scheduled_redirect?: ScheduledRedirectInput | undefined;
        click_count_redirect?: ClickCountRedirectInput | undefined;
        webhook?: WebhookInput | undefined;
        preview_link?: PreviewLinkInput | undefined;
        qr?: QrCodeInput | undefined;
      }
    | undefined,
): RooAddOn[] {
  if (!input) return [];
  const entries: RooAddOn[] = [];
  if (input.scheduled_redirect) {
    entries.push({
      addOn: 'scheduledRedirect',
      enabled: true,
      data: buildScheduledRedirectData(input.scheduled_redirect),
    });
  }
  if (input.click_count_redirect) {
    entries.push({
      addOn: 'clickCountRedirect',
      enabled: true,
      data: buildClickCountRedirectData(input.click_count_redirect),
    });
  }
  if (input.webhook) {
    entries.push({
      addOn: 'webhook',
      enabled: true,
      data: buildWebhookData(input.webhook), // no contextId — shortlink id doesn't exist yet
    });
  }
  if (input.preview_link) {
    entries.push({
      addOn: 'previewLink',
      enabled: true,
      data: buildPreviewLinkData(input.preview_link).data,
    });
  }
  if (input.qr) {
    entries.push({
      addOn: 'qrCode',
      enabled: true,
      data: buildQrCodeData(input.qr),
    });
  }
  return entries;
}

/** Approximate byte length of a base64 payload (with or without the data-URI prefix). */
function qrByteLength(dataUriOrBase64: string): number {
  const raw = dataUriOrBase64.replace(/^data:[^;]+;base64,/, '');
  // Every 4 base64 chars = 3 bytes, minus padding.
  const pad = (raw.match(/=+$/)?.[0].length ?? 0);
  return Math.floor((raw.length * 3) / 4) - pad;
}

function toWireCustomDomain(
  input?: { domain?: string | undefined; slug?: string | undefined; alternative_slug?: boolean | undefined } | undefined,
): { domain?: string; slug?: string; alternativeSlug?: boolean } | undefined {
  if (!input) return undefined;

  // Custom slugs are only supported on customer-owned custom domains — Roo's shared
  // defaults (roo.ws, roo.bz) reject them. Slug without domain silently no-ops on
  // Roo's side (the link is created but with a random slug). Fail fast client-side
  // with a message that tells the caller how to fix it. Verified 2026-08-23:
  // `{ domain: "roo.ws", slug: "foo" }` → "Custom Domain doesn't exist."
  // `{ slug: "foo" }` (no domain) → silent random-slug fallback.
  if (input.slug !== undefined && input.domain === undefined) {
    throw new RooError(
      'validation',
      'Custom slugs are only supported on a custom domain. Provide `custom_domain.domain` (e.g. your verified domain from roo_list_custom_domains) alongside `slug`, or omit `slug` to accept a random slug on the default roo.ws domain.',
    );
  }
  if (input.domain !== undefined && isRooDefault(input.domain) && input.slug !== undefined) {
    throw new RooError(
      'validation',
      `Cannot set a custom slug on \`${input.domain}\` — that's a Roo-owned default domain, not a custom one. Custom slugs require the account's own custom domain (see roo_list_custom_domains). Omit \`custom_domain\` entirely to get a random slug on roo.ws.`,
    );
  }

  const out: { domain?: string; slug?: string; alternativeSlug?: boolean } = {};
  if (input.domain !== undefined) out.domain = input.domain;
  if (input.slug !== undefined) out.slug = input.slug;
  if (input.alternative_slug !== undefined) out.alternativeSlug = input.alternative_slug;
  return Object.keys(out).length > 0 ? out : undefined;
}

function epochToIso(v: number | undefined): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const ms = v > 1e12 ? v : v * 1000;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

// ── Rendering ────────────────────────────────────────────────────────────

function renderListSummary(items: CompactShortlink[], nextKey: string | undefined): string {
  if (items.length === 0) return 'No shortlinks on this page.';
  const lines: string[] = [];
  lines.push(`${items.length} shortlink${items.length === 1 ? '' : 's'}:`);
  for (const it of items) {
    const flags: string[] = [];
    if (it.is_custom_domain) flags.push(`custom domain: ${it.domain}`);
    if (it.permanent) flags.push('permanent');
    if (it.add_on_types.length > 0) flags.push(`add-ons: ${it.add_on_types.join(', ')}`);
    const flagStr = flags.length > 0 ? ` [${flags.join('; ')}]` : '';
    lines.push(`  ${it.short_url ?? '(no url)'} → ${it.destination_url ?? '(?)'}  · ${it.click_count} click${it.click_count === 1 ? '' : 's'}${flagStr}`);
  }
  if (nextKey) lines.push(`(more available — next_cursor set)`);
  return lines.join('\n');
}

function renderShortlinkSummary(n: NormalizedShortlink): string {
  const lines: string[] = [];
  lines.push(`${n.short_url ?? '(no short URL)'} → ${n.destination_url ?? '(?)'}`);
  lines.push(`id: ${n.id}${n.slug ? `   slug: ${n.slug}` : ''}   domain: ${n.domain ?? '(?)'}${n.is_custom_domain ? ' (custom)' : ' (Roo default)'}`);
  const flags: string[] = [];
  if (n.permanent) flags.push('permanent');
  if (n.add_ons.length > 0) flags.push(`add-ons: ${n.add_ons.map((a) => a.type).join(', ')}`);
  if (n.folder_paths.length > 0) flags.push(`folder: ${n.folder_paths.map((f) => f.name).join(' / ')}`);
  if (flags.length > 0) lines.push(flags.join('  ·  '));
  lines.push(`clicks: ${n.click_count}${n.created_at ? `   created: ${n.created_at}` : ''}`);
  return lines.join('\n');
}

function fenceJson(v: unknown): string {
  return '```json\n' + JSON.stringify(v, null, 2) + '\n```';
}

// Re-export for possible tests
export const _internal = { normalizeShortlink, toCompact, toWireCustomDomain, epochToIso };
