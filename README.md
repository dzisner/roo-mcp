# roo-mcp

[![npm version](https://img.shields.io/npm/v/@roo-bz/roo-mcp.svg)](https://www.npmjs.com/package/@roo-bz/roo-mcp) [![node](https://img.shields.io/node/v/@roo-bz/roo-mcp.svg)](https://www.npmjs.com/package/@roo-bz/roo-mcp) [![license](https://img.shields.io/npm/l/@roo-bz/roo-mcp.svg)](./LICENSE)

MCP server for [Roo](https://roo.bz) — the smart-shortlink API. Exposes Roo's link + add-on operations as thin, well-shaped MCP tools an LLM can use directly.

**New here?** See [SETUP.md](./SETUP.md) for a step-by-step install guide (Claude Desktop, Claude Code, Cursor).

## Install

### Option A — Claude Code plugin (one command; ships MCP + skill together)

```bash
claude plugin add https://github.com/roo-bz/roo-mcp.git
```

Then set your API key once as a user environment variable so the spawned server inherits it:

```powershell
# Windows PowerShell
[Environment]::SetEnvironmentVariable('ROO_API_KEY', 'your-roo-api-key', 'User')
```

```bash
# macOS / Linux — in ~/.zshrc or ~/.bashrc
export ROO_API_KEY=your-roo-api-key
```

Restart your terminal + Claude Code. You get both:
- The 14 `roo_*` tools (via the MCP server declared in `.mcp.json`).
- The `roo-shortlinks` skill (in `skills/roo-shortlinks/`) that teaches Claude when to reach for which add-on.

### Option B — Manual MCP config (Claude Desktop, Cursor, Continue.dev, other MCP clients)

Add to your MCP client config file:

```json
{
  "mcpServers": {
    "roo": {
      "command": "npx",
      "args": ["-y", "@roo-bz/roo-mcp"],
      "env": { "ROO_API_KEY": "your-roo-api-key" }
    }
  }
}
```

See [SETUP.md](./SETUP.md) for the exact config file path per client. Get an API key from https://roo.bz — see your account API settings.

## Local development

```bash
npm install
cp .env.example .env    # then paste ROO_API_KEY into .env
npm run build
node scripts/smoke.mjs  # spawns the built server, calls tools/list + roo_whoami
```

**Key resolution:** at startup the server looks for `ROO_API_KEY` in this order:
1. `process.env.ROO_API_KEY` — how MCP clients normally inject it via their `mcpServers.env` config.
2. `.env` in the package root (`../` from the built script) — convenience for local dev, especially when a desktop MCP client (Claude Desktop, etc.) doesn't reliably pass user env vars through to spawned processes.

If neither is present, the server exits with a clear error.

## Tools (implemented / planned)

- `roo_whoami` — verify key + compact account summary.
- `roo_list_shortlinks`, `roo_create_shortlink`, `roo_get_shortlink`, `roo_update_shortlink` — CRUD.
- `roo_make_permanent`, `roo_update_permanent_settings` — permanence.
- `roo_get_qr_code` — retrieve QR (base64 data URI or write to file).
- `roo_set_scheduled_redirect`, `roo_set_click_count_redirect`, `roo_set_webhook`, `roo_set_preview_link`, `roo_set_qr_addon` — the five add-ons.

## Design & spec

- `DESIGN.md` — build brief (tool catalog, architecture, error handling).
- `skills/roo-shortlinks/SKILL.md` — companion Claude skill (judgment layer), bundled with the plugin.
- `SPEC-NOTES.md` — spec-vs-reality findings from live probes.
- `roo-openapi.json` — the extracted Swagger 2.0 spec.
