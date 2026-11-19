import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { makeServer, scheduleDaily } from '../src/server.js';
import { saveMonthHistory } from '../src/volume.js';
import { chromium } from 'playwright';

async function setup(t, extra = {}) {
  const store = new Store(':memory:');
  const app = makeServer(store, {
    lookup: async url => ({ url, id: 42382, name: 'Charizard', kind: 'single' }), ...extra,
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    await app.waitForCollection();
    await new Promise(resolve => app.server.close(resolve));
    store.close();
  });
  return { store, app, base: `http://127.0.0.1:${app.server.address().port}` };
}
const post = (base, path, data, extra = {}) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(data),
});

function lookupFixture(store) {
  const insert = store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,?,?,?,'Rare','Psychic','100',?,'','build',1)`);
  const products = [
    [101, 'Base Set', 'Mew', '10/102', ['Mew'], [2, 1], [20, 1]],
    [102, 'Base Set', 'Mewtwo', '11/102', ['Mewtwo'], [20, 2], [5, 5]],
    [103, 'Team Up', 'Mew & Mewtwo GX', '71/236', ['Mew', 'Mewtwo'], [3, 3], [2, 1]],
    [104, 'Base Set', 'Mew Booster Box', '', [], [7, 7], [7, 7]],
    [105, 'Promo', 'Mew Promo', '001', ['Mew']],
  ];
  for (const [id, set, name, number, pokemon, latest, previous] of products) {
    insert.run(id, set, name, number, JSON.stringify(pokemon));
    if (!latest) continue;
    saveMonthHistory(store, id, { count: 1, result: [{
      skuId: id, condition: id === 104 ? 'Unopened' : 'Near Mint',
      variant: 'Normal', language: 'English',
      buckets: Array.from({ length: 30 }, (_, index) => ({
        bucketStartDate: new Date(Date.UTC(2026, 9, 31 - index)).toISOString().slice(0, 10),
        quantitySold: (index === 0 ? latest : index === 1 ? previous : [0, 0])[0],
        transactionCount: (index === 0 ? latest : index === 1 ? previous : [0, 0])[1],
        lowSalePrice: id === 103 ? '5.00' : '1.00',
        highSalePrice: id === 103 ? '5.00' : '2.00',
      })),
    }] });
  }
}

test('exact Pokemon and card lookup filter history, price bounds and complete downloads', async t => {
  const { base, store } = await setup(t);
  lookupFixture(store);
  const get = async path => (await fetch(base + path)).json();
  assert.deepEqual((await get('/api/pokemon')).pokemon, ['Mew', 'Mewtwo']);
  const catalog = await get('/api/catalog?pokemon=mEw');
  assert.deepEqual(catalog.products.map(p => p.product_id).sort(), [101, 103, 105]);
  assert.equal((await get('/api/catalog?q=Mew%20Team%20Up%2071%2F236')).products[0].product_id, 103);
  assert.equal((await get('/api/catalog?q=103')).products[0].product_id, 103);
  assert.equal((await get('/api/catalog?q=%25')).total, 0);

  const query = 'from=2026-10-31&to=2026-10-31&pokemon=mEw';
  const metrics = await get(`/api/metrics?${query}`);
  assert.equal(metrics.total.units, 5);
  assert.equal(metrics.total.sale_records, 4);
  assert.equal(metrics.daily.length, 1);
  assert.equal(metrics.daily[0].units, 5);
  assert.equal(metrics.price_volume.sales_lower_usd, 17);
  assert.equal(metrics.price_volume.sales_upper_usd, 19);
  assert.deepEqual(metrics.products.map(p => p.product_id), [103, 101]);
  assert.equal(metrics.pokemon.find(p => p.name === 'Mewtwo').units, 3);
  const output = await (await fetch(`${base}/api/export/volume.csv?${query}`)).text();
  assert.equal(output.trim().split('\r\n').length, 3);
  assert.doesNotMatch(output, /"102"|"104"/);
  const daily = await (await fetch(`${base}/api/export/daily.csv?${query}`)).text();
  assert.match(daily, /"2026-10-31","4","5"/);
  const prices = await (await fetch(`${base}/api/export/sales-value.csv?${query}`)).text();
  assert.match(prices, /"2026-10-31","5","5","0","17","19","17","19",""/);
  const catalogCsv = await (await fetch(`${base}/api/export/catalog.csv?pokemon=Mew&limit=1&offset=1`)).text();
  assert.equal(catalogCsv.trim().split('\r\n').length, 4);
  const card = await get('/api/metrics?from=2026-10-31&to=2026-10-31&product_id=103');
  assert.equal(card.total.units, 3);
  assert.equal(card.price_volume.sales_usd, 15);
  assert.deepEqual(card.pokemon.map(p => [p.name, p.units]), [['Mew', 3], ['Mewtwo', 3]]);
  assert.equal((await get('/api/metrics?pokemon=Missing')).daily.length, 0);
  const empty = await get('/api/metrics?product_id=105');
  assert.equal(empty.daily.length, 0);
  assert.equal(empty.price_volume.sales_usd, null);
});

test('historical Pokemon rankings honor dates and rank units separately from transactions', async t => {
  const { base, store } = await setup(t);
  lookupFixture(store);
  const metrics = async (date, ranking) => (await (await fetch(
    `${base}/api/metrics?from=${date}&to=${date}&ranking=${ranking}`,
  )).json());
  const previous = await metrics('2026-10-30', 'units');
  assert.equal(previous.pokemon[0].name, 'Mew');
  assert.equal(previous.pokemon[0].units, 22);
  const transactions = await metrics('2026-10-30', 'transactions');
  assert.equal(transactions.pokemon[0].name, 'Mewtwo');
  assert.equal(transactions.pokemon[0].sale_records, 6);
  const latest = await metrics('2026-10-31', 'units');
  assert.equal(latest.pokemon[0].name, 'Mewtwo');
  assert.equal(latest.pokemon[0].units, 23);
  assert.equal(latest.total.units, 32);
  assert.equal(latest.pokemon.reduce((sum, p) => sum + p.units, 0), 28);
});

test('lookup respects manual species overrides and filters individual-sale sources too', async t => {
  const { base, store } = await setup(t);
  lookupFixture(store);
  for (const [id, pokemon] of [[101, ['Pikachu']], [103, ['Mew', 'Mewtwo']]]) {
    store.addProduct({ url: `https://www.tcgplayer.com/product/${id}`,
      name: id === 101 ? 'Mew' : 'Mew & Mewtwo GX', kind: 'single', pokemon });
    store.record({ id }, { sales: [
      { orderDate: '2026-10-31T12:00:00Z', quantity: id === 101 ? 2 : 3, purchasePrice: 5 },
    ] });
  }
  const catalog = await (await fetch(`${base}/api/catalog?pokemon=Pikachu`)).json();
  assert.equal(catalog.products[0].product_id, 101);
  assert.deepEqual(catalog.products[0].pokemon, ['Pikachu']);
  assert.equal((await (await fetch(`${base}/api/metrics?pokemon=Pikachu`)).json()).total.units, 22);
  const snapshot = await (await fetch(`${base}/api/metrics?source=snapshot&pokemon=Mew`)).json();
  assert.equal(snapshot.total.units, 3);
  const output = await (await fetch(`${base}/api/export/sales.csv?source=snapshot&product_id=103`)).text();
  assert.equal(output.trim().split('\r\n').length, 2);
  assert.match(output, /"Mew \/ Mewtwo"/);
  assert.doesNotMatch(output, /"101"/);
});

test('invalid lookup IDs, species and ranking measures are rejected consistently', async t => {
  const { base } = await setup(t);
  for (const query of ['product_id=0', 'product_id=-1', 'product_id=1.5', 'product_id=1e2',
    'product_id=9007199254740992', `pokemon=${'x'.repeat(81)}`]) {
    for (const path of ['/api/metrics', '/api/catalog', '/api/export/daily.csv', '/api/export/catalog.csv']) {
      assert.equal((await fetch(`${base}${path}?${query}`)).status, 400, `${path}?${query}`);
    }
  }
  assert.equal((await fetch(`${base}/api/metrics?ranking=invalid`)).status, 400);
});

test('browser lookup drills from historical Pokemon rankings to cards and matching exports', async t => {
  const { base, store } = await setup(t);
  lookupFixture(store);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll('#pokemon-options option').length === 2);
  await page.locator('#ranking-date').fill('2026-10-30');
  await page.getByRole('button', { name: 'Show this day' }).click();
  await page.waitForFunction(() =>
    document.querySelector('#ranking-period').textContent.startsWith('2026-10-30 through 2026-10-30'));
  assert.equal(await page.locator('#pokemon-rank tbody tr').first().locator('button').textContent(), 'Mew');
  await page.selectOption('#rank-by', 'transactions');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('#pokemon-rank tbody tr button')?.textContent === 'Mewtwo');
  await page.locator('#pokemon-rank').getByRole('button', { name: 'Mewtwo', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#units').textContent === '7');
  assert.match(await page.locator('#sales-export').getAttribute('href'), /pokemon=Mewtwo/);
  await page.waitForFunction(() => document.querySelectorAll('#catalog-products tbody tr').length === 2);
  const team = page.locator('#catalog-products tbody tr').filter({ hasText: 'Mew & Mewtwo GX' });
  await team.getByRole('button', { name: 'View sales' }).click();
  await page.waitForFunction(() => document.querySelector('#units').textContent === '2');
  assert.equal(await page.locator('#product-id').inputValue(), '103');
  assert.equal(await page.locator('#pokemon').inputValue(), '');
  assert.match(await page.locator('#daily-export').getAttribute('href'), /product_id=103/);
  await page.getByRole('button', { name: 'Clear lookup' }).click();
  await page.waitForFunction(() => document.querySelector('#units').textContent === '34');
  await page.locator('#catalog-query').fill('Mew Team Up 71/236');
  await page.getByRole('button', { name: 'Search catalog' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#catalog-products tbody tr').length === 1);
  assert.match(await page.locator('#catalog-products').textContent(), /71\/236/);
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  await page.route('**/api/metrics?**', async route => {
    if (new URL(route.request().url()).searchParams.get('product_id') === '101') {
      started();
      await pending;
    }
    await route.continue();
  });
  await page.locator('#product-id').fill('101');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await requested;
  await page.locator('#product-id').fill('103');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  release();
  await page.waitForFunction(() =>
    document.querySelector('#daily-export').getAttribute('href').includes('product_id=103'),
  null, { timeout: 2000 });
  assert.equal(await page.locator('#units').textContent(), '2');
  assert.deepEqual(errors, []);
});

test('dashboard API adds products, imports records and exports every matching sale', async t => {
  const { base } = await setup(t);
  assert.equal((await post(base, '/api/products', {
    url: 'https://www.tcgplayer.com/product/42382', pokemon: ['Charizard'],
  })).status, 201);
  const sales = Array.from({ length: 125 }, (_, i) => ({
    orderDate: new Date(Date.UTC(2026, 9, 31, 0, i)).toISOString(), quantity: 2, purchasePrice: 1.25,
  }));
  const imported = await post(base, '/api/import', { product_id: 42382, sales });
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).rowsAdded, 125);
  const metrics = await (await fetch(`${base}/api/metrics?from=2026-10-31&to=2026-10-31`)).json();
  assert.equal(metrics.total.units, 250);
  assert.equal(metrics.total.sales_usd, 312.5);
  const csv = await (await fetch(`${base}/api/export/sales.csv`)).text();
  assert.equal(csv.trim().split('\r\n').length, 126);
  assert.match(csv, /quantity.*unit_price_usd.*sales_usd/);
  const daily = await (await fetch(`${base}/api/export/daily.csv`)).text();
  assert.match(daily, /"2026-10-31","125","250","312.5"/);
  const pokemonDaily = await (await fetch(`${base}/api/export/pokemon-daily.csv`)).text();
  assert.match(pokemonDaily, /"2026-10-31","charizard","Charizard","125","250","312.5","snapshot"/);
  assert.match(await (await fetch(base)).text(), /Pokemon sales monitor/);
});

test('dashboard bounds ranking rows but Pokemon daily export retains every species and date', async t => {
  const { base, store } = await setup(t);
  for (let i = 1; i <= 30; i++) {
    store.addProduct({ url: `https://www.tcgplayer.com/product/${i}`, name: `Fixture card ${i}`,
      kind: 'single', pokemon: [`Fixture species ${i}`] });
    store.record({ id: i }, { sales: [
      { orderDate: '2026-10-30T12:00:00Z', quantity: 2, purchasePrice: 1 },
      { orderDate: '2026-10-31T12:00:00Z', quantity: 3, purchasePrice: 1 },
    ] });
  }
  const metrics = await (await fetch(`${base}/api/metrics`)).json();
  assert.equal(metrics.products.length, 25);
  assert.equal(metrics.pokemon.length, 25);
  assert.equal(metrics.total.units, 150);
  const output = await (await fetch(`${base}/api/export/pokemon-daily.csv`)).text();
  assert.equal(output.trim().split('\r\n').length, 61);
  const filtered = await (await fetch(`${base}/api/export/pokemon-daily.csv?from=2026-10-31&to=2026-10-31`)).text();
  assert.equal(filtered.trim().split('\r\n').length, 31);
  assert.equal(store.pokemonDailyRows({ kind: 'sealed' }).length, 0);
});

test('cross-origin mutations, bad inputs and oversized imports are rejected', async t => {
  const { base } = await setup(t);
  assert.equal((await post(base, '/api/collect', {}, { Origin: 'https://other.test' })).status, 403);
  assert.equal((await post(base, '/api/import', { product_id: 123, sales: [] })).status, 400);
  assert.equal((await fetch(`${base}/api/metrics?kind=invalid`)).status, 400);
  assert.equal((await fetch(`${base}/api/metrics?from=2026-02-30`)).status, 400);
  assert.equal((await fetch(`${base}/api/collect`, { method: 'POST', body: '{}' })).status, 415);
  await post(base, '/api/products', {
    url: 'https://www.tcgplayer.com/product/42382', pokemon: ['Charizard'],
  });
  assert.equal((await post(base, '/api/import', {
    product_id: 42382, sales: Array.from({ length: 10001 }, () => ({})),
  })).status, 400);
});

test('concurrent collection requests share one run, exposing failures rather than fabricating sales', async t => {
  let calls = 0, release;
  const { base, app } = await setup(t, { browserSampling: true, collector: async () => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    throw new Error('Sales endpoint unavailable.');
  } });
  await post(base, '/api/collect', {});
  await post(base, '/api/collect', {});
  assert.equal(calls, 1);
  assert.equal((await (await fetch(`${base}/api/status`)).json()).running, true);
  release();
  await app.waitForCollection();
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.running, false);
  assert.equal(status.error, 'Sales endpoint unavailable.');
});

test('browser sampling is disabled by default and catalog exports are not paginated', async t => {
  let calls = 0;
  const { base, store, app } = await setup(t, { collector: async () => { calls++; return []; } });
  assert.equal((await post(base, '/api/collect', {})).status, 409);
  await app.collect();
  assert.equal(calls, 0);
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.browser_sampling_enabled, false);
  assert.equal(status.next_run, null);
  const insert = store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,'Base Set',?,'','','','','[]','','build',1)`);
  for (let i = 1; i <= 125; i++) insert.run(i, `Product ${i}`);
  const catalog = await (await fetch(`${base}/api/catalog?limit=10&offset=10`)).json();
  assert.equal(catalog.total, 125);
  assert.equal(catalog.products.length, 10);
  const output = await (await fetch(`${base}/api/export/catalog.csv?limit=10&offset=10`)).text();
  assert.equal(output.trim().split('\r\n').length, 126);
  const filtered = await (await fetch(`${base}/api/export/catalog.csv?q=Product%20125`)).text();
  assert.equal(filtered.trim().split('\r\n').length, 2);
  assert.equal((await fetch(`${base}/api/catalog?limit=0`)).status, 400);
  assert.equal((await fetch(`${base}/api/catalog?category=1`)).status, 400);
  assert.equal((await fetch(`${base}/api/catalog?q=%25`)).status, 200);
});

test('daily schedule uses the next 00:15 UTC, including the year boundary', () => {
  const app = { state: {}, collect: async () => {} };
  let stop = scheduleDaily(app, () => new Date('2026-10-31T18:53:56-04:00'));
  assert.equal(app.state.next_run, '2026-11-01T00:15:00.000Z');
  stop();
  stop = scheduleDaily(app, () => new Date('2026-12-31T23:59:00Z'));
  assert.equal(app.state.next_run, '2027-01-01T00:15:00.000Z');
  stop();
});

test('daily SKU exports stream all matching buckets and clearly distinguish dates and unavailable revenue', async t => {
  const { base, store } = await setup(t);
  const insert = store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,'Fixture set',?,'','','','',?,'','build',1)`);
  for (let id = 1; id <= 36; id++) {
    insert.run(id, `Fixture card ${id}`, JSON.stringify([`Fixture species ${id}`]));
    saveMonthHistory(store, id, { count: 1, result: [{
      skuId: id, condition: 'Near Mint', variant: 'Normal', language: 'English',
      buckets: Array.from({ length: 30 }, (_, index) => ({
        bucketStartDate: new Date(Date.UTC(2026, 9, 31 - index)).toISOString().slice(0, 10),
        quantitySold: 3, transactionCount: 2,
        lowSalePrice: '1.00', highSalePrice: '2.00',
      })),
    }] });
  }
  const metrics = await (await fetch(`${base}/api/metrics`)).json();
  assert.equal(metrics.products.length, 25);
  assert.equal(metrics.total.units, 3240);
  assert.equal(metrics.total.sale_records, 2160);
  assert.equal(metrics.total.sales_usd, null);
  assert.equal(metrics.price_volume.sales_lower_usd,3240);
  assert.equal(metrics.price_volume.sales_upper_usd,6480);
  assert.equal((await fetch(`${base}/api/export/sales.csv?source=tcgplayer-daily`)).status, 400);
  const output = await (await fetch(`${base}/api/export/volume.csv?source=tcgplayer-daily`)).text();
  assert.equal(output.trim().split('\r\n').length, 1081);
  assert.match(output, /"date_source","quantity","transaction_count"/);
  assert.match(output, /"low_sale_price_usd","high_sale_price_usd"/);
  assert.doesNotMatch(output, /unit_price|sales_usd|date_utc/);
  const daily = await (await fetch(`${base}/api/export/daily.csv?from=2026-10-31&to=2026-10-31`)).text();
  assert.match(daily, /"2026-10-31","72","108","","tcgplayer-daily"/);
  assert.match(daily, /"products_with_history","sku_buckets"/);
  const species = await (await fetch(`${base}/api/export/pokemon-daily.csv`)).text();
  assert.equal(species.trim().split('\r\n').length, 1081);
  assert.match(species, /"date_source"/);
  assert.equal((await fetch(`${base}/api/export/volume.csv?source=snapshot`)).status, 400);
  const value = await (await fetch(`${base}/api/export/sales-value.csv?from=2026-10-31&to=2026-10-31`)).text();
  assert.match(value, /"2026-10-31","108","108","0","108","216","108","216",""/);
  const pokemonValue = await (await fetch(`${base}/api/export/sales-value.csv?group=pokemon`)).text();
  assert.equal(pokemonValue.trim().split('\r\n').length,1081);
  assert.equal((await fetch(`${base}/api/export/sales-value.csv?group=invalid`)).status,400);
  assert.equal((await fetch(`${base}/api/export/sales-value.csv?source=snapshot`)).status,400);
});
