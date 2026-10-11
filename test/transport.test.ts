import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpTransport } from '../src/transport.js';

test('HTTP transport rejects redirects and oversized HTML without caching failures', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_input, options) => {
      assert.equal(options?.redirect, 'manual');
      return new Response('', { status: 302, headers: { Location: 'https://other.example/' } });
    };
    const redirects = new HttpTransport();
    await assert.rejects(redirects.get('select', { vin: 'VM52466' }), /Redirects are not followed/);
    await redirects.close();

    globalThis.fetch = async () => new Response('x'.repeat(2_000_001));
    const oversized = new HttpTransport();
    await assert.rejects(oversized.get('select', { vin: 'VM52466' }), /2 MB response limit/);
    globalThis.fetch = async () => new Response('<div id="main">Catalog</div>');
    assert.equal((await oversized.get('select', { vin: 'VM52466' })).source, 'live');
    await oversized.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
