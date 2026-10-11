import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Transport, PageResult } from './transport.js';
import {
  parseSelection,
  parseGroups,
  parseDiagrams,
  parseDiagram,
  parsePartSearch,
} from './parser.js';

const vehicleId = z
  .string()
  .min(5)
  .max(160)
  .regex(/^[A-Za-z0-9_.-]+$/)
  .describe(
    'Exact vehicleId returned by identify_vehicle or select_vehicle. Never construct it from a model name.',
  );
const diagramId = z.string().regex(/^\d{2}_\d{4}$/);
const groupId = z.string().regex(/^\d{2}$/);
export function createServer(transport: Transport) {
  const server = new McpServer(
    { name: 'realoem-mcp', version: '0.1.0' },
    {
      instructions:
        'Live access defaults to HTTP on https://new-ui.realoem.com/bmw/enUS/ with the classic layout ui=v1. This configuration was verified with live catalog requests; www.realoem.com returned access challenges in the same environment. Local environment overrides can change the transport and host. Workers uses the default HTTP host. Follow configuration guidance in access errors; do not infer catalog results from blocked requests. Use get_diagram_image to view an exploded diagram and get_diagram_parts to read its ordered conditions. Identify the vehicle first. Use the returned vehicleId for every subsequent call. Read diagram rows in order, including option conditions, production limits, conjunctions, reference rows and ENDED notes. VIN does not prove equipment. Ask for missing transmission/option details; never claim exact fitment based solely on search matches. Quantity X is a reference. A diagram is not a complete repair procedure or purchase list. Cite sourceUrl.',
    },
  );
  async function result<T extends object>(page: Promise<PageResult>, parse: (html: string) => T) {
    try {
      const { html, ...meta } = await page;
      const data = { ...parse(html), ...meta };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
        structuredContent: data,
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
  server.registerTool(
    'identify_vehicle',
    {
      description:
        'Resolve a full VIN or last seven characters into catalog vehicle candidates, engine, steering, market and production month. Preserve ambiguity.',
      inputSchema: {
        vin: z
          .string()
          .trim()
          .toUpperCase()
          .refine(
            (v) => /^(?:[A-HJ-NPR-Z0-9]{7}|[A-HJ-NPR-Z0-9]{17})$/.test(v),
            'Provide a 17-character VIN or its last 7 characters',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    ({ vin }) => result(transport.get('select', { vin: vin.slice(-7) }), parseSelection),
  );
  server.registerTool(
    'select_vehicle',
    {
      description:
        'Browse manual vehicle selection. Call repeatedly with returned choice values; only use vehicle candidates once the precise production month, engine and steering are selected.',
      inputSchema: {
        product: z.enum(['P', 'M']).optional(),
        archive: z.enum(['0', '1']).optional(),
        series: z.string().max(30).optional(),
        body: z.string().max(30).optional(),
        model: z.string().max(40).optional(),
        market: z.string().max(10).optional(),
        prod: z
          .string()
          .regex(/^\d{4}(0[1-9]|1[0-2])00$/)
          .optional(),
        engine: z.string().max(30).optional(),
        steering: z.enum(['L', 'R']).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (params) => result(transport.get('select', params), parseSelection),
  );
  server.registerTool(
    'list_part_groups',
    {
      description:
        'List the major catalog groups for a resolved vehicle, such as brakes or exhaust.',
      inputSchema: { vehicleId },
      annotations: { readOnlyHint: true },
    },
    ({ vehicleId }) =>
      result(transport.get('partgrp', { id: vehicleId }), (html) => ({
        vehicleId,
        groups: parseGroups(html),
      })),
  );
  server.registerTool(
    'list_diagrams',
    {
      description:
        'List diagrams in one major group. Optional query filters diagram titles, not part descriptions.',
      inputSchema: { vehicleId, groupId, query: z.string().max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    ({ vehicleId, groupId, query }) =>
      result(transport.get('partgrp', { id: vehicleId, mg: groupId }), (html) => ({
        vehicleId,
        groupId,
        diagrams: parseDiagrams(html).filter(
          (d) => !query || d.title.toLowerCase().includes(query.toLowerCase()),
        ),
      })),
  );
  server.registerTool(
    'get_diagram_parts',
    {
      description:
        'Retrieve exploded diagram image URL and all ordered parts/condition rows. Includes quantities, production limits, companion parts and reference rows. Does not certify fitment.',
      inputSchema: { vehicleId, diagramId },
      annotations: { readOnlyHint: true },
    },
    ({ vehicleId, diagramId }) =>
      result(transport.get('showparts', { id: vehicleId, diagId: diagramId }), (html) => ({
        vehicleId,
        diagramId,
        ...parseDiagram(html),
      })),
  );
  server.registerTool(
    'get_diagram_image',
    {
      description:
        'Retrieve the exploded diagram itself as an inline MCP image. Resolve the image from the vehicle diagram page; use get_diagram_parts for position numbers, part rows and fitment conditions.',
      inputSchema: { vehicleId, diagramId },
      annotations: { readOnlyHint: true },
    },
    async ({ vehicleId, diagramId }) => {
      try {
        const page = await transport.get('showparts', { id: vehicleId, diagId: diagramId });
        const diagram = parseDiagram(page.html);
        if (!diagram.imageUrl) throw new Error('This RealOEM diagram has no image');
        const { data, mimeType, ...image } = await transport.getImage(diagram.imageUrl);
        const metadata = {
          vehicleId,
          diagramId,
          title: diagram.title,
          imageUrl: image.sourceUrl,
          sourceUrl: page.sourceUrl,
          retrievedAt: image.retrievedAt,
          source: image.source,
        };
        return {
          content: [
            { type: 'image' as const, data, mimeType },
            { type: 'text' as const, text: JSON.stringify(metadata) },
          ],
          structuredContent: metadata,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
        };
      }
    },
  );
  server.registerTool(
    'search_parts',
    {
      description:
        'Search within the vehicle catalog by an 11-character BMW part number, including numbers containing letters. Return matching diagrams and available replacement history. Use list_diagrams query for descriptive searches. Inspect the diagrams before recommending parts.',
      inputSchema: {
        vehicleId,
        query: z
          .string()
          .trim()
          .transform((v) => v.replace(/\s/g, '').toUpperCase())
          .pipe(
            z
              .string()
              .regex(
                /^\d[A-Z0-9]{10}$/,
                'Provide an 11-character BMW part number, starting with a digit',
              ),
          ),
        diagramId: diagramId.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ vehicleId, query, diagramId }) =>
      result(
        transport.get('partsearch', { id: vehicleId, q: query, diagId: diagramId }),
        (html) => ({ vehicleId, query, ...parsePartSearch(html) }),
      ),
  );
  return server;
}
