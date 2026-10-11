import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { BASE, assertPage } from './parser.js';

export const DEFAULT_LIVE_BASE = 'https://new-ui.realoem.com/bmw/enUS/';
export const DEFAULT_TRANSPORT = 'http';

export type PageResult = {
  html: string;
  sourceUrl: string;
  retrievedAt: string;
  source: 'live' | 'har';
};
export interface Transport {
  get(endpoint: string, params: Record<string, string | undefined>): Promise<PageResult>;
  close(): Promise<void>;
}
const endpoints = new Set(['select', 'partgrp', 'showparts', 'partsearch']);
function urlFor(endpoint: string, params: Record<string, string | undefined>, base = BASE) {
  if (!endpoints.has(endpoint)) throw new Error('Unsupported RealOEM endpoint');
  const url = new URL(endpoint, base);
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) url.searchParams.set(key, value);
  return url;
}
function key(url: URL) {
  const pairs = [...url.searchParams]
    .filter(([k]) => k !== 'ui' && (url.pathname.endsWith('/select') || k !== 'vin'))
    .sort(([a], [b]) => a.localeCompare(b));
  return url.pathname + '?' + new URLSearchParams(pairs).toString();
}
export async function harTransport(path: string): Promise<Transport> {
  const har = JSON.parse(await readFile(path, 'utf8'));
  const pages = new Map<string, { html: string; time: string }>();
  for (const e of har.log.entries) {
    const content = e.response.content;
    if (e.response.status !== 200 || !content.text || !content.mimeType?.includes('text/html'))
      continue;
    const url = new URL(e.request.url);
    if (url.origin !== new URL(BASE).origin) continue;
    pages.set(key(url), {
      html:
        content.encoding === 'base64'
          ? Buffer.from(content.text, 'base64').toString('utf8')
          : content.text,
      time: e.startedDateTime,
    });
  }
  return {
    async get(endpoint, params) {
      const url = urlFor(endpoint, params),
        page = pages.get(key(url));
      if (!page)
        throw new Error(
          `No captured page for ${endpoint} with these parameters. HAR mode cannot query uncaptured vehicles or parts.`,
        );
      assertPage(page.html);
      return { html: page.html, sourceUrl: url.href, retrievedAt: page.time, source: 'har' };
    },
    async close() {},
  };
}
export class LiveTransport implements Transport {
  private base: string;
  private browser?: Browser;
  private context?: BrowserContext;
  private cache = new Map<string, { result: PageResult; expires: number }>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequest = 0;
  constructor(private mode: 'browser' | 'http' = DEFAULT_TRANSPORT) {
    this.base = process.env.REALOEM_BASE_URL || DEFAULT_LIVE_BASE;
    const base = new URL(this.base);
    if (
      !['https://www.realoem.com', 'https://new-ui.realoem.com'].includes(base.origin) ||
      base.pathname !== '/bmw/enUS/' ||
      base.search ||
      base.hash ||
      base.username ||
      base.password
    )
      throw new Error(
        'REALOEM_BASE_URL must be https://www.realoem.com/bmw/enUS/ or https://new-ui.realoem.com/bmw/enUS/',
      );
  }
  get(endpoint: string, params: Record<string, string | undefined>): Promise<PageResult> {
    const url = urlFor(endpoint, params, this.base);
    // The parsers use the classic HTML layout, available on both official hosts.
    url.searchParams.set('ui', 'v1');
    const task = this.queue.then(() => this.request(url));
    this.queue = task.catch(() => {});
    return task;
  }
  private async request(url: URL): Promise<PageResult> {
    const cached = this.cache.get(url.href);
    if (cached && cached.expires > Date.now()) return cached.result;
    for (let attempt = 0; attempt < 3; attempt++) {
      const delay = Math.max(0, 1000 - (Date.now() - this.lastRequest));
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      this.lastRequest = Date.now();
      let html: string, status: number;
      if (this.mode === 'http') {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(30_000),
          redirect: 'error',
          headers: { 'User-Agent': 'RealOEMMCP/0.1', Accept: 'text/html' },
        });
        status = response.status;
        html = await response.text();
      } else {
        if (!this.context) {
          this.browser = process.env.REALOEM_CDP_URL
            ? await chromium.connectOverCDP(process.env.REALOEM_CDP_URL)
            : await chromium.launch({
                headless: process.env.REALOEM_HEADLESS !== 'false',
                executablePath: process.env.REALOEM_BROWSER_EXECUTABLE || undefined,
              });
          this.context = process.env.REALOEM_CDP_URL
            ? this.browser.contexts()[0]
            : await this.browser.newContext();
          if (!this.context) throw new Error('The CDP browser has no context');
        }
        const page = await this.context.newPage();
        try {
          const response = await page.goto(url.href, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          });
          status = response?.status() || 0;
          // Allow a person using a headed browser to complete a site challenge.
          if (
            status === 403 &&
            (process.env.REALOEM_HEADLESS === 'false' || process.env.REALOEM_CDP_URL)
          ) {
            await page.waitForSelector('#main', { timeout: 60_000 }).catch(() => {});
            if (await page.locator('#main').count()) status = 200;
          }
          html = await page.content();
        } finally {
          await page.close();
        }
      }
      if ([429, 502, 503, 504].includes(status) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
        continue;
      }
      if (status !== 200) {
        const guidance =
          url.origin !== new URL(DEFAULT_LIVE_BASE).origin || this.mode !== DEFAULT_TRANSPORT
            ? `Use the verified defaults: REALOEM_TRANSPORT=${DEFAULT_TRANSPORT} and REALOEM_BASE_URL=${DEFAULT_LIVE_BASE}.`
            : 'The verified default host is blocked on this request. Retry later, or use REALOEM_TRANSPORT=browser with REALOEM_HEADLESS=false on a machine with a desktop, or REALOEM_CDP_URL for an existing local browser session.';
        throw new Error(
          `RealOEM returned HTTP ${status} from ${url.origin} using ${this.mode}. ${status === 403 ? guidance : 'Retry later.'}`,
        );
      }
      assertPage(html);
      const result: PageResult = {
        html,
        sourceUrl: url.href,
        retrievedAt: new Date().toISOString(),
        source: 'live',
      };
      this.cache.set(url.href, { result, expires: Date.now() + 15 * 60_000 });
      if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
      return result;
    }
    throw new Error('RealOEM is unavailable after three attempts');
  }
  async close() {
    await this.queue;
    await this.browser?.close();
  }
}
