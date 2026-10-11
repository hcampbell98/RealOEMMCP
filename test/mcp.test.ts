import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { LiveTransport } from '../src/transport.js';
test('MCP discovery, vehicle workflow, validation and tool errors', async () => {
  const server = createServer({
    async get(endpoint, params) {
      const suffix = params.diagId || params.mg || 'root';
      const html = await readFile(
        new URL(`./fixtures/${endpoint}-${suffix}.html`, import.meta.url),
        'utf8',
      );
      return {
        html,
        source: 'live',
        sourceUrl: 'https://www.realoem.com/bmw/enUS/' + endpoint,
        retrievedAt: '2026-10-11',
      };
    },
    async close() {},
  });
  const client = new Client({ name: 'test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    assert.match(
      client.getInstructions() || '',
      /Live access defaults to HTTP on https:\/\/new-ui\.realoem\.com/,
    );
    const list = await client.listTools();
    assert.equal(list.tools.length, 6);
    const vehicle = await client.callTool({
      name: 'identify_vehicle',
      arguments: { vin: 'VM52466' },
    });
    assert.equal(vehicle.isError, undefined);
    const id = (vehicle.structuredContent as any).vehicles[0].vehicleId;
    const diagrams = await client.callTool({
      name: 'list_diagrams',
      arguments: { vehicleId: id, groupId: '18', query: 'particulate' },
    });
    assert.equal((diagrams.structuredContent as any).diagrams.length, 1);
    const parts = await client.callTool({
      name: 'get_diagram_parts',
      arguments: { vehicleId: id, diagramId: '26_0216' },
    });
    assert.equal((parts.structuredContent as any).parts.length, 2);
    assert.equal((parts.structuredContent as any).source, 'live');
    const invalid = await client.callTool({
      name: 'identify_vehicle',
      arguments: { vin: 'bad vin' },
    });
    assert.equal(invalid.isError, true);
    const missing = await client.callTool({
      name: 'get_diagram_parts',
      arguments: { vehicleId: id, diagramId: '99_9999' },
    });
    assert.equal(missing.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});
test('MCP accepts and normalises part numbers containing letters and preserves result anchors', async () => {
  let receivedQuery: string | undefined;
  const server = createServer({
    async get(endpoint, params) {
      assert.equal(endpoint, 'partsearch');
      receivedQuery = params.q;
      return {
        html: '<div id="main"><div class="content"><h1>33215A1A7D9</h1><h2>ABS sensor ring</h2><a href="showparts?id=UM92-EUR-01-2011-E88-BMW-118d&amp;diagId=33_3013#33215A1A7D9">Sensor ring</a></div></div>',
        source: 'live',
        sourceUrl: 'https://new-ui.realoem.com/bmw/enUS/partsearch',
        retrievedAt: '2026-10-11',
      };
    },
    async close() {},
  });
  const client = new Client({ name: 'test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const r = await client.callTool({
      name: 'search_parts',
      arguments: { vehicleId: 'UM92-EUR-01-2011-E88-BMW-118d', query: '33 21 5a1a7d9' },
    });
    assert.ok(!r.isError);
    assert.equal(receivedQuery, '33215A1A7D9');
    assert.equal((r.structuredContent as any).diagrams[0].partNumber, '33215A1A7D9');
  } finally {
    await client.close();
    await server.close();
  }
});
test('default transport uses verified HTTP host, caches pages and explains access failures', async () => {
  const original = globalThis.fetch;
  const previousBase = process.env.REALOEM_BASE_URL;
  delete process.env.REALOEM_BASE_URL;
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://new-ui.realoem.com');
    assert.equal(url.searchParams.get('ui'), 'v1');
    return new Response('<div id="main">Catalog</div>', { status: 200 });
  };
  const t = new LiveTransport();
  try {
    await t.get('select', { vin: 'VM52466' });
    await t.get('select', { vin: 'VM52466' });
    assert.equal(calls, 1);
    globalThis.fetch = async () => new Response('<title>Just a moment...</title>', { status: 403 });
    await assert.rejects(
      t.get('select', { vin: 'AB12345' }),
      /HTTP 403 from https:\/\/new-ui\.realoem\.com using http.*REALOEM_TRANSPORT=browser/,
    );
    process.env.REALOEM_BASE_URL = 'https://www.realoem.com/bmw/enUS/';
    const overridden = new LiveTransport();
    try {
      await assert.rejects(
        overridden.get('select', { vin: 'AB12345' }),
        /Use the verified defaults: REALOEM_TRANSPORT=http and REALOEM_BASE_URL=https:\/\/new-ui\.realoem\.com/,
      );
    } finally {
      await overridden.close();
    }
  } finally {
    globalThis.fetch = original;
    if (previousBase === undefined) delete process.env.REALOEM_BASE_URL;
    else process.env.REALOEM_BASE_URL = previousBase;
    await t.close();
  }
});
