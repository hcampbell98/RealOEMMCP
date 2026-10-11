#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_TRANSPORT, LiveTransport } from './transport.js';
import { createServer } from './server.js';

const mode = process.env.REALOEM_TRANSPORT || DEFAULT_TRANSPORT;
if (mode !== 'browser' && mode !== 'http') {
  throw new Error('REALOEM_TRANSPORT must be browser or http');
}
const transport = new LiveTransport(mode);
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
