import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const path = process.env.REALOEM_HAR_PATH;
if (!path) throw new Error('Set REALOEM_HAR_PATH to the original captured HAR');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    ),
    REALOEM_TRANSPORT: 'har',
    REALOEM_HAR_PATH: path,
  },
  stderr: 'inherit',
});
const client = new Client({ name: 'realoem-smoke', version: '1.0' });
await client.connect(transport);
try {
  console.log('Tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
  const v = await client.callTool({ name: 'identify_vehicle', arguments: { vin: 'VM52466' } });
  const id = (v.structuredContent as any).vehicles[0].vehicleId;
  for (const [name, args] of [
    ['list_part_groups', { vehicleId: id }],
    ['list_diagrams', { vehicleId: id, groupId: '18' }],
    ['get_diagram_parts', { vehicleId: id, diagramId: '26_0216' }],
    ['search_parts', { vehicleId: id, diagramId: '18_0731', query: '18307812283' }],
  ] as const) {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    console.log(name, 'OK');
  }
} finally {
  await client.close();
}
