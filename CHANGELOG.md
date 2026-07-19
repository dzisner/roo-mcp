# Changelog

All notable changes to `@roo-bz/roo-mcp` will be documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-07-19

Initial public release on npm.

### Added

- Thin TypeScript MCP server wrapping the Roo (roo.bz) REST API, stdio transport, `@modelcontextprotocol/sdk` based.
- **Account & discovery:** `roo_whoami`, `roo_list_shortlinks`, `roo_list_custom_domains`.
- **Shortlink CRUD:** `roo_create_shortlink`, `roo_get_shortlink`, `roo_update_shortlink`.
- **Permanence:** `roo_make_permanent`, `roo_update_permanent_settings`.
- **QR codes:** `roo_get_qr_code`.
- **Add-on setters (one per add-on type):** `roo_set_scheduled_redirect`, `roo_set_click_count_redirect`, `roo_set_webhook`, `roo_set_preview_link`, `roo_set_qr_addon`.
- Optional `add_ons` block on `roo_create_shortlink` — attach every add-on in a single API call, and receive a pre-rendered QR image inline when `add_ons.qr` is included.
- API key resolution: `process.env.ROO_API_KEY` first, then a `.env` file next to the built package as a fallback for MCP clients that don't reliably pass user env vars through.
- `SETUP.md` — step-by-step install/config guide for Claude Desktop, Claude Code, and Cursor.

### Known issues

- **Roo server-side:** `PATCH /v1/urls/{id}/permanent-shortlink` returns 404 when the shortlink id contains base64 padding (`==`). Affects roughly 2 in 3 slug lengths. Workaround: choose slug lengths such that `(len(host) + 1 + len(slug))` is divisible by 3. Not fixable client-side; reported upstream.

[0.1.0]: https://github.com/roo-bz/roo-mcp/releases/tag/v0.1.0
