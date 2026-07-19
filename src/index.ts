#!/usr/bin/env node
// Stdio entrypoint. Reads ROO_API_KEY, builds the server, binds a stdio transport.
// Everything transport-agnostic lives in server.ts.
//
// Key resolution order (first hit wins):
//   1. process.env.ROO_API_KEY — how MCP clients normally inject the key.
//   2. .env file next to the package root — convenience for local development
//      when the parent Windows/desktop app doesn't pass user env vars through.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';

function loadApiKey(): string | null {
  const fromEnv = process.env.ROO_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(scriptDir, '..', '.env'), // dist/../.env — dev checkout
    join(scriptDir, '.env'),        // side-by-side .env — packaged install
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith('#')) continue;
        const eq = s.indexOf('=');
        if (eq < 0) continue;
        const k = s.slice(0, eq).trim();
        let v = s.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (k === 'ROO_API_KEY' && v) return v;
      }
    } catch {
      // Fall through to next candidate.
    }
  }
  return null;
}

const apiKey = loadApiKey();
if (!apiKey) {
  process.stderr.write(
    'roo-mcp: ROO_API_KEY is not set. Checked process.env and .env in the package root. ' +
      'Set it via your MCP client config, or drop a .env file next to the package.\n',
  );
  process.exit(1);
}

const server = buildServer({ apiKey });
const transport = new StdioServerTransport();
await server.connect(transport);
