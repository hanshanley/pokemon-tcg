import { chromium } from 'playwright';
import { normalizeSale, productIdFromUrl } from './store.js';

export async function productDetails(url) {
  const id = productIdFromUrl(url);
  const response = await fetch(`https://mp-search-api.tcgplayer.com/v2/product/${id}/details`, {
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Product lookup returned HTTP ${response.status}.`);
  const data = await response.json();
  if (Number(data.productId) !== id || ![3, 85].includes(Number(data.productLineId))) {
    throw new Error('Only verified Pokemon products can be tracked.');
  }
  return {
    id, url: `https://www.tcgplayer.com/product/${id}`,
    name: data.productName,
    kind: data.sealed ? 'sealed' : 'single',
    set: data.setName,
  };
}

export function salesPage(payload) {
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error('Unexpected sales response; no transactions were inferred.');
  }
  // Keep transaction fields only, never customer, seller, or account details.
  const sales = payload.data.map(row => {
    const sale = normalizeSale(row);
    return {
      orderDate: sale.sold_at, quantity: sale.quantity,
      purchasePrice: sale.unit_price_cents / 100, shippingPrice: sale.shipping_cents / 100,
      condition: sale.condition, variant: sale.variant, language: sale.language,
      listingType: sale.listing_type,
    };
  });
  return { sales, hasMore: Boolean(payload.nextPage) };
}

export function combinePages(pages) {
  return [...pages.entries()].sort(([a], [b]) => a - b).flatMap(([, page]) => page.sales);
}

export async function collectProduct(browser, product, { maxPages = 20, timeout = 45000 } = {}) {
  const startedAt = new Date().toISOString();
  const page = await browser.newPage();
  const pages = new Map();
  const pending = new Set();
  const errors = new Set();
  let filterScope = 'website default filters';
  const matches = value => {
    const url = new URL(value);
    return url.hostname === 'mpapi.tcgplayer.com' &&
      url.pathname === `/v2/product/${product.id}/latestsales`;
  };
  page.on('requestfailed', request => {
    if (matches(request.url())) errors.add(`Sales request failed: ${request.failure()?.errorText}.`);
  });
  page.on('response', response => {
    if (!matches(response.url())) return;
    const task = (async () => {
      if (!response.ok()) {
        errors.add(`Sales endpoint returned HTTP ${response.status()}.`);
        return;
      }
      try {
        const request = response.request();
        const url = new URL(request.url());
        let params = {};
        try { params = request.postDataJSON() ?? {}; } catch { /* GET request */ }
        const offset = Number(params.offset ?? url.searchParams.get('offset') ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid sales page offset.');
        const parsed = salesPage(await response.json());
        const current = pages.get(offset);
        // Opening the modal replaces its five-row preview with a full first page.
        if (!current || parsed.sales.length >= current.sales.length) pages.set(offset, parsed);
      } catch (error) {
        errors.add(error.message);
      }
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
  });
  try {
    await page.goto(`${product.url}?view=sales-history`, {
      waitUntil: 'domcontentloaded', timeout,
    });
    const modal = page.locator('.sales-history-snapshot');
    await modal.waitFor({ state: 'visible', timeout }).catch(async () => {
      const button = page.getByRole('button', { name: 'View More Data', exact: true });
      if (await button.count()) {
        await button.first().click({ timeout: 5000 });
        await modal.waitFor({ state: 'visible', timeout: 10000 });
      }
    });
    const clear = modal.getByRole('button', { name: 'Clear Filters', exact: true });
    if (await clear.count() && await clear.first().isEnabled()) {
      await Promise.all([...pending]);
      pages.clear();
      await clear.first().click();
      filterScope = 'cleared website filters';
    }
    await page.waitForFunction(() => {
      const table = document.querySelector('.sales-history-snapshot .latest-sales-table');
      const text = document.querySelector('.sales-history-snapshot')?.textContent ?? '';
      return (table?.querySelectorAll('tbody tr').length ?? 0) > 0 ||
        /No sales data available|error occurred/i.test(text);
    }, null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await Promise.all([...pending]);
    for (let i = 1; i < maxPages; i++) {
      const more = modal.getByRole('button', { name: 'Load More Sales', exact: true });
      if (!await more.count() || !await more.first().isVisible() ||
          !await more.first().isEnabled()) break;
      const before = pages.size;
      const response = page.waitForResponse(r => matches(r.url()), { timeout: 15000 });
      await more.first().click();
      await response;
      await Promise.all([...pending]);
      if (pages.size === before) {
        errors.add('Pagination did not advance; stopped collection.');
        break;
      }
      await page.waitForTimeout(1000);
    }
    if (await modal.getByRole('button', { name: /Sign In to View More Sales/i }).count()) {
      errors.add('The site requires sign-in for additional history.');
    }
    if ([...pages.values()].at(-1)?.hasMore) errors.add('More history remains beyond collected pages.');
  } catch (error) {
    errors.add(`Browser collection stopped: ${error.message.split('\n')[0]}`);
  } finally {
    await Promise.all([...pending]);
    await page.close();
  }
  if (!pages.size) errors.add('No sales response received. This is unavailable data, not zero sales.');
  const sales = combinePages(pages);
  return {
    startedAt, sales, pages: pages.size,
    status: !pages.size ? 'failed' : errors.size ? 'partial' : 'observed',
    warning: [
      ...errors,
      `Scope: ${filterScope}. Only browser-visible history is observed; completeness is unverified.`,
      'No stable sale ID is exposed; identical records are deduplicated by content and multiplicity.',
    ].join(' '),
  };
}

export async function collectAll(store, options = {}) {
  const products = store.products();
  if (!products.length) return [];
  const browser = await chromium.launch({
    headless: process.env.HEADLESS === '1',
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
  });
  try {
    const results = [];
    for (const product of products) {
      const result = await collectProduct(browser, product, options);
      results.push({ ...store.record(product, result), status: result.status });
    }
    return results;
  } finally {
    await browser.close();
  }
}
