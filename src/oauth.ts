import OAuthProvider, {
  AuthorizationError,
  OAuthError,
  insufficientScope,
  type ConsentDescription,
  type OAuthHelpers,
  type OAuthResourceContext,
} from '@cloudflare/workers-oauth-provider';
import { handleMcpRequest } from './http-server.js';
import type { Transport } from './transport.js';

interface LoginEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

interface LoginProps {
  credentialFingerprint: string;
}

export async function fingerprint(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function matchesSecret(received: string, expected: string) {
  if (!received || received.length > 4096) return false;
  const [left, right] = await Promise.all([fingerprint(received), fingerprint(expected)]);
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!;
  });
}

function page(body: string, headers = new Headers(), status = 200) {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  // no-referrer makes browser form POSTs send Origin: null. Preserve same-origin
  // identification for the CSRF check while suppressing referrers to OAuth callbacks.
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1"><title>RealOEM MCP access</title>
    <style>body{font:16px/1.5 system-ui,sans-serif;background:#f4f5f7;color:#16202a;margin:0;padding:24px}
    main{max-width:540px;margin:5vh auto;background:white;padding:32px;border-radius:12px}
    h1{font-size:26px;line-height:1.2}input{box-sizing:border-box;width:100%;padding:12px;margin:8px 0 20px;border:1px solid #78828c;border-radius:6px;font:inherit}
    button{font:inherit;padding:10px 20px;cursor:pointer;border-radius:6px;border:1px solid #78828c;margin:0 8px 8px 0}
    button[value=allow]{background:#174b83;color:white;border-color:#174b83}code{overflow-wrap:anywhere}small{display:block;color:#46515d}</style>
    </head><body><main>${body}</main></body></html>`,
    { status, headers },
  );
}

function consentPage(description: ConsentDescription, handle: string, headers: Headers) {
  const identity = description.clientDomain
    ? `Client domain: <strong>${escapeHtml(description.clientDomain)}</strong>`
    : 'The client name is self-reported.';
  return page(
    `<h1>Connect to RealOEM MCP</h1>
    <p><strong>${escapeHtml(description.clientName)}</strong> is requesting access.</p><small>${identity}</small>
    <p>Allow this client to look up BMW vehicles, browse catalog diagrams, and retrieve parts.
    It can keep access by refreshing its login for up to 30 days.</p>
    <p>Return destination: <strong>${escapeHtml(description.redirectHost)}</strong><br>
    <small><code>${escapeHtml(description.redirectUri)}</code></small></p>
    ${description.redirectIsLoopback ? '<p>This returns to a local app. Check which app is listening on your computer before allowing access.</p>' : ''}
    <form method="post" action="/authorize">
    <input type="hidden" name="handle" value="${escapeHtml(handle)}">
    <label for="token">Deployment token</label>
    <input id="token" name="token" type="password" autocomplete="off" maxlength="4096">
    <small>Enter the MCP_AUTH_TOKEN set when you deployed this Worker. Your token is checked here and is never sent to the client.</small>
    <p>Anyone with this token has the same catalog access.</p>
    <button type="submit" name="decision" value="allow">Allow access</button>
    <button type="submit" name="decision" value="deny">Deny</button></form>`,
    headers,
  );
}

// Bound the stream itself, rather than trusting Content-Length supplied by a client.
async function readForm(request: Request) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/x-www-form-urlencoded') {
    return new Response('Expected a form submission', { status: 415 });
  }
  const reader = request.body?.getReader();
  if (!reader) return new Response('Missing form', { status: 400 });
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.length;
    if (length > 16 * 1024) {
      await reader.cancel();
      return new Response('Form too large', { status: 413 });
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

const loginHandler = {
  async fetch(request: Request, bindings: Env) {
    const env = bindings as LoginEnv;
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') {
      return Response.json({ name: 'realoem-mcp', endpoint: '/mcp', authentication: 'oauth' });
    }
    if (url.pathname !== '/authorize') return new Response('Not found', { status: 404 });
    try {
      if (request.method === 'GET') {
        const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        if (!authRequest.codeChallenge || authRequest.codeChallengeMethod !== 'S256') {
          return page(
            '<h1>PKCE required</h1><p>Your MCP client must use PKCE with S256.</p>',
            undefined,
            400,
          );
        }
        const description = await env.OAUTH_PROVIDER.describeConsent(authRequest);
        const consent = await env.OAUTH_PROVIDER.beginConsent(authRequest);
        return consentPage(description, consent.handle, consent.headers);
      }
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      // The provider also binds consent to a secure browser cookie and a single-use handle.
      if (request.headers.get('Origin') !== url.origin) {
        return new Response('Origin not allowed', { status: 403 });
      }
      const form = await readForm(request);
      if (form instanceof Response) return form;
      const handle = form.get('handle') || '';
      if (form.get('decision') === 'deny') {
        const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
        return new Response(null, { status: 303, headers: denied.headers });
      }
      if (form.get('decision') !== 'allow')
        return new Response('Invalid decision', { status: 400 });
      const ipHash = await fingerprint(request.headers.get('CF-Connecting-IP') || 'local');
      const limiter = env.CATALOG.getByName('realoem');
      if (!(await limiter.allowLoginAttempt(ipHash))) {
        return page(
          '<h1>Too many attempts</h1><p>Wait one minute, then restart the connection from your MCP client.</p>',
          new Headers({ 'Retry-After': '60' }),
          429,
        );
      }
      if (!(await matchesSecret(form.get('token') || '', env.MCP_AUTH_TOKEN))) {
        return page(
          '<h1>Incorrect deployment token</h1><p>Go back to try again, or restart the connection from your MCP client.</p>',
          undefined,
          401,
        );
      }
      const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle, {
        scope: ['catalog:read', 'offline_access'],
      });
      const result = await env.OAUTH_PROVIDER.completeAuthorization({
        request: approved.request,
        userId: 'owner',
        scope: approved.request.scope,
        metadata: { name: 'Deployment owner' },
        props: {
          credentialFingerprint: await fingerprint(env.MCP_AUTH_TOKEN),
        } satisfies LoginProps,
      });
      approved.headers.set('Location', result.redirectTo);
      return new Response(null, { status: 303, headers: approved.headers });
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return page(
          '<h1>Authorization could not be completed</h1><p>Restart the connection from your MCP client.</p>',
          undefined,
          400,
        );
      }
      throw error;
    }
  },
};

export function createOAuthProvider(origin: string) {
  return new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: {
      async fetch(request, env, context) {
        if (new URL(request.url).pathname !== '/mcp')
          return new Response('Not found', { status: 404 });
        const ctx = context as OAuthResourceContext<LoginProps>;
        if (ctx.props.credentialFingerprint !== (await fingerprint(env.MCP_AUTH_TOKEN))) {
          return new Response('Login expired. Reconnect this MCP client.', {
            status: 401,
            headers: {
              'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
            },
          });
        }
        if (!ctx.auth.scope.includes('catalog:read'))
          return insufficientScope(ctx.auth, ['catalog:read']);
        const coordinator = env.CATALOG.getByName('realoem');
        const catalog: Transport = {
          get: (endpoint, params) => coordinator.get(endpoint, params),
          async close() {},
        };
        return handleMcpRequest(request, catalog);
      },
    },
    defaultHandler: loginHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: ['catalog:read', 'offline_access'],
    requiredScopes: ['catalog:read'],
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 60 * 60,
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'RealOEM MCP' },
    async tokenExchangeCallback({ props, env }) {
      if (props.credentialFingerprint !== (await fingerprint(env.MCP_AUTH_TOKEN))) {
        throw new OAuthError('invalid_grant', {
          description: 'Deployment token changed. Reconnect the MCP client.',
        });
      }
    },
  });
}
