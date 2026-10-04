// Node HTTP entrypoint for the hosted MCP endpoint.
// Stateless per-request: each incoming /mcp call builds its own McpServer with the
// caller's x-api-key, so there's no key storage on our side; Roo's API validates on
// the first proxied call. Designed to sit behind a TLS-terminating reverse proxy
// (nginx/caddy) — binds to loopback (127.0.0.1) by default so the Node process is
// never directly reachable from the public internet.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { buildServer } from '../server.js';

const PORT = Number(process.env.ROO_MCP_PORT ?? 8787);
const HOST = process.env.ROO_MCP_HOST ?? '127.0.0.1';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function missingKey(res: ServerResponse): void {
  sendJson(res, 401, {
    jsonrpc: '2.0',
    error: {
      code: -32001,
      message:
        'Missing x-api-key header. Configure your MCP client with: --header "x-api-key: YOUR_ROO_KEY" (get one at https://app.roo.bz Account Settings > Api Keys).',
    },
    id: null,
  });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    missingKey(res);
    return;
  }
  const server = buildServer({ apiKey });
  const transport = new StreamableHTTPServerTransport({});
  // Cast through Transport: the Node transport's accessor types widen onclose/onerror to
  // `(() => void) | undefined`, which clashes with the Transport interface's plain optional
  // under `exactOptionalPropertyTypes`. SDK typing nit; the shapes are compatible at runtime.
  await server.connect(transport as unknown as Transport);
  await transport.handleRequest(req, res);
}

const httpServer = createServer((req, res) => {
  // Minimal access log; never includes headers or body.
  const started = Date.now();
  res.on('finish', () => {
    process.stdout.write(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms\n`);
  });

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/mcp') {
    handleMcp(req, res).catch((err: unknown) => {
      process.stderr.write(`roo-mcp: unhandled /mcp error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    });
    return;
  }

  sendJson(res, 404, { error: 'Not Found. The MCP endpoint is /mcp; health check at /health.' });
});

httpServer.listen(PORT, HOST, () => {
  process.stdout.write(`roo-mcp HTTP listening on http://${HOST}:${PORT}  (endpoint: /mcp, health: /health)\n`);
});

// Graceful shutdown so systemd reloads don't drop in-flight requests mid-SSE.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    process.stdout.write(`roo-mcp: ${signal} received, closing HTTP server\n`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
