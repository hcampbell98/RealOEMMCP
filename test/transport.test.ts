import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageData, imageBytes } from './image-fixture.js';
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

test('Diagram images validate URLs, share catalog pacing, preserve bytes, and cache successes', async () => {
  const originalFetch = globalThis.fetch;
  const transport = new HttpTransport();
  const starts: number[] = [];
  try {
    globalThis.fetch = async (input, options) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://new-ui.realoem.com');
      assert.equal(options?.redirect, 'manual');
      starts.push(Date.now());
      return url.pathname.endsWith('.jpg')
        ? new Response(imageBytes, { headers: { 'Content-Type': 'image/png' } })
        : new Response('<div id="main">Catalog</div>');
    };
    for (const url of [
      'https://other.example/bmw/images/diag_aaph.jpg',
      'https://new-ui.realoem.com/bmw/enUS/select',
      'https://user@new-ui.realoem.com/bmw/images/diag_aaph.jpg',
    ]) {
      await assert.rejects(transport.getImage(url), /Unsupported/);
    }
    assert.equal(starts.length, 0);
    await transport.get('select', { vin: 'VM52466' });
    const image = await transport.getImage('https://www.realoem.com/bmw/images/diag_aaph.jpg');
    assert.equal(image.data, imageData);
    assert.equal(image.mimeType, 'image/png');
    assert.ok(starts[1] - starts[0] >= 900);
    assert.deepEqual(await transport.getImage(image.sourceUrl), image);
    assert.equal(starts.length, 2);
  } finally {
    await transport.close();
    globalThis.fetch = originalFetch;
  }
});

test('Diagram images reject redirects, HTML challenges, MIME mismatches and oversized streams', async () => {
  const originalFetch = globalThis.fetch;
  const url = 'https://new-ui.realoem.com/bmw/images/diag_aaph.jpg';
  try {
    for (const [response, error] of [
      [new Response('', { status: 302 }), /Redirects are not followed/],
      [
        new Response('<html>Challenge</html>', { headers: { 'Content-Type': 'text/html' } }),
        /supported diagram image/,
      ],
      [new Response(imageBytes, { headers: { 'Content-Type': 'image/jpeg' } }), /does not match/],
      [
        new Response(new Uint8Array(2_000_001), { headers: { 'Content-Type': 'image/png' } }),
        /2 MB/,
      ],
    ] as const) {
      globalThis.fetch = async () => response;
      const transport = new HttpTransport();
      await assert.rejects(transport.getImage(url), error);
      globalThis.fetch = async () =>
        new Response(imageBytes, { headers: { 'Content-Type': 'image/png' } });
      assert.equal((await transport.getImage(url)).data, imageData, 'Failures must not be cached');
      await transport.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
