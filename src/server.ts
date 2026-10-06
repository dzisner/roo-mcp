// Transport-agnostic server factory. Builds an McpServer, registers every tool, returns it.
// The caller (index.ts today; an HTTP entrypoint later) binds a transport.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RooClient } from './roo-client.js';
import { registerAccountTools } from './tools/account.js';
import { registerShortlinkTools } from './tools/shortlinks.js';
import { registerAddOnTools } from './tools/addons.js';
import { ROO_ICON_DATA_URL } from './icon.js';

export interface BuildServerOptions {
  apiKey: string;
}

export function buildServer({ apiKey }: BuildServerOptions): McpServer {
  const client = new RooClient({ apiKey });
  const server = new McpServer({
    name: 'roo-mcp',
    version: '0.0.1',
    // Advertised to MCP clients that render connector icons (Claude Desktop etc.).
    icons: [
      {
        src: ROO_ICON_DATA_URL,
        mimeType: 'image/vnd.microsoft.icon',
        sizes: ['48x48', '32x32'],
      },
    ],
  });

  registerAccountTools(server, client);
  registerShortlinkTools(server, client);
  registerAddOnTools(server, client);

  return server;
}
