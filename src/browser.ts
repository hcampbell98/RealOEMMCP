import { chromium, type Browser, type BrowserContext } from 'playwright';
import { CatalogTransport, type TransportOptions } from './transport.js';

export class BrowserTransport extends CatalogTransport {
  private browser?: Browser;
  private context?: BrowserContext;

  constructor(options: TransportOptions = {}) {
    super('browser', options);
  }

  protected async fetchPage(url: URL): Promise<{ html: string; status: number }> {
    let html: string;
    let status: number;
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
    return { html, status };
  }

  async close() {
    await super.close();
    await this.browser?.close();
  }
}
