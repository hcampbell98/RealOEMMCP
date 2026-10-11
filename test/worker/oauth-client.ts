import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export class OAuthTestClient {
  clientId = '';
  readonly redirectUri = 'https://client.example/callback';
  readonly verifier = randomBytes(32).toString('base64url');

  constructor(
    readonly fetch: Fetcher,
    readonly origin: string,
    readonly loginToken: string,
  ) {}

  async register(name = 'MCP test client') {
    const response = await this.fetch(`${this.origin}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [this.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(response.status, 201);
    this.clientId = (await response.json()).client_id;
  }

  authUrl() {
    const query = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'catalog:read offline_access',
      state: 'test-client-state',
      resource: `${this.origin}/mcp`,
      code_challenge: createHash('sha256').update(this.verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    return `${this.origin}/authorize?${query}`;
  }

  async begin() {
    const response = await this.fetch(this.authUrl());
    assert.equal(response.status, 200);
    const html = await response.text();
    const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
    assert.ok(handle);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    return {
      html,
      handle,
      cookie,
      referrerPolicy: response.headers.get('referrer-policy'),
      contentSecurityPolicy: response.headers.get('content-security-policy'),
    };
  }

  submit(handle: string, cookie: string, token = this.loginToken, decision = 'allow') {
    return this.fetch(`${this.origin}/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: this.origin,
        Cookie: cookie,
      },
      body: new URLSearchParams({ handle, token, decision }).toString(),
      redirect: 'manual',
    });
  }

  token(parameters: Record<string, string>) {
    return this.fetch(`${this.origin}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        resource: `${this.origin}/mcp`,
        ...parameters,
      }).toString(),
    });
  }

  exchange(code: string, verifier = this.verifier) {
    return this.token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: this.redirectUri,
    });
  }

  async authorize() {
    if (!this.clientId) await this.register();
    const consent = await this.begin();
    const allowed = await this.submit(consent.handle, consent.cookie);
    assert.equal(allowed.status, 303);
    const callback = new URL(allowed.headers.get('location')!);
    assert.equal(callback.searchParams.get('state'), 'test-client-state');
    assert.equal(callback.searchParams.get('iss'), this.origin);
    const code = callback.searchParams.get('code')!;
    assert.ok(code);
    const response = await this.exchange(code);
    assert.equal(response.status, 200);
    const tokens = await response.json();
    assert.ok(tokens.access_token && tokens.refresh_token);
    assert.notEqual(tokens.access_token, this.loginToken);
    assert.equal(tokens.resource, `${this.origin}/mcp`);
    return { ...tokens, code };
  }
}
