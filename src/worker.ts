import { DurableObject } from 'cloudflare:workers';
import { handleMcpRequest } from './http-server.js';
import { HttpTransport, type Transport } from './transport.js';

// One coordinator per deployment/upstream catalog, shared by all MCP clients.
// Its queue deliberately limits aggregate upstream traffic to one request/second.
export class CatalogCoordinator extends DurableObject<Env> {
  private catalog!: HttpTransport;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.catalog = new HttpTransport({
        lastRequest: await ctx.storage.get<number>('lastRequest'),
        onRequestStart: (time) => ctx.storage.put('lastRequest', time),
        accessGuidance:
          'The default RealOEM host blocked this Worker request. Retry later. Browser transport is available only in the local Node.js server.',
      });
    });
  }

  async get(endpoint: string, params: Record<string, string | undefined>) {
    return this.catalog.get(endpoint, params);
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/' && request.method === 'GET') {
      return Response.json({ name: 'realoem-mcp', endpoint: '/mcp' });
    }
    if (path !== '/mcp') return new Response('Not found', { status: 404 });

    const coordinator = env.CATALOG.getByName('realoem');
    const catalog: Transport = {
      get: (endpoint, params) => coordinator.get(endpoint, params),
      async close() {},
    };
    return handleMcpRequest(request, catalog, env.MCP_AUTH_TOKEN);
  },
} satisfies ExportedHandler<Env>;
