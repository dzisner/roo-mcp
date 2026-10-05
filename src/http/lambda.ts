// AWS Lambda handler for API Gateway HTTP API v2 ($default route).
// Converts the APIGW event → Web Standard Request, routes to /mcp or /health,
// then converts the Response back. Uses the SDK's web-standard streamable HTTP
// transport in JSON-response mode (API Gateway buffers responses, so SSE is a
// non-starter; JSON mode is spec-compliant for our stateless request/response
// workload).
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildServer } from '../server.js';

function unauthorized(): Response {
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

function toRequest(event: APIGatewayProxyEventV2): Request {
  const method = event.requestContext.http.method;
  const scheme = event.headers['x-forwarded-proto'] ?? 'https';
  const host = event.headers['host'] ?? 'localhost';
  const path = event.rawPath || '/';
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const url = `${scheme}://${host}${path}${qs}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers)) {
    if (typeof v === 'string') headers.set(k, v);
  }

  const init: RequestInit = { method, headers };
  if (event.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = event.isBase64Encoded
      ? Uint8Array.from(Buffer.from(event.body, 'base64'))
      : event.body;
  }
  return new Request(url, init);
}

async function toApiGwResponse(res: Response): Promise<APIGatewayProxyStructuredResultV2> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const bodyText = await res.text();
  return { statusCode: res.status, headers, body: bodyText };
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const method = event.requestContext.http.method;
  const path = event.rawPath || '/';

  if (path === '/health') {
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    };
  }

  if (path !== '/mcp') {
    return {
      statusCode: 404,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Not Found. The MCP endpoint is /mcp; health check at /health.' }),
    };
  }

  const apiKey = event.headers['x-api-key'];
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return toApiGwResponse(unauthorized());
  }

  const server = buildServer({ apiKey });
  const transport = new WebStandardStreamableHTTPServerTransport({
    // API Gateway buffers responses; MCP spec allows a single JSON body.
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(toRequest(event));
  return toApiGwResponse(response);
};
