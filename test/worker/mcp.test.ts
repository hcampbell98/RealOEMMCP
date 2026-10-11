import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { imageData, imageBytes } from '../image-fixture.js';
import { OAuthTestClient } from './oauth-client.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('Worker serves authenticated MCP and coordinates concurrent catalog requests', async () => {
  const starts: number[] = [];
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
          async outboundService(request) {
            starts.push(Date.now());
            const url = new URL(request.url);
            assert.equal(url.origin, 'https://new-ui.realoem.com');
            if (url.pathname === '/bmw/images/diag_aaph.jpg') {
              return new Response(imageBytes, { headers: { 'Content-Type': 'image/png' } });
            }
            assert.equal(url.searchParams.get('ui'), 'v1');
            assert.equal(request.headers.get('User-Agent'), 'RealOEMMCP/0.1');
            const endpoint = url.pathname.split('/').pop();
            const suffix = url.searchParams.get('diagId') || url.searchParams.get('mg') || 'root';
            const html = await readFile(
              new URL(`../fixtures/${endpoint}-${suffix}.html`, import.meta.url),
              'utf8',
            );
            return new Response(html, { headers: { 'Content-Type': 'text/html' } });
          },
        },
      ],
    }),
  );
  const clients: Client[] = [];
  try {
    const unauthorized = await worker.dispatchFetch('https://mcp.example/mcp', { method: 'POST' });
    assert.equal(unauthorized.status, 401);
    const forbidden = await worker.dispatchFetch('https://mcp.example/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer integration-test-token', Origin: 'https://other.example' },
    });
    assert.equal(forbidden.status, 403);
    assert.equal(starts.length, 0);
    assert.equal((await worker.dispatchFetch('https://mcp.example/missing')).status, 404);

    const oauth = new OAuthTestClient(
      async (url, init) => {
        const response = await worker.dispatchFetch(url, init);
        return new Response(response.body, { status: response.status, headers: response.headers });
      },
      'https://mcp.example',
      'integration-test-token',
    );
    const tokens = await oauth.authorize();

    for (let index = 0; index < 2; index++) {
      const client = new Client({ name: 'worker-test', version: '1.0' });
      clients.push(client);
      const transport = new StreamableHTTPClientTransport(new URL('https://mcp.example/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
        fetch: async (input, init) => {
          const response = await worker.dispatchFetch(String(input), init);
          return new Response(response.body, {
            status: response.status,
            headers: Object.fromEntries(response.headers),
          });
        },
      });
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, 7);
    }

    const vehicleId = 'UM92-EUR-01-2011-E88-BMW-118d';
    const [vehicle, diagram] = await Promise.all([
      clients[0].callTool({ name: 'identify_vehicle', arguments: { vin: 'VM52466' } }),
      clients[1].callTool({
        name: 'get_diagram_parts',
        arguments: { vehicleId, diagramId: '33_1231' },
      }),
    ]);
    assert.ok(!vehicle.isError);
    assert.ok(!diagram.isError);
    const vehicles = vehicle.structuredContent?.vehicles as { vehicleId: string }[];
    const parts = diagram.structuredContent?.parts as { partNumber: string }[];
    assert.equal(vehicles[0].vehicleId, vehicleId);
    assert.ok(parts.some((part) => part.partNumber === '33416762317'));
    assert.equal(starts.length, 2);
    assert.ok(starts[1] - starts[0] >= 900, 'Upstream requests must be at least one second apart');

    const cached = await clients[1].callTool({
      name: 'identify_vehicle',
      arguments: { vin: 'VM52466' },
    });
    assert.ok(!cached.isError);
    assert.equal(starts.length, 2, 'Catalog cache must be shared between MCP clients');
    const image = await clients[0].callTool({
      name: 'get_diagram_image',
      arguments: { vehicleId, diagramId: '33_1231' },
    });
    assert.ok(!image.isError);
    assert.deepEqual(image.content[0], { type: 'image', data: imageData, mimeType: 'image/png' });
    assert.equal(
      image.structuredContent?.imageUrl,
      'https://new-ui.realoem.com/bmw/images/diag_aaph.jpg',
    );
    assert.equal(starts.length, 3);
    assert.ok(starts[2] - starts[1] >= 900, 'Images must share catalog request pacing');
    const cachedImage = await clients[1].callTool({
      name: 'get_diagram_image',
      arguments: { vehicleId, diagramId: '33_1231' },
    });
    assert.ok(!cachedImage.isError);
    assert.equal(starts.length, 3, 'Image cache must be shared between MCP clients');
  } finally {
    for (const client of clients) await client.close();
    await worker.dispose();
  }
});

test('Worker fails closed when its authentication secret is missing', async () => {
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          modules: true,
          scriptPath: '.wrangler/build/worker.js',
          compatibilityDate: '2026-10-11',
          compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
          kvNamespaces: ['OAUTH_KV'],
          durableObjects: { CATALOG: { className: 'CatalogCoordinator', useSQLite: true } },
        },
      ],
    }),
  );
  try {
    assert.equal((await worker.dispatchFetch('https://mcp.example/mcp')).status, 503);
  } finally {
    await worker.dispose();
  }
});
