---
name: roo-shortlinks
description: >-
  Create and manage Roo smart shortlinks and their add-ons (scheduled
  redirects, click count redirects, click webhooks, preview/unfurl control,
  and QR codes). Use this skill whenever the user wants to build, configure,
  or troubleshoot a Roo shortlink or campaign link — including time-based
  redirect switching, capping or rotating destinations by click count, firing
  a webhook to Make/Pipedrive on click, controlling how a link previews on
  social, or generating a QR code — even if they don't name the specific
  add-on. Also use it when composing add-on payloads for the Roo API by hand.
---

# Roo Smart Shortlinks

Roo (roo.bz) creates short links whose redirect behavior is driven by add-ons. A bare shortlink just forwards to one destination; the value is in the add-ons that make the destination time-aware, count-aware, event-emitting, preview-controlled, or scannable. This skill covers choosing the right add-on and building a correct payload.

Field-level detail is in `references/api-field-reference.md`. Worked payloads are in `references/addon-payloads.md`. Read them before constructing a payload you're unsure about.

## Terminology

- **Click** — a single redirect through a shortlink. This is the event term; use "click," not any plan name.
- **Add-on** — the behavior attached to a shortlink: a scheduled redirect, a click count redirect, a webhook (click notification), a preview link, or a QR. A shortlink carries at most one add-on of a given type; setting an add-on replaces the prior configuration of that type. Multiple add-on types can coexist on the same link.
- **Plan names are not actions.** Hop, Skip, Leap, Spring, and Enterprise are billing tiers only — they never appear in link behavior or the API. Never treat a plan name as a redirect or add-on term. ("Hop" is the free plan, not an event.)

## Execution: use the MCP tools

When the Roo MCP server is loaded, do the work through its tools rather than describing the API. The relevant tools:

- `roo_whoami` — verify the API key / account and inspect plan + limits.
- `roo_list_shortlinks`, `roo_create_shortlink`, `roo_get_shortlink`, `roo_update_shortlink` — CRUD. `roo_create_shortlink` also accepts an optional nested `add_ons` object to attach add-ons up front in the same call (atomic, single API round-trip, and when `qr` is included the pre-rendered QR image comes back inline).
- `roo_make_permanent`, `roo_update_permanent_settings` — permanence (both hit the same PATCH endpoint).
- `roo_get_qr_code` — retrieve the QR image (returns a base64 data URI or writes to a file if `save_to` is given).
- `roo_set_scheduled_redirect`, `roo_set_click_count_redirect`, `roo_set_webhook`, `roo_set_preview_link`, `roo_set_qr_addon` — the five add-ons.

If no MCP server is loaded, this skill still guides hand-authored calls to the Roo REST API (for example, inside a Make scenario). In that case build the request from `references/api-field-reference.md`.

## Choosing an add-on

Match the user's intent to exactly one add-on. When the intent spans two (e.g. "flip the destination on a date and notify us on every click"), set them as separate add-ons — multiple types can coexist on the same link.

**Batching on create.** When the user knows the full add-on configuration up front (e.g. "make a shortlink to X that fires a webhook and generates a QR"), pass `add_ons` to `roo_create_shortlink` instead of chaining a create + N `roo_set_*` calls. It's a single API call, atomic, and — for QR — you get the rendered image back inline in the response.

- **Scheduled redirect** — the destination should change by time. Launch windows, seasonal campaigns, "point at the waitlist until the 10th, then the product page." Tool: `roo_set_scheduled_redirect`.
- **Click count redirect** — the destination should change by click count. Limited-supply drops ("first 100 clicks get the early-bird page"), or A/B rotation by count. Tool: `roo_set_click_count_redirect`. (API add-on type: `clickCountRedirect`.)
- **Webhook** — an event should fire on each click. Lead capture, attribution, kicking off a Make/Pipedrive automation. Tool: `roo_set_webhook`.
- **Preview link** — control how the link unfurls on social/chat (title, description, image). Use when the raw destination previews poorly or should be branded. Tool: `roo_set_preview_link`.
- **QR** — the link needs a scannable entry point for print or offline. Tool: `roo_set_qr_addon` to configure, `roo_get_qr_code` to fetch the image.

## Building correct payloads

The details that go wrong most often. Worked examples for each type are in `references/addon-payloads.md`.

- **Scheduled redirect — waypoints, not windows.** Each entry is a switch point: at time T (Unix epoch seconds), start redirecting to `url`. There is no `end_at`, no per-add-on `default_url`, no timezone field. Before the first waypoint, and if no waypoint matches, the redirect falls through to the shortlink's base URL. State waypoints in chronological order. The MCP tool accepts ISO 8601 or epoch seconds; when authoring by hand, epoch seconds only.

- **Click count redirect — cumulative thresholds.** Each entry says "after this many clicks, switch to `url`". Order the array by increasing `click_count`.

- **Webhook — 8 required fields.** The MCP tool fills sensible defaults for all but the endpoint URL. Hand-authored callers must provide every field: `name`, `method`, `body` (a string, not an object), `contentType`, `endpoint`, `addMetadata` (bool — includes click data in the payload), `headers` (object), `queryString` (object). The click destination is unchanged; the webhook fires alongside. On Spring/Enterprise, Dynamic Querystring Metadata means querystring params appended to the shortlink (e.g. `?source=email`) are passed through to both the destination and the webhook — useful for attribution.

- **Preview link.** `title` and `description` are required. `image` accepts a base64 data URI when uploading a new image; on later edits, send back the `image_url` returned by the server to keep the existing image. Keep title/description within the receiving platform's preview limits.

- **QR.** The QR add-on configures/enables the code (6 required fields — colors, style, scale, logo, roo branding); the image itself comes from `roo_get_qr_code`. **The image endpoint returns 404 with `"QR settings not enabled."` until the add-on has been set.** Don't try to fetch the image before configuring the add-on. The response is JSON with a base64 data URI, not raw bytes. Shortcut: when using `roo_create_shortlink` with `add_ons.qr`, Roo pre-renders the QR and the tool returns it inline — no `roo_get_qr_code` follow-up needed.
- **Preview link.** Roo enforces a minimum image size of ~100 KB; smaller uploads are rejected with `"Link preview image must be at least 100KB."`. Provide a real preview-sized image, not a placeholder.

## Plans & limits (context, not actions)

Plan tier changes limits, not behavior — but the limits shape sensible defaults. Every account's live limits are in `roo_whoami`'s response under `limits`.

- **Add-on limits are per-type in the schema, but the first type to reach its cap blocks every other type too.** Each of `scheduledRedirects`, `clickCountRedirects`, `webhooks`, `previewLinks`, `qrCodes` has its own limit (Hop = 50 each), but the moment any single type hits its 50, all further add-on operations on that account are blocked — treat it as a shared ceiling in practice on Hop. Don't attach add-ons speculatively; if a `roo_set_*` call fails on quota, say so plainly and suggest an upgrade or removing an unused add-on.
- **Link expiry:** on the free Hop plan, links stop resolving after 90 days and are hard-deleted at 120; only 20 permanent links are allowed. Paid plans never expire. This is the primary reason to use `roo_make_permanent` — flag it for anything that must outlive 90 days on a free account.
- **Monthly shortlink cap on Hop:** new-signup accounts get 100 base per month, plus an additional 100 that month for shortlinks that use an add-on. Some legacy accounts are grandfathered higher (e.g. 200 + 300). The account's actual caps are in `roo_whoami` under `effectiveLimits.shortlinks.monthly` / `monthlyAddonsExtra` — trust those over any generalized number.
- **Custom domains:** 1 on Hop; up to 10 on Enterprise.
- **Dynamic Querystring Metadata** (see webhook note above): Spring/Enterprise only.

There is no explicit "used" counter in the API — quota state has to be tracked by the user, or discovered when a `roo_set_*` call rejects.

## Conventions

_(TODO — fill in the agency's actual conventions.)_

- Slugs / naming: _[scheme]_
- Tagging: Roo does not have a tags field on shortlinks; if the agency needs tagging, agree on a folder or slug convention.
- When to make a link permanent: _[rule — noting the free-plan 90-day expiry above]_
- Default add-on choices per campaign type: _[defaults]_

## Recipes

End-to-end playbooks are in `references/recipes.md`. Starting set:

- **Campaign launch link** — one shortlink, scheduled redirect waypoints from teaser → live page at launch time, with the base URL as the pre-launch fallback.
- **Click-count A/B rotation** — rotate destinations by click count to split traffic.
- **Lead-capture link** — webhook add-on firing into a Make scenario that upserts to Pipedrive on each click.
- **Seasonal QR** — printed QR whose destination is switched by a scheduled redirect without reprinting.
