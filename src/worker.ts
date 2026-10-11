import { DurableObject } from 'cloudflare:workers';
import { createOAuthProvider } from './oauth.js';
import { HttpTransport } from './transport.js';

// One coordinator per deployment/upstream catalog, shared by all MCP clients.
// Its queue deliberately limits aggregate upstream traffic to one request/second.
export class CatalogCoordinator extends DurableObject<Env> {
  private catalog!: HttpTransport;
  private loginAttempts: Record<string, number> = {};
  private loginWindow = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<{ window: number; attempts: Record<string, number> }>(
        'loginAttempts',
      );
      this.loginWindow = saved?.window || 0;
      this.loginAttempts = saved?.attempts || {};
      this.catalog = new HttpTransport({
        lastRequest: await ctx.storage.get<number>('lastRequest'),
        onRequestStart: (time) => ctx.storage.put('lastRequest', time),
        accessGuidance:
          'The default RealOEM host blocked this Worker request. Retry later. Browser transport is available only in the local Node.js server.',
      });
    });
  }

  async allowLoginAttempt(ipHash: string) {
    const window = Math.floor(Date.now() / 60_000);
    if (window !== this.loginWindow) {
      this.loginWindow = window;
      this.loginAttempts = {};
    }
    const total = this.loginAttempts.total || 0;
    const perIp = this.loginAttempts[ipHash] || 0;
    if (total >= 100 || perIp >= 5) return false;
    this.loginAttempts.total = total + 1;
    this.loginAttempts[ipHash] = perIp + 1;
    await this.ctx.storage.put('loginAttempts', {
      window: this.loginWindow,
      attempts: this.loginAttempts,
    });
    return true;
  }

  async get(endpoint: string, params: Record<string, string | undefined>) {
    return this.catalog.get(endpoint, params);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (!env.MCP_AUTH_TOKEN)
      return new Response('MCP authentication is not configured', { status: 503 });
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (url.pathname === '/mcp' && origin && origin !== url.origin) {
      return new Response('Origin not allowed', { status: 403 });
    }
    return createOAuthProvider(url.origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
