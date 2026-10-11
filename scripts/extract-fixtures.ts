import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { load } from 'cheerio';
const har = JSON.parse(await readFile(process.argv[2] || 'www.realoem.com.har', 'utf8'));
await mkdir('test/fixtures', { recursive: true });
for (const entry of har.log.entries) {
  const url = new URL(entry.request.url);
  if (
    entry.response.status !== 200 ||
    !entry.response.content.text ||
    !entry.response.content.mimeType?.includes('text/html') ||
    url.origin !== 'https://www.realoem.com'
  )
    continue;
  const endpoint = url.pathname.split('/').pop();
  if (!['select', 'partgrp', 'showparts', 'partsearch'].includes(endpoint!)) continue;
  const $ = load(entry.response.content.text);
  $('script, style, .ro-acct-nav, .splinks, footer, .gad-tall-left, .gad-tall-right').remove();
  const name =
    endpoint +
    '-' +
    (url.searchParams.get('diagId') || url.searchParams.get('mg') || 'root') +
    '.html';
  await writeFile(
    'test/fixtures/' + name,
    '<!doctype html><title>' +
      $('title').text() +
      '</title><div id="main">' +
      $('#main').html() +
      '</div>',
  );
}
