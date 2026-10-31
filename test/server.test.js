import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { makeServer, scheduleDaily } from '../src/server.js';

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
