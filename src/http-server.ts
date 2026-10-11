import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from './server.js';
import type { Transport } from './transport.js';

export async function handleMcpRequest(request: Request, catalog: Transport) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return new Response('Origin not allowed', { status: 403 });
  }

  const server = createServer(catalog);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: 64 * 1024,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
