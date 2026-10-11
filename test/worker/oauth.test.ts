import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { OAuthTestClient } from './oauth-client.js';

test('OAuth discovery, consent, PKCE, refresh, scope, audience, and revocation', async () => {
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          modules: true,
          scriptPath: '.wrangler/build/worker.js',
          compatibilityDate: '2026-10-11',
          compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
          bindings: { MCP_AUTH_TOKEN: 'integration-test-token' },
          kvNamespaces: ['OAUTH_KV'],
          durableObjects: { CATALOG: { className: 'CatalogCoordinator', useSQLite: true } },
        },
      ],
    }),
  );
  let ip = '192.0.2.1';
  const fetch = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('CF-Connecting-IP', ip);
    const result = await worker.dispatchFetch(url, { ...init, headers });
    return new Response(result.body, { status: result.status, headers: result.headers });
  };
  const origin = 'https://mcp.example';
  const client = new OAuthTestClient(fetch, origin, 'integration-test-token');
  try {
    const challenge = await fetch(`${origin}/mcp`);
    assert.equal(challenge.status, 401);
    assert.match(challenge.headers.get('www-authenticate')!, /resource_metadata=/);
    const resource = await (
      await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)
    ).json();
    assert.equal(resource.resource, `${origin}/mcp`);
    assert.deepEqual(resource.authorization_servers, [origin]);
    const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    assert.equal(metadata.authorization_response_iss_parameter_supported, true);
    assert.equal(metadata.client_id_metadata_document_supported, true);
    assert.equal(metadata.registration_endpoint, `${origin}/oauth/register`);
    assert.equal(
      (
        await fetch(`${origin}/mcp`, {
          headers: { Authorization: 'Bearer integration-test-token' },
        })
      ).status,
      401,
    );

    await client.register('<script>alert("unsafe")</script>');
    const consent = await client.begin();
    // Chrome sends Origin: null for form POSTs under no-referrer, breaking our CSRF check.
    // Keep same-origin form submissions identifiable without leaking OAuth URLs to callbacks.
    assert.equal(consent.referrerPolicy, 'same-origin');
    assert.ok(!consent.html.includes('<script>'));
    assert.match(consent.html, /&lt;script&gt;/);
    assert.match(consent.html, /client.example/);
    assert.equal((await client.submit(consent.handle, '', client.loginToken)).status, 400);
    assert.equal((await client.submit(consent.handle, consent.cookie, 'wrong-token')).status, 401);
    const crossOrigin = await fetch(`${origin}/authorize`, {
      method: 'POST',
      headers: {
        Origin: 'https://attacker.example',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        handle: consent.handle,
        token: client.loginToken,
        decision: 'allow',
      }).toString(),
    });
    assert.equal(crossOrigin.status, 403);
    const denied = await client.submit(consent.handle, consent.cookie, '', 'deny');
    assert.equal(denied.status, 303);
    assert.equal(
      new URL(denied.headers.get('location')!).searchParams.get('error'),
      'access_denied',
    );
    assert.equal((await client.submit(consent.handle, consent.cookie)).status, 400);

    const noPkce = new URL(client.authUrl());
    noPkce.searchParams.delete('code_challenge');
    noPkce.searchParams.delete('code_challenge_method');
    assert.equal((await fetch(noPkce.href)).status, 400);
    const wrongAudience = new URL(client.authUrl());
    wrongAudience.searchParams.set('resource', 'https://other.example/mcp');
    assert.equal((await fetch(wrongAudience.href)).status, 400);
    const wrongRedirect = new URL(client.authUrl());
    wrongRedirect.searchParams.set('redirect_uri', 'https://attacker.example/callback');
    assert.equal((await fetch(wrongRedirect.href)).status, 400);
    const oversized = await fetch(`${origin}/authorize`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${'x'.repeat(17 * 1024)}`,
    });
    assert.equal(oversized.status, 413);

    ip = '192.0.2.2';
    const pending = await client.begin();
    const allowed = await client.submit(pending.handle, pending.cookie);
    const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!;
    assert.equal((await client.exchange(code, 'x'.repeat(43))).status, 400);
    // A bad verifier must not issue tokens. Start a fresh consent for the successful flow.
    const tokens = await client.authorize();
    assert.equal(tokens.expires_in, 3600);
    const useToken = (token: string, host = origin) =>
      fetch(`${host}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
    assert.equal((await useToken(tokens.access_token)).status, 200);
    assert.equal((await useToken(tokens.access_token, 'https://other.example')).status, 401);
    const refreshed = await client.token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    assert.equal(refreshed.status, 200);
    const rotated = await refreshed.json();
    assert.notEqual(rotated.refresh_token, tokens.refresh_token);
    assert.equal((await useToken(rotated.access_token)).status, 200);
    const downscoped = await client.token({
      grant_type: 'refresh_token',
      refresh_token: rotated.refresh_token,
      scope: 'offline_access',
    });
    assert.equal(downscoped.status, 200);
    const limited = await downscoped.json();
    const insufficient = await useToken(limited.access_token);
    assert.equal(insufficient.status, 403);
    assert.match(insufficient.headers.get('www-authenticate')!, /insufficient_scope/);
    const revoked = await fetch(metadata.revocation_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.clientId,
        token: limited.refresh_token,
        token_type_hint: 'refresh_token',
      }).toString(),
    });
    assert.equal(revoked.status, 200);
    assert.equal(
      (await client.token({ grant_type: 'refresh_token', refresh_token: limited.refresh_token }))
        .status,
      400,
    );
    assert.equal((await useToken(limited.access_token)).status, 401);

    const replay = await client.authorize();
    assert.equal((await client.exchange(replay.code)).status, 400);
    assert.equal((await useToken(replay.access_token)).status, 401);

    ip = '192.0.2.3';
    const throttled = await client.begin();
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal(
        (await client.submit(throttled.handle, throttled.cookie, 'incorrect')).status,
        401,
      );
    }
    assert.equal(
      (await client.submit(throttled.handle, throttled.cookie, 'incorrect')).status,
      429,
    );
  } finally {
    await worker.dispose();
  }
});

test('OAuth tokens expire and deployment token rotation requires a new login', async () => {
  const options = (secret: string) =>
    convertV4MiniflareOptions({
      workers: [
        {
          modules: true,
          scriptPath: '.wrangler/build/worker.js',
          compatibilityDate: '2026-10-11',
          compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
          bindings: { MCP_AUTH_TOKEN: secret },
          kvNamespaces: ['OAUTH_KV'],
          durableObjects: { CATALOG: { className: 'CatalogCoordinator', useSQLite: true } },
        },
      ],
    });
  const worker = new Miniflare(options('original-token'));
  const fetch = async (url: string, init?: RequestInit) => {
    const result = await worker.dispatchFetch(url, init);
    return new Response(result.body, { status: result.status, headers: result.headers });
  };
  const client = new OAuthTestClient(fetch, 'https://mcp.example', 'original-token');
  const useToken = (token: string) =>
    fetch('https://mcp.example/mcp', { headers: { Authorization: `Bearer ${token}` } });
  try {
    const tokens = await client.authorize();
    const kv = await worker.getKVNamespace('OAUTH_KV');
    const entries = await kv.list({ prefix: 'token:' });
    assert.equal(entries.keys.length, 1);
    const record = await kv.get<Record<string, unknown>>(entries.keys[0].name, 'json');
    assert.ok(record);
    await kv.put(
      entries.keys[0].name,
      JSON.stringify({ ...record, expiresAt: Math.floor(Date.now() / 1000) - 1 }),
    );
    assert.equal((await useToken(tokens.access_token)).status, 401);
    const refreshed = await client.token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    assert.equal(refreshed.status, 200);
    const valid = await refreshed.json();
    // GET reaches the authenticated MCP handler, which rejects standalone SSE in stateless mode.
    assert.notEqual((await useToken(valid.access_token)).status, 401);
    await worker.setOptions(options('replacement-token'));
    assert.equal((await useToken(valid.access_token)).status, 401);
    assert.equal(
      (await client.token({ grant_type: 'refresh_token', refresh_token: valid.refresh_token }))
        .status,
      400,
    );
    const consent = await client.begin();
    assert.equal(
      (await client.submit(consent.handle, consent.cookie, 'original-token')).status,
      401,
    );
    assert.equal(
      (await client.submit(consent.handle, consent.cookie, 'replacement-token')).status,
      303,
    );
  } finally {
    await worker.dispose();
  }
});
