// Cloudflare Workers entrypoint for the hosted MCP endpoint at mcp.roo.bz.
// Stateless: each request builds its own McpServer with the caller's x-api-key.
// No key storage; Roo's API validates the key on the first proxied call.
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildServer } from '../server.js';

function missingKeyResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message:
          'Missing x-api-key header. Configure your MCP client with: --header "x-api-key: YOUR_ROO_KEY" (get one at https://app.roo.bz Account Settings > Api Keys).',
      },
      id: null,
    }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/mcp') {
      return new Response('Not Found. The MCP endpoint is /mcp.', { status: 404 });
    }

    const apiKey = request.headers.get('x-api-key');
    if (!apiKey) return missingKeyResponse();

    const server = buildServer({ apiKey });
    // Omitting sessionIdGenerator = stateless mode. Our tools have no cross-call state.
    const transport = new WebStandardStreamableHTTPServerTransport({});
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
