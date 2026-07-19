# Setup guide — `@roo-bz/roo-mcp`

An MCP server that lets any MCP-capable AI client (Claude Desktop, Claude Code, Cursor, Continue.dev, …) create and manage shortlinks and add-ons on [roo.bz](https://roo.bz).

**Time required:** 3–5 minutes. Two moments need you: pasting your API key, and restarting your Claude app after the config is written.

---

## Hand-off note for Claude / Claude Code

If a user hands you this file and asks you to set them up, follow the steps below in order. You can do everything except:

1. **Fetching the API key** — the user must sign into roo.bz and paste it (Step 2 is the pause point).
2. **Restarting the Claude host app** — the user must close and reopen it (Step 5 is the pause point).
3. **Approving permission prompts** as you go.

Detect the OS + which MCP client the user has installed by checking for the config paths in Step 3. Prefer editing existing MCP config files (merging in the `roo` entry) over overwriting them.

---

## What you need

- **Node.js 18 or newer.** Check with `node --version`. If missing, install from [nodejs.org](https://nodejs.org) or via a package manager (`winget install OpenJS.NodeJS.LTS`, `brew install node`, `nvm install --lts`).
- **An MCP-capable Claude client.** Any of: Claude Desktop, Claude Code, Cursor, Continue.dev, Zed, or any other client that speaks the Model Context Protocol.
- **A Roo account** at [roo.bz](https://roo.bz). The free "Hop" plan is fine for trying it out.

## Step 1 — Get your Roo API key

1. Sign in at [https://roo.bz](https://roo.bz).
2. Open your account settings and look for the **API keys** section.
3. Create a new key (name it something like `mcp-desktop`) and copy the value. It looks like `roo_live_xxxxxxxx…`.
4. Keep the tab open — you'll paste this into Step 3.

If you lose the key later, generate a new one and update the config. Roo shows the key value only at creation time.

## Step 2 — Pick your MCP client and locate its config

The `roo-mcp` server plugs into any MCP client the same way — the only difference is *where* the config file lives.

### Claude Desktop

| OS | Path |
|---|---|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

If the file doesn't exist yet, create it with `{ "mcpServers": {} }` as the starting content.

### Claude Code (CLI)

- **User-level (all projects):** `~/.claude.json` — edit the `mcpServers` block.
- **Project-level:** `.mcp.json` in the project root — takes precedence for that repo. Use this if you only want `roo-mcp` inside a specific project.

### Cursor

- **User-level:** `~/.cursor/mcp.json`
- **Project-level:** `.cursor/mcp.json`

### Other MCP clients

Consult your client's docs for the MCP config file path. The snippet below is the same everywhere.

## Step 3 — Add the `roo` entry to the config

Open the config file. If it already has a `"mcpServers"` object, add the `"roo"` key inside it (don't replace the object). If it's empty or missing, use the full snippet:

```json
{
  "mcpServers": {
    "roo": {
      "command": "npx",
      "args": ["-y", "@roo-bz/roo-mcp"],
      "env": {
        "ROO_API_KEY": "roo_live_paste_your_key_here"
      }
    }
  }
}
```

Save the file.

**Security note:** the config file now contains your API key in plaintext. It lives in your user profile, so filesystem permissions already limit access — but be aware if you sync your dotfiles to a public repo or share your screen.

## Step 4 — Verify the server starts before restarting your app

Optional but recommended — catches mistakes before the "restart and see nothing" situation. In a terminal:

```bash
ROO_API_KEY=roo_live_paste_your_key_here npx -y @roo-bz/roo-mcp
```

You should see the process start and sit quietly (MCP servers wait on stdin for JSON-RPC messages). If it prints `roo-mcp: ROO_API_KEY is not set…` or exits with another error, fix that before continuing. Press `Ctrl+C` to stop.

## Step 5 — Restart your Claude app

The Claude app reads its MCP config only at startup, so it needs to see the new entry:

- **Claude Desktop:** fully quit (system tray → Quit, or `Cmd+Q` on macOS) and reopen.
- **Claude Code:** exit the process (`Ctrl+C` or `exit`) and start a fresh `claude` session.
- **Cursor / others:** restart the app.

## Step 6 — Verify it worked

In a new Claude conversation, ask:

> Use the roo MCP server to run roo_whoami.

Expected: a short summary of the account (email, plan, next billing date, add-on/permanent-link limits). If you see that, you're done.

## Troubleshooting

- **"MCP server 'roo' failed to start"** — most often a typo in the config JSON. Run the file through a JSON validator. Also check that `npx` is on your PATH (`which npx` / `where npx`).
- **"ROO_API_KEY is not set"** — the `env` block in your config was ignored. Two paths: (a) some MCP clients strip user env vars; drop a `.env` file with `ROO_API_KEY=…` next to where `@roo-bz/roo-mcp` was installed, or (b) set `ROO_API_KEY` as a system env var and remove the `env` block from the config.
- **Roo API returns 401** — the key is wrong or was regenerated. Grab a fresh one from roo.bz.
- **Tools appear but every call fails** — check the account is active (`roo_whoami` will surface a suspended/expired plan).
- **`npx` downloads `@roo-bz/roo-mcp` every time and it's slow** — this is npx's default behavior. Install globally instead: `npm install -g @roo-bz/roo-mcp`, then change `"command": "npx"` and `"args": ["-y", "@roo-bz/roo-mcp"]` to `"command": "roo-mcp"` and `"args": []`.

## Alternative: install from source

Useful if you want to hack on the server or npm is unavailable.

```bash
git clone https://github.com/roo-bz/roo-mcp.git
cd roo-mcp
npm install
npm run build
```

Then in your MCP config, point `command` at Node directly:

```json
{
  "mcpServers": {
    "roo": {
      "command": "node",
      "args": ["/absolute/path/to/roo-mcp/dist/index.js"],
      "env": { "ROO_API_KEY": "roo_live_…" }
    }
  }
}
```

Everything else (Step 5 restart, Step 6 verify) is the same.

## Uninstalling

Remove the `"roo"` entry from your `mcpServers` config and restart your Claude app. If you installed globally: `npm uninstall -g @roo-bz/roo-mcp`.

## Next steps

Once `roo_whoami` works, try:

- `Create a shortlink to https://example.com`
- `Make it permanent and add a click-count redirect to https://another.com after 10 clicks`
- `Give me a QR code for that shortlink`

See the [README](./README.md) for the full tool list and the [DESIGN.md](./DESIGN.md) for how the server is structured.
