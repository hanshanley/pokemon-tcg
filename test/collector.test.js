import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { collectProduct, salesPage } from '../src/collector.js';

const sale = (date, quantity = 1) => ({
  orderDate: `2026-10-31T${date}:00Z`, quantity, purchasePrice: 12.5,
  condition: 'Near Mint', variant: 'Holofoil', language: 'English',
});

test('sales adapter rejects prices and buckets masquerading as transactions', () => {
  assert.throws(() => salesPage({ data: { marketPrice: 100 } }));
  assert.throws(() => salesPage({ data: [{ bucketStartDate: '2026-10-31', quantitySold: 12 }] }));
  const parsed = salesPage({ data: [sale('01:00')], nextPage: '' });
  assert.equal(parsed.hasMore, false);
  assert.equal(parsed.sales[0].quantity, 1);
  assert.equal(parsed.sales[0].purchasePrice, 12.5);
});

async function browserFixture(t, { denied = false } = {}) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const requests = [];
  const context = await browser.newContext();
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'mpapi.tcgplayer.com') {
      requests.push(url.href);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return route.fulfill({
        status: denied ? 403 : 200, contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(denied ? { error: 'Forbidden' } : {
          data: url.searchParams.get('limit') === '1' ? [sale('01:00')]
            : offset === 0 ? [sale('01:00'), sale('02:00', 3)] : [sale('03:00')],
          nextPage: offset === 0 ? 'more' : '',
        }),
      });
    }
    if (url.hostname === 'www.tcgplayer.com') return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body>
        <section class="sales-history-snapshot">
          <table class="latest-sales-table"><tbody></tbody></table>
          <button>Load More Sales</button>
          <p id="error"></p>
        </section>
        <script>
          let offset = 0;
          const more = document.querySelector('button');
          async function load() {
            const response = await fetch('https://mpapi.tcgplayer.com/v2/product/42382/latestsales?offset=' + offset);
            if (!response.ok) {
              document.querySelector('#error').textContent = 'An error occurred while fetching sales';
              more.remove(); return;
            }
            const data = await response.json();
            for (const row of data.data) {
              const tr = document.createElement('tr');
              const td = document.createElement('td');
              td.textContent = row.orderDate;
              tr.append(td);
              document.querySelector('tbody').append(tr);
            }
            offset += data.data.length;
            if (!data.nextPage) more.remove();
          }
          more.addEventListener('click', load);
          async function start() {
            await fetch('https://mpapi.tcgplayer.com/v2/product/42382/latestsales?limit=1');
            await load();
          }
          start();
        </script>
      </body></html>`,
    });
    await route.abort();
  });
  return { browser: { newPage: () => context.newPage() }, requests };
}

test('collector reads normal browser responses and loads additional sales pages', async t => {
  const fixture = await browserFixture(t);
  const result = await collectProduct(fixture.browser, {
    id: 42382, url: 'https://www.tcgplayer.com/product/42382',
  }, { timeout: 5000 });
  assert.equal(result.status, 'observed', result.warning);
  assert.equal(result.pages, 2);
  assert.equal(result.sales.length, 3);
  assert.equal(result.sales.reduce((sum, row) => sum + row.quantity, 0), 5);
  assert.equal(fixture.requests.length, 3);
  assert.match(result.warning, /completeness is unverified/);
});

test('denied browser responses record failure and do not silently return a zero-sales success', async t => {
  const fixture = await browserFixture(t, { denied: true });
  const result = await collectProduct(fixture.browser, {
    id: 42382, url: 'https://www.tcgplayer.com/product/42382',
  }, { timeout: 5000 });
  assert.equal(result.status, 'failed');
  assert.equal(result.sales.length, 0);
  assert.match(result.warning, /HTTP 403/);
  assert.match(result.warning, /unavailable data, not zero sales/);
});
