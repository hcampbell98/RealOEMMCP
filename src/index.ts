#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_TRANSPORT, harTransport, LiveTransport } from './transport.js';
import { createServer } from './server.js';

const mode = process.env.REALOEM_TRANSPORT || DEFAULT_TRANSPORT;
if (!['browser', 'http', 'har'].includes(mode))
  throw new Error('REALOEM_TRANSPORT must be browser, http or har');
if (mode === 'har' && !process.env.REALOEM_HAR_PATH)
  throw new Error('HAR mode requires REALOEM_HAR_PATH');
const transport =
  mode === 'har'
    ? await harTransport(process.env.REALOEM_HAR_PATH!)
    : new LiveTransport(mode as 'browser' | 'http');
const server = createServer(transport);
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  await server.close();
  await transport.close();
}
process.on('SIGINT', () => {
  void close().then(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void close().then(() => process.exit(0));
});
process.stdin.on('end', () => {
  void close();
});
await server.connect(new StdioServerTransport());
