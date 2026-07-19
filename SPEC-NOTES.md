# Roo API — spec findings (from live inline OpenAPI)

Source: `roo-openapi.json` in this directory. The spec is not served as a JSON URL — it's embedded inline in `https://www.roo.bz/assets/index-*.js` (split across ~25 minified vars ending in `D`). Re-extract with `scratchpad/extract_spec.js` if the bundle changes.

- **Swagger version:** 2.0 (not OpenAPI 3.x).
- **Info:** title `Roo API`, version `1.2`.
- **Host:** `api.roo.bz`, schemes: `https`. Base path (implicit): `/v1`.

## Auth

- Scheme name: `api_key`
- Location: **header `x-api-key`**
- **Not** `Authorization: Bearer`. The design's guess is resolved.

## Endpoint surface

| Method | Path | Body / query | Response schema |
|--------|------|--------------|-----------------|
| GET  | `/v1/me` | — | (undocumented body, "basic account details") |
| GET  | `/v1/urls` | query `limit` (int), `lastKey` (string cursor) | `ShortlinkRecordList` |
| POST | `/v1/urls` | body `Shortlink` | `ShortlinkCreated { id, shortUrl, message }` |
| GET  | `/v1/urls/{id}` | — | `ShortlinkRecord` |
| PATCH | `/v1/urls/{id}` | body `Shortlink` | `ShortlinkUpdated { id, message }` |
| PATCH | `/v1/urls/{id}/add-on` | body `AddOn` | (no schema) |
| PUT  | `/v1/urls/{id}/permanent-shortlink` | — | (no schema) |
| PATCH | `/v1/urls/{id}/permanent-shortlink` | — (**no body documented**) | (no schema) |
| GET  | `/v1/urls/{id}/qr-code` | — | (**no schema — probably image bytes; verify live**) |

## Shortlink core shape

```
Shortlink = { url (required, dest URL), addOns?, customDomain? }
CustomDomain = { domain, slug, alternativeSlug (bool: random-slug-fallback) }
```

- **Destination field is `url`.** Design guessed target/longUrl — resolved.
- `slug` lives inside `customDomain`, not at the top level.
- There is **no** top-level `title`, `tags`, or `domain` field on Shortlink.

Read shape (from `GET /v1/urls/{id}`) — `ShortlinkRecord`:
- `CreatedDate`, `UpdatedDate` (epoch numbers)
- `Attributes.UserId`, `Attributes.TargetUrl`
- `Counter` (click count)
- `addOns[]`, `customDomain`

## Pagination

Cursor-style: request with `limit` + `lastKey`; response returns `nextKey` (feed it back as `lastKey`). No search parameter.

## Add-ons (discriminated by `addOn` field)

Envelope:
```
{ addOn: "<type>", enabled: bool, data: {...type-specific...} }
```

### 1. `scheduledRedirect` → `ScheduledRedirectData`

```
data.schedule[]: { timestamp: int64 (Unix epoch SECONDS), url }
```

- **Waypoints, not windows.** At timestamp T the redirect switches to `url`. No end time, no per-window default, no timezone. Times outside all waypoints fall through to the Shortlink's top-level `url`.
- Datetime format is **Unix epoch seconds** — resolves ISO-8601-vs-epoch.

### 2. `clickCountRedirect` → `ClickCountRedirectData`

```
data.schedule[]: { clickCount: int >=1, url }
```

- Cumulative threshold: "after this many clicks, switch to `url`".

### 3. `webhook` → `WebhookData` (**all 8 fields required**)

```
{ name, method, body (string), contentType, endpoint, addMetadata (bool), headers (obj), queryString (obj) }
```

- `method` enum: `GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS`
- `contentType` enum: `application/json | application/x-www-form-urlencoded | multipart/form-data | application/xml | text/plain | application/octet-stream`
- `endpoint` is the destination URL for the webhook call
- `addMetadata: true` includes click data in the payload (= design's `include_click_data`)
- `body` is a raw string (JSON as a string, not an object)

### 4. `previewLink` → `PreviewLinkData`

```
{ title (required), description (required), image?, image_url? }
```

- `image` = base64 data URI when uploading; on later edits, send back `image_url` returned by the server to keep the existing image.
- **Minimum image size: ~100 KB.** Roo rejects smaller images with `{ "message": "Link preview image must be at least 100KB." }`. Discovered when a 1×1 PNG test fixture (68 bytes) was rejected. Applies to both `image` uploads and (presumably) `image_url` fetches. Undocumented in the OpenAPI spec — product intent is to prevent users from setting tiny/blank preview images that unfurl poorly on social.

### 5. `qrCode` → `QrCodeData` (**all 6 fields required**)

```
{ codeColor (hex #RRGGBB), backgroundColor (hex), qtType (mode_1..mode_9), scale (1..10 int), logo (base64 or ""), displayRooLogo (bool) }
```

## Deltas from the DESIGN.md tool interfaces

Design → spec adjustments needed:

- **`roo_create_shortlink`**: drop `title`, `tags`, `domain` from the tool input (not in spec). Rename `destination_url` → `url`. Move `slug` under a `custom_domain: { domain, slug, alternative_slug? }` sub-object. Also expose `addOns` up-front so a caller can create-with-add-ons in one request (spec supports this on POST).
- **`roo_update_shortlink`**: same body schema; PATCH semantics.
- **`roo_list_shortlinks`**: input is `limit?`, `cursor?` (maps to `lastKey`). Drop `search`.
- **`roo_set_scheduled_redirect`**: input is `id, waypoints: [{ url, at_epoch_seconds }]`. Drop `default_url` and `timezone`. Convenience: accept ISO 8601 in the tool and convert internally.
- **`roo_set_smart_redirect`**: input is `id, thresholds: [{ url, click_count }]`. Confirm ordering semantics with a real key (spec description says "after this many clicks, switch"), but the ordering intent is the same as the design.
- **`roo_set_webhook`**: input needs `id, endpoint, name?, method?, content_type?, body?, headers?, query_string?, add_metadata?`. The tool must fill defaults for every required field (e.g. `method: POST`, `content_type: application/json`, `body: "{}"`, `headers: {}`, `queryString: {}`, `addMetadata: true`, `name: <id-derived>`). Otherwise the caller has to remember 8 fields.
- **`roo_set_preview_link`**: input `id, title, description, image?` (base64 or hosted URL — infer which field to send).
- **`roo_set_qr_addon`**: 6 required fields — provide sensible defaults (`codeColor: "#000000"`, `backgroundColor: "#FFFFFF"`, `qtType: "mode_1"`, `scale: 4`, `logo: ""`, `displayRooLogo: false`) rather than "keep light."
- **`roo_get_qr_code`**: probed. Returns JSON `{success, data:{mimeType, base64: "data:image/png;base64,..."}}`. Also, requires the `qrCode` add-on to be set first — otherwise 404 `"QR settings not enabled."`. Consider a helper that decodes and writes to a file path so callers aren't stuck with a giant base64 blob in-transcript.
- **`roo_make_permanent`**: probed. Implement as `PATCH /v1/urls/{id}/permanent-shortlink` with body `{ permanent: true }`. **Do not use PUT** — it is broken on the server side (returns 400 with a leaked TypeError).
- **`roo_update_permanent_settings`**: probed. Same endpoint as make_permanent — `PATCH ... { permanent, ...other-fields }`. The extra-fields set is not yet mapped (probe candidate `title` was accepted but not persisted). Start with just `permanent` and grow the schema as we discover fields.

## Live-probe findings (things the spec does not say)

Fixtures: `scratchpad/fixtures/*` (raw bodies + headers, per call).

### `/v1/me` is much richer than the spec suggests

- Response size ~52 KB.
- Top-level keys: `email`, `subscription`, `featuresStatus`, `subscriptionHistory`, `createdDate`.
- **Plan feature limits** live at `subscription.subscriptionInfo.plan.features`.
- **Plan name**: `subscription.subscriptionInfo.plan.name` (e.g. `"Hop"`).
- `featuresStatus` (top-level) is a simplified boolean map of enabled features — no limits/counters.
- `roo_whoami` MUST project this down or every call floods the caller's context.

**Per-account limits, not per-plan.** Every account's actual caps live in `subscription.subscriptionInfo.plan.features` and vary by signup era: new-signup Hop is 100 base + 100 add-on-bonus shortlinks/mo; legacy Hop accounts are grandfathered higher (e.g. the test account we probed shows 200 + 300). The API is the source of truth per account — do not hardcode plan-tier limits anywhere; project from `/v1/me` in `roo_whoami` and read that value at call time.

**Add-on limits: per-type in the schema, but enforced as a shared ceiling.** Each of `scheduledRedirects`, `clickCountRedirects`, `webhooks`, `previewLinks`, `qrCodes` has its own `{ limit, type: "fixed", enabled: true }` under features (Hop = 50 each). But the enforced behavior is a shared cap: the moment any single type reaches its 50, all further add-on operations across every type are blocked. Surface in `roo_whoami` as "N per type — first to reach cap blocks all types."

### Create response has extra fields the spec omits

Reality vs. `ShortlinkCreated` in spec:
```json
{ "id", "shortUrl", "shortUrlNoProtocol", "slug" }
```
- No `message` field (spec had one).
- Plus `shortUrlNoProtocol` and `slug`.

### `GET /v1/urls/{id}` shape is much richer than `ShortlinkRecord` in the spec

Actual response shape:
```
{
  PK,                                    // DynamoDB internal — leaky
  CreatedDate, UpdatedDate,              // epoch seconds
  Attributes: { TargetUrl, Permanent, UserId },  // spec's ShortlinkRecordAttribs is missing Permanent
  Counter,                               // click count
  FolderId, FolderPaths[], Description,  // undocumented
  CustomDomain: { slug, domain },        // NOTE: PascalCase in read, camelCase (customDomain) on write
  addOns: [ { addOn, enabled, data } ],  // camelCase (matches AddOn spec)
  shortUrl, shortUrlNoProtocol, slug     // convenience mirrors
}
```

**Case-sensitive gotcha**: write path uses `customDomain` (lowercase c). Read path returns `CustomDomain` (uppercase). MCP tools should normalize this in the client.

### Do NOT URL-encode `=` when a shortlink id is used in a path

Roo mints shortlink ids as `base64(host + "/" + slug)`. When `len(host) + 1 + len(slug)` is not divisible by 3 (i.e. most of the time), the base64 includes trailing `=` padding — e.g. the id `bC5kYXZpZHppc25lci5wcm8vc3dpdGNoZXJvbw==` for `l.davidzisner.pro/switcheroo`.

- Sending the id with **raw `=`** in the URL path works on every endpoint (GET/PATCH/PATCH-addon/PATCH-permanent-shortlink/GET-qr-code) — verified 2026-07-05.
- Sending the id with the same characters URL-encoded to **`%3D`** — which is what `encodeURIComponent` does — **fails** on every endpoint with 404 or a raw JS TypeError. Roo's URL routing does literal string matching that treats `%3D` as a distinct character from `=`.

Client-side fix: encode only the base64 characters that are genuinely unsafe in a URL path segment (`+` and `/`), and leave `=` raw. See `encodeRooId` in `src/roo-client.ts`. Every tool that puts an id in a path uses this helper.

Discovered by a bug report against `PATCH /v1/urls/{id}/permanent-shortlink` that turned out to affect *every* endpoint on padded ids and was fully worked around by not over-encoding client-side.

### Domain semantics — `roo.bz` vs `roo.ws` vs a real custom domain

- **`roo.bz`** — Roo's marketing/company site (`https://www.roo.bz/...`). Not a shortlink host by default.
- **`roo.ws`** — Roo's default shortlink hosting domain. Every account can use it without a custom-domain entitlement.
- **A custom domain** — an owned domain the account holder verifies with Roo (e.g. `l.davidzisner.pro`). Counts against the plan's `customDomains.limit` (Hop = 1).

**On the wire**: every shortlink comes back with `CustomDomain.domain` populated — including default-domain links, which have `CustomDomain.domain = "roo.ws"`. That field name is misleading: presence of a `CustomDomain` object does NOT imply a custom domain. In the MCP client we expose:

- `domain: string` — the actual hosting domain (either a Roo default or a real custom one).
- `is_custom_domain: boolean` — computed from `!DEFAULT_ROO_DOMAINS.has(domain)`, where `DEFAULT_ROO_DOMAINS = { "roo.ws", "roo.bz" }`. Both were confirmed as Roo-owned defaults by probing `GET /v1/account/custom-domains` on an account with a real custom domain — neither appears there.

**Dedicated endpoint exists (undocumented in the OpenAPI):** `GET /v1/account/custom-domains` returns the authoritative list of attached custom domains.

- Response shape: `{ domains: [ { PK: "DOMAIN#<id>", CreatedDate, UpdatedDate, Attributes: { domain, subdomain, acm: { cname: [...] }, cloudfront: { cname } }, Status } ] }`.
- Optional query: `?filter=<Status>` (observed: `Issued`; other statuses like `Pending` are plausible but unverified).
- `Status: "Issued"` means the domain is verified and active.
- The `Attributes.acm.cname` list gives the DNS CNAME record(s) the customer had to publish for AWS ACM cert validation. `Attributes.cloudfront.cname` gives the CloudFront distribution host the customer's DNS should CNAME to for traffic.
- Discovered via HAR capture of the Roo dashboard; used by the MCP client's `roo_list_custom_domains` tool.

### Other undocumented endpoints spotted in HAR capture

Not currently used by any MCP tool, but worth capturing for later:

- `GET /v1/account/dashboard` — dashboard stats/aggregates.
- `GET /v1/account/preferences` — user preferences.
- `GET /v1/folders` — folder list (matches `FolderId` / `FolderPaths` seen in shortlink read shape).
- `GET /v1/payments/current-plan` — subscription details.
- `GET /v1/payments/plan-summary` — plan summary/comparison.
- `GET /v1/urls/search-shortlinks` — **search DOES exist**, contrary to the earlier assumption that `/v1/urls` had no search param. Signature unverified; would allow adding a `search` parameter to `roo_list_shortlinks` or a dedicated `roo_search_shortlinks` tool.

Confirm response shapes and expected params via HAR / probes before wiring any of these into tools.

### QR endpoint returns JSON, not binary

```
GET /v1/urls/{id}/qr-code
→ HTTP 200 application/json
  { success: true, data: { mimeType: "image/png", base64: "data:image/png;base64,..." } }
```
- Requires the `qrCode` add-on to be set on the shortlink first, otherwise:
  ```
  → HTTP 404 { success: false, message: "QR settings not enabled." }
  ```
- The `roo_get_qr_code` tool should surface the data URI. Optionally provide a helper to decode to a file path so the caller isn't forced to handle base64 themselves.

### Permanent-shortlink: PATCH does everything, PUT is broken

- **`PATCH /v1/urls/{id}/permanent-shortlink` with `{ "permanent": true }`** flips `Attributes.Permanent` to `true`.
- The same PATCH can accept other permanent-settings fields (not yet mapped — candidate `title` did not stick).
- **`PUT /v1/urls/{id}/permanent-shortlink` (no body) → HTTP 400** with a leaked server-side TypeError: `"Cannot read properties of null (reading 'permanent')"`. **Do not call PUT** from the MCP server.
- Recommend `roo_make_permanent` → `PATCH ... { permanent: true }`.
- Recommend `roo_update_permanent_settings` → same endpoint, extra fields alongside `permanent`.
- Empty-body PATCH silently succeeds without changing state (HTTP 200 `{id, message:""}` but `Permanent` stays as it was). Error mode: **silent no-op**.

### Multiple add-on types coexist on one link

Setting webhook then qrCode leaves both entries in `addOns[]`. The design's open question is resolved: yes, up to one per type, arbitrary combinations.

### Quota accounting has no explicit counter

- No `webhooksUsed: N` or similar in `/v1/me` after setting a webhook.
- Only signal observed: `featuresStatus.isMonthlyExtraShortlink: true` and `featuresStatus.extraShortlinkBy: "webhook"` flipped from `false`/`undefined`.
- Implication: we cannot preemptively check quota before a `roo_set_*` call. Quota errors will only surface on the failing request — handle them defensively as an error class after we ever see one.

### `Attributes.Permanent: true` prevents auto-expiry

Permanent links do not participate in the 90-day expiry. The probe left the test link permanent — it will not auto-clean unless we PATCH it back with `{ permanent: false }`.

## Errors

- No error responses documented in the spec.
- Observed shapes:
  - `{ success: false, message: "..." }` — used by QR-not-enabled 404.
  - `{ id, message: "<server-error-text>" }` — used by the broken permanent-shortlink PUT 400.
- All error handling in `errors.ts` will need to be built defensively — probe with intentionally-bad calls and codify status codes we actually see. Never leak raw server text unmodified (the PUT TypeError leak is an example of Roo's own leakage — don't propagate it to the model verbatim).

## Still-open (can be deferred)

1. `PATCH /v1/urls/{id}/permanent-shortlink` — full set of permanent-settings fields beyond `permanent` (candidate `title` didn't stick).
2. Whether `clickCountRedirect` thresholds are cumulative or per-rule (spec description reads cumulative — plausible but unverified end-to-end).
3. What triggers a real quota-exceeded response, and what shape it has.
4. Whether `FolderId` / `FolderPaths` / `Description` can be set on create or update (they appear in the read shape but not the write schema).
