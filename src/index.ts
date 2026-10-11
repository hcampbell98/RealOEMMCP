#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_TRANSPORT, HttpTransport } from './transport.js';
import { createServer } from './server.js';

const mode = process.env.REALOEM_TRANSPORT || DEFAULT_TRANSPORT;
if (mode !== 'browser' && mode !== 'http') {
  throw new Error('REALOEM_TRANSPORT must be browser or http');
}
const options = { baseUrl: process.env.REALOEM_BASE_URL };
const transport =
  mode === 'browser'
    ? new (await import('./browser.js')).BrowserTransport(options)
    : new HttpTransport(options);
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
