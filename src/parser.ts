import { load, type CheerioAPI } from 'cheerio';

export const BASE = 'https://www.realoem.com/bmw/enUS/';
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
function document(html: string) {
  const $ = load(html);
  $('script, style').remove();
  $('br').replaceWith('\n');
  return $;
}
export function assertPage(html: string) {
  const $ = document(html);
  if (
    !$('#main').length ||
    /just a moment|access denied|verify you are human/i.test($('title').text())
  )
    throw new Error(
      'RealOEM returned an unavailable or unrecognised page. No catalog results were inferred.',
    );
}
function links($: CheerioAPI, endpoint: string, parameter: string) {
  const found = new Map<
    string,
    { id: string; title: string; sourceUrl: string; imageUrl?: string; partNumber?: string }
  >();
  $('#main a[href]').each((_, el) => {
    const a = $(el),
      url = new URL(a.attr('href')!, BASE);
    if (a.closest('.toplinks').length) return;
    if (url.origin !== new URL(BASE).origin || url.pathname !== `/bmw/enUS/${endpoint}`) return;
    const id = url.searchParams.get(parameter);
    if (!id) return;
    const title = clean(a.text()) || a.find('img').attr('alt') || '';
    const src = a.find('img').attr('src');
    const key = id + url.hash;
    const prior = found.get(key);
    found.set(key, {
      id,
      title: title || prior?.title || '',
      sourceUrl: url.href,
      imageUrl: src ? new URL(src, BASE).href : prior?.imageUrl,
      partNumber: /^#\d[A-Z0-9]{10}$/.test(url.hash) ? url.hash.slice(1) : undefined,
    });
  });
  return [...found.values()];
}
export function parseSelection(html: string) {
  const $ = document(html);
  const choices: Record<string, { value: string; label: string; selected: boolean }[]> = {};
  $('#selectForm select').each((_, el) => {
    const name = $(el).attr('name');
    if (!name) return;
    choices[name] = $(el)
      .find('option')
      .toArray()
      .map((o) => ({
        value: $(o).attr('value') || '',
        label: clean($(o).text()),
        selected: $(o).is('[selected]'),
      }));
  });
  const vehicles = $('#selectResults form')
    .toArray()
    .flatMap((el) => {
      const id = $(el).find('input[name=id]').attr('value');
      if (!id) return [];
      const attributes = Object.fromEntries(
        Object.entries(choices).flatMap(([key, opts]) => {
          const selected = opts.find((o) => o.selected);
          return selected ? [[key, { value: selected.value, label: selected.label }]] : [];
        }),
      );
      return [
        {
          vehicleId: id,
          description: clean($(el).closest('.searchResults').find('.column').first().text()),
          attributes,
          sourceUrl: new URL(`partgrp?id=${encodeURIComponent(id)}`, BASE).href,
        },
      ];
    });
  return {
    vehicles,
    choices,
    catalogVersion: clean($('#selectEtkVer').text()).replace(/^Catalog:\s*/, ''),
    message: clean($('#selectResults').text()),
    fitmentNotice:
      'VIN lookup selects a catalog vehicle. It does not establish the installed option codes or resolve every part alternative.',
  };
}
export function parseGroups(html: string) {
  return links(document(html), 'partgrp', 'mg');
}
export function parseDiagrams(html: string) {
  return links(document(html), 'showparts', 'diagId');
}
type RowBase = { rowIndex: number; positionGroup: string | null; depth: number; cells: string[] };
export type PartRow = RowBase & {
  kind: 'part';
  position: string;
  description: string;
  supplement: string;
  quantity: string;
  from: string;
  upTo: string;
  partNumber: string;
  price: string;
  notes: string;
};
export type DiagramRow = PartRow | (RowBase & { kind: 'note'; text: string });
export function parseDiagram(html: string) {
  const $ = document(html),
    table = $('#partsList');
  if (!table.length) throw new Error('RealOEM did not return the expected parts table.');
  const rows = table
    .find('tr')
    .toArray()
    .flatMap<DiagramRow>((el, index) => {
      const cells = $(el).children('td');
      if (!cells.length) return [];
      const values = cells.toArray().map((c) => clean($(c).text()));
      const positionGroup = ($(el).attr('class') || '').match(/\bpos(\w+)/)?.[1] || null;
      const depth = Number((cells.eq(1).attr('class') || '').match(/\bedge(\d+)/)?.[1] || 0);
      const isPart = cells.length >= 10 && /^\d[A-Z0-9]{10}$/.test(values[6]);
      const common = { rowIndex: index, positionGroup, depth };
      if (!isPart)
        return [{ ...common, kind: 'note' as const, text: clean(values.join(' ')), cells: values }];
      return [
        {
          ...common,
          kind: 'part' as const,
          position: values[0],
          description: values[1],
          supplement: values[2],
          quantity: values[3],
          from: values[4],
          upTo: values[5],
          partNumber: values[6],
          price: values[7],
          notes: clean([values[8], values[9]].join(' ')),
          cells: values.slice(0, 10),
        },
      ];
    });
  // Preserve ordered note rows and indentation. Their scopes and AND/OR grammar vary;
  // do not convert a missing condition into an unconditional fitment claim.
  const img = $('#main img[src*="/diag_"]').first().attr('src');
  const heading = clean($('#main h1').first().text());
  return {
    title: heading || clean($('#main h3').first().text()) || clean($('title').text()),
    vehicle:
      heading.match(/for BMW (.+)$/)?.[1] ||
      clean($('#main h2').not(':contains("See Also")').first().text()),
    imageUrl: img ? new URL(img, BASE).href : null,
    rows,
    parts: rows.filter((r) => r.kind === 'part'),
    fitmentStatus: 'requires_confirmation',
    fitmentNotice:
      'Read the ordered rows, positionGroup and depth together. Keep alternative rows separate. Confirm production dates, transmission, equipment conditions and conjunction notes before producing a purchase list. This is a catalog diagram, not a repair bill of materials.',
  };
}
export function parsePartSearch(html: string) {
  const $ = document(html),
    content = $('#main .content').first();
  const details: Record<string, string> = {};
  content
    .children('dl')
    .find('dt')
    .each((_, el) => {
      details[clean($(el).text()).replace(/:$/, '')] = clean($(el).next('dd').text());
    });
  const supersessions = content
    .find('.supersedes, .superseded')
    .toArray()
    .map((el) => ({
      heading: clean($(el).find('h3').text()),
      text: clean($(el).text()),
      links: $(el)
        .find('a[href]')
        .toArray()
        .map((a) => ({
          text: clean($(a).text()),
          sourceUrl: new URL($(a).attr('href')!, BASE).href,
        })),
    }));
  return {
    partNumber: clean(content.children('h1').first().text()),
    description: clean(content.children('h2').first().text()),
    details,
    supersessions,
    diagrams: parseDiagrams(html),
    text: clean(content.text()),
    fitmentNotice:
      'Search matches and supersessions require checking the diagram conditions and replacement notes.',
  };
}
