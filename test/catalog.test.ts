import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseSelection,
  parseGroups,
  parseDiagrams,
  parseDiagram,
  parsePartSearch,
  assertPage,
} from '../src/parser.js';
const fixture = (name: string) =>
  readFile(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
test('VIN resolves the exact captured catalog attributes', async () => {
  const p = parseSelection(await fixture('select-root'));
  assert.equal(p.vehicles.length, 1);
  assert.equal(p.vehicles[0].vehicleId, 'UM92-EUR-01-2011-E88-BMW-118d');
  assert.equal(p.vehicles[0].attributes.engine.value, 'N47');
  assert.equal(p.vehicles[0].attributes.steering.value, 'R');
  assert.equal(p.vehicles[0].attributes.prod.value, '20110100');
  assert.equal(p.catalogVersion, '03/2025');
});
test('groups and diagrams retain IDs and titles without duplicate thumbnail links', async () => {
  const groups = parseGroups(await fixture('partgrp-root'));
  assert.equal(groups.length, 39);
  assert.ok(groups.find((g) => g.id === '26')?.title.includes('DRIVE SHAFT'));
  const diagrams = parseDiagrams(await fixture('partgrp-18'));
  assert.equal(diagrams.length, 5);
  assert.ok(
    diagrams
      .find((d) => d.id === '18_0731')
      ?.title.toLowerCase()
      .includes('particulate'),
  );
});
test('automatic transmission condition stays between the two alternative part rows', async () => {
  const p = parseDiagram(await fixture('showparts-26_0216'));
  assert.equal(p.parts.length, 2);
  assert.equal(p.parts[0].partNumber, '26107567953');
  assert.equal(p.parts[1].partNumber, '26117526136');
  assert.equal(p.rows[1].kind, 'note');
  assert.match(p.rows[1].kind === 'note' ? p.rows[1].text : '', /S205A=Yes/);
  assert.equal(p.parts[1].depth, 3);
  assert.equal(p.fitmentStatus, 'requires_confirmation');
});
test('DPF companions, repetitions, emissions, ended notes and X references survive', async () => {
  const p = parseDiagram(await fixture('showparts-18_0731'));
  assert.equal(
    p.parts.filter((r) => r.partNumber === '18307812283' && r.quantity !== 'X').length,
    2,
  );
  assert.equal(p.parts[0].from, '09/2010');
  assert.ok(p.parts.some((r) => r.partNumber === '18308513651' && r.position === '--'));
  assert.ok(p.rows.some((r) => r.kind === 'note' && r.text.includes('only in conjunction with')));
  assert.ok(p.rows.some((r) => r.kind === 'note' && r.text.includes('S169A=Yes')));
  assert.ok(p.rows.some((r) => r.kind === 'note' && r.text.includes('only applies to')));
  assert.ok(p.parts.some((r) => r.quantity === 'X'));
  assert.ok(p.parts.some((r) => r.notes.includes('ENDED')));
  assert.match(p.imageUrl || '', /diag_7nf4.jpg$/);
});
test('valid empty diagram is returned without inventing parts', async () => {
  assert.equal(parseDiagram(await fixture('showparts-18_0721')).parts.length, 0);
});
test('part details and supersession preserve replacement direction and notes', async () => {
  const p = parsePartSearch(await fixture('partsearch-18_0731'));
  assert.equal(p.partNumber, '18307812283');
  assert.equal(p.details.Weight, '5.750 kg');
  assert.match(p.supersessions[0].text, /Exchangeable retrospectively/);
  assert.equal(p.diagrams.length, 3);
  assert.equal(p.diagrams[0].partNumber, '18307812283');
});
test('challenge pages fail instead of giving empty catalog data', () => {
  assert.throws(() => assertPage('<title>Just a moment...</title>'), /unavailable/);
  assert.throws(() => parseDiagram('<div id="main">Not found</div>'), /expected parts table/);
});
test('live January 2011 E88 rear bearing diagram identifies bearing and dated nut', async () => {
  const p = parseDiagram(await fixture('showparts-33_1231'));
  assert.equal(p.vehicle, '1 Series E88 118d (2011)');
  const bearing = p.parts.find((r) => r.position === '02');
  assert.equal(bearing?.partNumber, '33416762317');
  assert.equal(bearing?.supplement, '42X75X37');
  assert.equal(bearing?.quantity, '2');
  const nut = p.parts.find((r) => r.position === '04');
  assert.equal(nut?.partNumber, '33406799223');
  assert.equal(nut?.from, '10/2010');
});
test('ABS ring with letters in its part number is returned as a part', async () => {
  const p = parseDiagram(await fixture('showparts-33_3013'));
  const ring = p.parts.find((r) => r.position === '01');
  assert.equal(ring?.partNumber, '33215A1A7D9');
  assert.equal(ring?.description, 'ABS sensor ring');
  assert.equal(ring?.quantity, '2');
  assert.ok(p.rows.some((r) => r.kind === 'note' && r.text === 'See repair manual'));
});
