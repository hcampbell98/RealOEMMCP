import { assertPage } from './parser.js';

export const DEFAULT_LIVE_BASE = 'https://new-ui.realoem.com/bmw/enUS/';
export const DEFAULT_TRANSPORT = 'http';

export type PageResult = {
  html: string;
  sourceUrl: string;
  retrievedAt: string;
  source: 'live';
};
export interface Transport {
  get(endpoint: string, params: Record<string, string | undefined>): Promise<PageResult>;
  close(): Promise<void>;
}
const endpoints = new Set(['select', 'partgrp', 'showparts', 'partsearch']);
function urlFor(endpoint: string, params: Record<string, string | undefined>, base: string) {
  if (!endpoints.has(endpoint)) throw new Error('Unsupported RealOEM endpoint');
  const url = new URL(endpoint, base);
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) url.searchParams.set(key, value);
  return url;
}
export interface TransportOptions {
  baseUrl?: string;
  lastRequest?: number;
  onRequestStart?: (time: number) => Promise<void>;
  accessGuidance?: string;
}

export abstract class CatalogTransport implements Transport {
  private base: string;
  private cache = new Map<string, { result: PageResult; expires: number }>();
  private cacheBytes = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequest: number;
  private pending = 0;

  constructor(
    private mode: 'browser' | 'http',
    private options: TransportOptions = {},
  ) {
    this.base = options.baseUrl || DEFAULT_LIVE_BASE;
    this.lastRequest = options.lastRequest || 0;
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
    if (this.pending >= 20) {
      return Promise.reject(new Error('RealOEM request queue is full. Retry later.'));
    }
    this.pending++;
    const queuedAt = Date.now();
    const task = this.queue.then(async () => {
      if (Date.now() - queuedAt > 30_000) {
        throw new Error('RealOEM request timed out in the queue. Retry later.');
      }
      return this.request(url);
    });
    this.queue = task.catch(() => {});
    return task.finally(() => {
      this.pending--;
    });
  }
  private async request(url: URL): Promise<PageResult> {
    const cached = this.cache.get(url.href);
    if (cached && cached.expires > Date.now()) return cached.result;
    if (cached) this.removeCached(url.href);
    for (let attempt = 0; attempt < 3; attempt++) {
      const delay = Math.max(0, 1000 - (Date.now() - this.lastRequest));
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      this.lastRequest = Date.now();
      await this.options.onRequestStart?.(this.lastRequest);
      const { html, status } = await this.fetchPage(url);

      if ([429, 502, 503, 504].includes(status) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
        continue;
      }
      if (status !== 200) {
        const guidance =
          url.origin !== new URL(DEFAULT_LIVE_BASE).origin || this.mode !== DEFAULT_TRANSPORT
            ? `Use the verified defaults: REALOEM_TRANSPORT=${DEFAULT_TRANSPORT} and REALOEM_BASE_URL=${DEFAULT_LIVE_BASE}.`
            : this.options.accessGuidance ||
              'The verified default host is blocked on this request. Retry later, or use REALOEM_TRANSPORT=browser with REALOEM_HEADLESS=false on a machine with a desktop, or REALOEM_CDP_URL for an existing local browser session.';
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
      this.cacheBytes += html.length * 2;
      while (this.cache.size > 100 || this.cacheBytes > 16_000_000) {
        this.removeCached(this.cache.keys().next().value!);
      }
      return result;
    }
    throw new Error('RealOEM is unavailable after three attempts');
  }
  protected abstract fetchPage(url: URL): Promise<{ html: string; status: number }>;

  private removeCached(url: string) {
    const page = this.cache.get(url);
    if (page) this.cacheBytes -= page.result.html.length * 2;
    this.cache.delete(url);
  }

  async close() {
    await this.queue;
  }
}

export class HttpTransport extends CatalogTransport {
  constructor(options: TransportOptions = {}) {
    super('http', options);
  }

  protected async fetchPage(url: URL) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      redirect: 'manual',
      headers: { 'User-Agent': 'RealOEMMCP/0.1', Accept: 'text/html' },
    });
    // Workers does not support redirect: 'error'. Reject redirects explicitly.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('RealOEM returned a redirect. Redirects are not followed.');
    }
    return { status: response.status, html: await readHtml(response) };
  }
}

async function readHtml(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let bytes = 0;
  let html = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2_000_000) throw new Error('RealOEM HTML exceeded the 2 MB response limit.');
      html += decoder.decode(value, { stream: true });
    }
    return html + decoder.decode();
  } finally {
    await reader.cancel();
  }
}
