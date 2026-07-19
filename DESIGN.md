# Roo MCP Server + Skill — Build Brief

**Purpose of this document.** This is a build spec to hand to Claude Code. It defines two separate deliverables — an MCP server (capability) and a Claude skill (expertise) — with enough precision that Claude Code builds against a spec instead of improvising. Read the whole thing before writing code.

**Source of truth.** The OpenAPI spec is embedded inline in the roo.bz web app bundle (not served as a public JSON URL). It has been extracted to `roo-openapi.json` in this repo. Every non-obvious deviation from that spec — auth header, case-sensitivity, undocumented fields, one broken endpoint — is captured in [SPEC-NOTES.md](SPEC-NOTES.md), which was produced by live probing against the API. Read both before writing any tool. If the spec ever changes, re-run `scratchpad/extract_spec.js` and re-probe.

The tool interfaces below (what the model sees) are deliberate design and should stay stable regardless of Roo's internal field names.

---

## 0. Endpoint surface

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/me` | Current account / key check (returns ~52 KB — project down) |
| GET | `/v1/urls` | List shortlinks (cursor-paginated) |
| POST | `/v1/urls` | Create shortlink (may include add-ons up front) |
| GET | `/v1/urls/{id}` | Get one shortlink |
| PATCH | `/v1/urls/{id}` | Update shortlink |
| PATCH | `/v1/urls/{id}/add-on` | Set/replace an add-on (polymorphic) |
| PATCH | `/v1/urls/{id}/permanent-shortlink` | Make permanent and/or update permanent settings |
| GET | `/v1/urls/{id}/qr-code` | Fetch QR (returns JSON with a base64 data URI, not raw binary) |

`PUT /v1/urls/{id}/permanent-shortlink` exists in the spec but is **broken on the server side** (leaks a JS TypeError). Do not call it. PATCH handles both making a link permanent and updating its settings.

Add-on types (discriminator `addOn` in the body): `scheduledRedirect`, `clickCountRedirect`, `webhook`, `previewLink`, `qrCode`.

---

## Guiding principle: thin tools, thick skill

- **MCP server = capability.** A faithful, thin wrapper over the REST API. Tool descriptions state what the endpoint does in one or two lines. No campaign strategy, no "when to use which add-on" — that bloats every context the tools load into.
- **Skill = expertise.** The judgment layer: when to reach for each add-on, payload gotchas, agency conventions, recipes. Loaded on demand via progressive disclosure.
- **They compose:** the skill instructs Claude to call the `roo_*` tools; the tools do the work. Each is independently useful (tools without skill = basic calls; skill without tools = guidance for hand-authored Make scenarios or client docs).

---

## PART A — MCP Server

### A1. Architecture
- **Language:** TypeScript, `@modelcontextprotocol/sdk` (verify current SDK API against the installed version before coding — the high-level `McpServer` + `registerTool` surface has shifted across releases).
- **Runtime:** Node 18+.
- **Schema validation:** zod.
- **Transport (v1):** stdio only. The MCP client launches the server as a subprocess over stdin/stdout — no network listener.
- **Transport-agnostic core:** keep all Roo logic (API client, tool definitions, error normalization) independent of the transport. `index.ts` should do nothing but instantiate the server, register tools, and bind a `StdioServerTransport`. Adding a Streamable-HTTP transport later must be a new entrypoint that reuses the same core — not a rewrite. Do not build HTTP now; just don't couple to stdio.

### A2. Repo layout
```
roo-mcp/
├── package.json            # bin entry so `npx <pkg>` runs it; TODO: pick npm name
├── tsconfig.json
├── src/
│   ├── index.ts            # stdio entrypoint: build server, connect transport
│   ├── server.ts           # transport-agnostic: creates McpServer, registers tools
│   ├── roo-client.ts       # thin fetch wrapper around the Roo REST API + auth
│   ├── errors.ts           # maps Roo/HTTP errors -> structured tool errors
│   ├── tools/
│   │   ├── account.ts      # roo_whoami
│   │   ├── shortlinks.ts   # list / create / get / update / permanent / qr
│   │   └── addons.ts       # the 5 add-on tools
│   └── types.ts            # shared types; mirror confirmed Roo schemas here
└── README.md               # install + config snippet for clients
```

### A3. Authentication
- Read `ROO_API_KEY` from the environment at startup. If missing, fail fast with a clear message.
- Auth header (confirmed via spec + live probes): **`x-api-key: <key>`**. Not `Authorization: Bearer`.
- `roo_whoami` (GET `/v1/me`) doubles as the key smoke test. On a 401, surface "Roo API key is missing or invalid" rather than raw JSON.
- **Note:** `/v1/me` returns ~52 KB (embeds the entire Stripe subscription verbatim). `roo_whoami` MUST project this down to a useful summary — see A4 below.
- Design for BYO-key later without building it now: have `roo-client.ts` take the key as a constructor argument, and have the stdio entrypoint pass `process.env.ROO_API_KEY`. When the HTTP transport arrives, it will instead pass a key extracted per-request from an inbound header — same client, different source.

Local install snippet (for the README):

```json
{
  "mcpServers": {
    "roo": {
      "command": "npx",
      "args": ["-y", "<npm-package-name>"],
      "env": { "ROO_API_KEY": "<your-key>" }
    }
  }
}
```

### A4. Tool catalog

13 tools. The `/add-on` endpoint is polymorphic (one route, five payload shapes) — do not expose it as one union-input tool. Split into five flat tools; LLMs fill flat schemas far more reliably than discriminated unions, and Roo's surface is small enough that the extra tools cost little context.

For every tool: return the resulting object as readable text (and include the short URL prominently on any create/update). Keep descriptions to 1–2 lines. The tools accept snake_case input from the model but translate to Roo's camelCase wire format inside the client.

#### Account

- **`roo_whoami`** — no input. Returns a **projected** summary: `email`, `createdDate`, `subscription.status`, `subscription.startDate`, `subscription.endDate`, `subscription.subscriptionInfo.plan.name` (e.g. `"Hop"`), and a compact `limits` object derived from `subscription.subscriptionInfo.plan.features` — one entry per resource (shortlinks monthly cap, permanent limit, each add-on type's limit, custom domain limit). Never return the raw body — it's ~52 KB.

#### Shortlinks

- **`roo_list_shortlinks`** — input: `limit?` (int), `cursor?` (string; maps to Roo's `lastKey`). Returns a compact list (per item: `id`, `slug`, `short_url`, `destination_url`, `created_at`, `click_count`, `permanent`) plus `next_cursor` when more pages exist. No search param — Roo doesn't expose one.

- **`roo_create_shortlink`** — input: `url` (required — the destination), plus optional `custom_domain: { domain, slug, alternative_slug? }` and optional nested `add_ons` object with 5 named sub-keys (`scheduled_redirect`, `click_count_redirect`, `webhook`, `preview_link`, `qr`) — each reusing the exact same Zod field shape as the corresponding `roo_set_*` tool. When `add_ons` is provided, the shortlink is created and every listed add-on is attached in a **single** POST — atomic, no half-configured link on failure. When `add_ons.qr` is included, Roo pre-renders the QR image in the response and the tool surfaces it inline as an MCP `image` content block — no follow-up `roo_get_qr_code` needed. Wire-format correctness verified against a HAR of a successful web-app request (see `scripts/verify-har-fixture.mjs`). Returns `{ id, short_url, short_url_no_protocol, slug, add_ons_attached, qr_code_inline? }`. **Removed from the earlier draft:** no top-level `title`, `tags`, or `domain` — none exist on Roo's Shortlink schema.

- **`roo_get_shortlink`** — input: `id`. Returns full detail: `id`, `slug`, `short_url`, `short_url_no_protocol`, `destination_url`, `created_at`, `updated_at`, `click_count`, `permanent`, `folder_id`, `folder_paths`, `description`, `custom_domain`, `add_ons[]`. **Normalize `CustomDomain` (PascalCase in read) to `custom_domain`** — Roo returns different casing on read vs. write. The MCP client hides this.

- **`roo_update_shortlink`** — input: `id` plus any mutable subset of the create fields. PATCH semantics — only send provided fields.

#### Permanent shortlink

- **`roo_make_permanent`** — input: `id`. Implementation: `PATCH /v1/urls/{id}/permanent-shortlink` with body `{ permanent: true }`. **Do not use PUT** — it's broken on Roo's side (leaks a TypeError). Returns `{ id, permanent: true }` for confirmation.

- **`roo_update_permanent_settings`** — input: `id` plus permanent-settings fields. Same endpoint. The full settings schema is not documented and initial probes were inconclusive; start with just `permanent` and grow the schema as we learn what sticks. Warn the caller if they pass a field that doesn't round-trip on the subsequent GET.

#### QR

- **`roo_get_qr_code`** — input: `id`, plus optional `save_to?` (a filesystem path). Roo returns JSON `{ success, data: { mimeType, base64: "data:image/png;base64,..." } }` — NOT raw binary. The tool returns the data URI. If `save_to` is provided, decode and write to that path and return the path instead of the base64. **Requires the `qrCode` add-on to be set on the shortlink first** — otherwise Roo returns 404 `"QR settings not enabled."` The tool must recognize this specific error and instruct the caller to `roo_set_qr_addon` first.

#### Add-ons (five flat tools → all map to `PATCH /v1/urls/{id}/add-on`)

Each tool builds the correct discriminated payload internally (setting `addOn` + `enabled: true` + `data`) so the model never has to. The input shapes below are tuned for model ergonomics; the client maps them to Roo's on-wire payload.

- **`roo_set_scheduled_redirect`** — time-based destination switching. Input: `id`, `waypoints: [{ url, at }]` where `at` is either an ISO 8601 datetime (the tool converts to Unix epoch seconds) or a raw epoch-seconds integer. Roo models this as **waypoints, not windows**: at time T, redirect switches to `url` and stays there until the next waypoint. Times before the first waypoint (or if no waypoints match) fall through to the shortlink's base `url`. There is no per-waypoint `end_at`, no `default_url` on the add-on itself, no timezone field.

- **`roo_set_click_count_redirect`** — destination changes based on click count. Input: `id`, `thresholds: [{ url, click_count }]`. Ordered; description reads cumulative ("after this many clicks, switch to `url`"). Confirm cumulative-vs-per-rule behavior end-to-end when we have a case to test.

- **`roo_set_webhook`** — fire an HTTP request on each click. Roo's spec requires 8 fields; the tool fills sensible defaults for all but `endpoint`. Input: `id`, `endpoint` (required), `name?` (default: derived from shortlink id), `method?` (default `POST`, enum: GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS), `content_type?` (default `application/json`, enum documented in `roo-openapi.json`), `body?` (default `"{}"` — string, not object), `headers?` (default `{}`), `query_string?` (default `{}`), `add_metadata?` (default `true` — includes click data in the payload; renamed from Roo's `addMetadata`).

- **`roo_set_preview_link`** — control the social/link unfurl metadata. Input: `id`, `title` (required), `description` (required), `image?`. The `image` field accepts either a base64 data URI (`data:image/png;base64,...`, for new uploads) OR a previously-returned hosted URL (to persist the existing image). The tool sniffs which and maps to Roo's `image` or `image_url` accordingly.

- **`roo_set_qr_addon`** — configure/enable the QR add-on. Distinct from `roo_get_qr_code`, which retrieves the image. Roo requires all 6 fields; the tool defaults them: `code_color` (default `#000000`, hex `#RRGGBB`), `background_color` (default `#FFFFFF`), `style` (default `mode_1`, enum `mode_1..mode_9` — Roo's `qtType`), `scale` (default `4`, int 1..10), `logo?` (base64 data URI or empty string, default `""`), `display_roo_logo` (default `false`). Callers can override any field.

### A5. Error handling (`errors.ts`)

Normalize every failure into a structured tool error with a human-readable message. Distinguish at minimum:

- **401** → key missing/invalid. Surface: "Roo API key is missing or invalid."
- **404** → shortlink id not found; special-case the QR-not-enabled 404 (`{ success: false, message: "QR settings not enabled." }`) and instruct the caller to set the `qrCode` add-on first.
- **400 / 422** → validation error; include Roo's field-level messages where useful, but strip stack-trace-like content. Roo occasionally leaks JS runtime errors verbatim (e.g. the broken PUT returns `"Cannot read properties of null (reading 'permanent')"`) — never propagate that unmodified to the model.
- **429** → rate limited; surface any retry hint from headers.
- **5xx / network** → transient; suggest retry.

Observed error shapes in the wild:
- `{ success: false, message: "..." }` (used by the QR-not-enabled 404)
- `{ id, message: "..." }` (used by the broken permanent-shortlink PUT 400 and by successful PATCHes — the shape overlaps 200s)

Never leak the API key into error text or logs.

### A6. Build order
1. **Sanity-check the extracted spec.** `roo-openapi.json` and `SPEC-NOTES.md` are already in the repo. Write confirmed request/response types into `types.ts` from these — don't re-derive from marketing copy.
2. **`roo-client.ts` + `errors.ts` + `roo_whoami`.** Prove auth + transport + error path + response-projection all work end-to-end.
3. **Shortlink CRUD** (list, create, get, update).
4. **Permanent + QR tools** (both via the `permanent-shortlink` PATCH and the QR JSON envelope).
5. **The five add-on tools.**
6. **README** with the install snippet. Fill in the npm package name.

**Milestone check after step 2**: the whole auth + transport + error + projection path is proven before any breadth is added.

---

## PART B — Claude Skill

A skill is a folder: a `SKILL.md` (required) plus optional bundled resources loaded on demand. It packages how to use Roo well — independent of the MCP server, though it points at the `roo_*` tools for execution.

### B1. File tree
```
roo-shortlinks/
├── SKILL.md                    # frontmatter + the judgment layer (<500 lines)
└── references/                 # loaded by Claude only when needed
    ├── api-field-reference.md  # full field reference generated from the spec + probe notes
    ├── addon-payloads.md       # one worked example per add-on type
    └── recipes.md              # end-to-end campaign playbooks
```

Progressive disclosure: the name + description are always in context; the SKILL.md body loads when the skill triggers; the `references/` files load only when Claude needs that depth. Keep SKILL.md lean and push detail into `references/`. Give any reference file over ~300 lines a table of contents.

### B2. SKILL.md frontmatter

The description is the trigger. Claude tends to under-trigger skills, so make it explicit and slightly pushy — state both what it does and the contexts that should invoke it. See the revised `SKILL.md` in this repo for the current draft.

### B3. SKILL.md body outline

Write in the imperative and explain why things matter rather than stacking bare rules. Cover:

1. **What Roo is** — smart shortlinks whose behavior is driven by add-ons; built for automation.
2. **Terminology** — use Roo's own product vocabulary: a redirect event is a **click**; the add-ons are **scheduled redirects** (time-based waypoints), **click count redirects** (cumulative thresholds, API type `clickCountRedirect`), **webhooks** (click notifications), **preview links** (unfurl control), and **QR codes**. Do not confuse add-on types with plan names (Hop/Skip/Leap/Spring/Enterprise) — those are billing tiers only.
3. **Add-on decision guide** — the core judgment:
   - **Scheduled redirect** → time-based campaign switching (launch windows, seasonal).
   - **Click count redirect** → cap or rotate destinations by click count.
   - **Webhook** → fire an event to Make/Pipedrive on click (lead capture, attribution).
   - **Preview link** → control the social unfurl (title/description/image).
   - **QR** → print/offline entry point.
4. **Payload gotchas** — Roo's scheduled redirect is waypoints not windows; every field of a webhook payload is technically required (the MCP tool defaults them, but hand-authored Make calls must fill them all); the QR endpoint won't return an image until the `qrCode` add-on is set. Point to `references/addon-payloads.md` for worked examples.
5. **Conventions** — slug/naming conventions, tagging, and when to make a link permanent (TODO: fill in the agency's actual conventions).
6. **Execution** — instruct Claude to use the `roo_*` MCP tools; name the relevant tool for each workflow. Note that the skill is also usable for hand-authored Make scenarios that hit the Roo REST API directly.
7. **Recipes** — brief pointers into `references/recipes.md` (campaign launch link, click-count A/B rotation, lead-capture link that pings Pipedrive via webhook, seasonal QR).

### B4. `references/` contents
- **`api-field-reference.md`** — derived from `roo-openapi.json` + `SPEC-NOTES.md`. Every endpoint, field, type, required/optional, plus the case-sensitivity gotchas and the undocumented fields discovered in probes.
- **`addon-payloads.md`** — one concrete, correct payload per add-on type, with the epoch-seconds and webhook-body specifics spelled out.
- **`recipes.md`** — end-to-end playbooks tying tools together.

### B5. Testing the skill (optional, recommended)

Once drafted, sanity-check with 2–3 realistic prompts (e.g. "set up a launch link that points to the waitlist until July 10, then flips to the product page"; "make a QR for the booth that pings our Make webhook on every scan"). Confirm the right add-on tool is chosen and the payload is well-formed. The `skill-creator` skill has the full eval harness if you want quantitative triggering tests later.

---

## Open TODOs for David

1. **npm package name** and, later, the remote host domain (design assumes neither is tied to any other project).
2. **Agency conventions for the skill:** slug/naming scheme, tagging, default add-on choices per campaign type. Currently placeholder in `SKILL.md`.
3. **Confirm still-open API behaviors as we hit them:**
   - Which fields (beyond `permanent`) the permanent-settings PATCH actually accepts.
   - Whether `clickCountRedirect` thresholds are cumulative or per-rule (spec description reads cumulative — plausible but unverified end-to-end).
   - What shape a real quota-exceeded response takes (Hop 50 per add-on type is the ceiling we'd hit).
   - Whether `folder_id` / `folder_paths` / `description` are settable on write (they appear in the read shape but not the documented write schema).

## Known Roo-side issues to flag upstream (not blocking us)

- `PUT /v1/urls/{id}/permanent-shortlink` leaks a JS TypeError — use PATCH instead.
- The embedded OpenAPI is stale in several places: `ShortlinkCreated` and `ShortlinkRecord` schemas omit real fields; response casing (`CustomDomain` vs write-side `customDomain`) is inconsistent.

## Explicitly out of scope for v1 (structured for, not built)
- HTTP/Streamable transport + BYO-key header (cheap bolt-on: new entrypoint reusing the core, key from an inbound header instead of env).
- OAuth 2.1 front-end for non-technical clients (a genuine separate project: an auth server + per-user Roo-key storage in front of Roo's key-based API).
