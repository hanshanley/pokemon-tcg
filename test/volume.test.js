import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, volumeSource } from '../src/store.js';
import { monthHistory, saveMonthHistory, syncVolume } from '../src/volume.js';

function setup(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const insert = store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,'Fixture set',?,'','','','',?,'','build',1)`);
  insert.run(1, 'Charizard', '["Charizard"]');
  insert.run(2, 'Trainer', '[]');
  insert.run(3, 'Charizard sealed collection', '["Charizard"]');
  return store;
}

function history({ sku = 101, condition = 'Near Mint', quantity = 3, transactions = 2 } = {}) {
  return { count: 1, result: [{
    skuId: String(sku), condition, variant: 'Holofoil', language: 'English',
    totalQuantitySold: '999', totalTransactionCount: '999',
    buckets: Array.from({ length: 30 }, (_, index) => ({
      bucketStartDate: new Date(Date.UTC(2026, 9, 31 - index)).toISOString().slice(0, 10),
      quantitySold: String(index === 0 ? quantity : 0),
      transactionCount: String(index === 0 ? transactions : 0),
      marketPrice: '123.45',
    })),
  }] };
}

test('daily normalization rejects coarse, duplicated and invalid buckets without inventing missing units', () => {
  const valid = history();
  assert.equal(monthHistory(valid).reduce((sum, row) => sum + row.quantity, 0), 3);
  assert.deepEqual(monthHistory({ count: 0 }), []);
  assert.deepEqual(monthHistory({ count: 0, result: null }), []);
  for (const mutate of [
    p => { p.result[0].buckets[1].bucketStartDate = '2026-10-28'; },
    p => { p.result[0].buckets[1].bucketStartDate = '2026-10-31'; },
    p => { p.result[0].buckets[0].bucketStartDate = '2026-02-30'; },
    p => { p.result[0].buckets[0].quantitySold = null; },
    p => { p.result[0].buckets[0].transactionCount = -1; },
    p => { p.result[0].buckets.pop(); },
    p => { p.result[0].language = ''; },
    p => { p.count = 2; p.result.push(structuredClone(p.result[0])); },
  ]) {
    const payload = structuredClone(valid);
    mutate(payload);
    assert.throws(() => monthHistory(payload));
  }
  assert.throws(() => monthHistory({ count: 0, result: [{}] }));
});

test('overlapping daily imports replace corrected counts atomically and preserve transaction separation', t => {
  const store = setup(t), first = '2026-10-31T12:00:00.000Z', later = '2026-10-31T13:00:00.000Z';
  saveMonthHistory(store, 1, history(), first);
  saveMonthHistory(store, 1, history(), later);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM daily_volume').get().n, 30);
  assert.equal(store.metrics().total.units, 3);
  saveMonthHistory(store, 1, history({ quantity: 6, transactions: 4 }), later);
  assert.deepEqual(store.metrics().total, { sale_records: 4, units: 6, sales_usd: null });
  assert.equal(store.db.prepare('SELECT first_seen FROM daily_volume LIMIT 1').get().first_seen, first);
  const invalid = history({ quantity: 99 });
  invalid.result[0].buckets[10].quantitySold = 'bad';
  assert.throws(() => saveMonthHistory(store, 1, invalid));
  assert.equal(store.metrics().total.units, 6);
  assert.throws(() => saveMonthHistory(store, 999, history()));
  saveMonthHistory(store, 1, history({ quantity: 0, transactions: 0 }), later);
  assert.equal(store.metrics().total.units, 0);
  assert.equal(store.metrics().daily.length, 30);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM bulk_sales').get().n, 0);
});

test('daily SQL filters and species reports sum native transaction counts, never bucket counts or market-price revenue', t => {
  const store = setup(t);
  saveMonthHistory(store, 1, history());
  saveMonthHistory(store, 2, history({ sku: 102, quantity: 5, transactions: 4 }));
  saveMonthHistory(store, 3, history({ sku: 103, condition: 'Unopened', quantity: 7, transactions: 6 }));
  store.addProduct({ url: 'https://www.tcgplayer.com/product/1',
    name: 'Charizard', kind: 'single', pokemon: ['Charizard'] });
  store.record({ id: 1 }, { sales: [{ orderDate: '2026-10-31T12:00:00Z', quantity: 100, purchasePrice: 10 }] });
  const metrics = store.metrics();
  assert.equal(metrics.sales_source, volumeSource);
  assert.equal(metrics.data_kind, 'daily-buckets');
  assert.deepEqual(metrics.total, { sale_records: 12, units: 15, sales_usd: null });
  assert.deepEqual(metrics.pokemon, [{ name: 'Charizard', sale_records: 2, units: 3, sales_usd: null }]);
  assert.equal(store.metrics({ kind: 'sealed' }).total.units, 7);
  assert.equal(store.metrics({ source: 'snapshot' }).total.units, 100);
  assert.equal(store.metrics({ from: '2026-10-30', to: '2026-10-30' }).total.units, 0);
  assert.equal(store.dailyRows({ from: '2026-10-31', to: '2026-10-31' })[0].products_with_history, 3);
  assert.equal(store.pokemonDailyRows({ from: '2026-10-31', to: '2026-10-31' })[0].date_source, '2026-10-31');
  assert.equal([...store.volumeRows({ kind: 'sealed' })].length, 30);
  assert.throws(() => store.saleRows(), /no individual transactions/);
  assert.throws(() => store.volumeRows({ source: 'snapshot' }), /requires/);
  assert.match(metrics.timezone, /not published/);
});

test('all-catalog jobs resume from committed products, retry failures and do not equate empty histories with zero', async t => {
  const store = setup(t), calls = [];
  let fail = true;
  const options = { now: () => new Date('2026-10-31T12:00:00Z'), pause: async () => {}, log: () => {},
    fetchHistory: async id => {
      calls.push(id);
      if (id === 2) return fail ? { status: 500 } : { status: 200, body: { count: 0 } };
      return { status: 200, body: history({ sku: id, condition: id === 3 ? 'Unopened' : 'Near Mint' }) };
    } };
  const paused = await syncVolume(store, { ...options, limit: 2 });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.products_expected, 3);
  assert.equal(paused.products_checked, 2);
  assert.equal(paused.products_failed, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM daily_volume WHERE product_id=2').get().n, 0);
  fail = false;
  const complete = await syncVolume(store, options);
  assert.deepEqual(calls, [1, 2, 2, 3]);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.products_with_history, 2);
  assert.equal(complete.products_without_history, 1);
  assert.equal(complete.products_failed, 0);
  await syncVolume(store, options);
  assert.equal(calls.length, 4);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM daily_volume').get().n, 60);
});

test('rate-limited or denied access stops the sweep rather than requesting every product or fabricating zeroes', async t => {
  const store = setup(t);
  let calls = 0;
  await assert.rejects(syncVolume(store, { pause: async () => {}, log: () => {},
    fetchHistory: async () => { calls++; return { status: 429 }; } }), /unavailable data/);
  assert.equal(calls, 1);
  const state = store.db.prepare('SELECT * FROM volume_runs').get();
  assert.equal(state.status, 'failed');
  assert.equal(state.products_checked, 1);
  assert.equal(state.products_with_history, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM daily_volume').get().n, 0);
});

test('existing raw daily history migrates into product/day rollups without losing counts or zero days', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pokemon-volume-migration-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'sales.sqlite'), original = new Store(path);
  try {
    original.db.prepare(`INSERT INTO catalog_products VALUES
      (1,3,604,'Fixture set','Charizard','','','','','["Charizard"]','','build',1)`).run();
    saveMonthHistory(original, 1, history());
    original.db.exec('DROP VIEW reported_product_volume; DROP TABLE volume_product_days');
  } finally { original.close(); }
  const migrated = new Store(path);
  try {
    assert.deepEqual(migrated.metrics().total, { sale_records: 2, units: 3, sales_usd: null });
    assert.equal(migrated.dailyRows().length, 30);
    assert.equal([...migrated.volumeRows()].length, 30);
    saveMonthHistory(migrated, 1, history({ quantity: 8, transactions: 5 }));
    assert.equal(migrated.metrics().total.units, 8);
    assert.equal(migrated.pokemonDailyRows({ from: '2026-10-31', to: '2026-10-31' })[0].units, 8);
  } finally { migrated.close(); }
});

test('actual sale-price ranges bound dollars, preserve corrections, and never substitute market prices', t => {
  const store = setup(t), payload = history();
  const bucket = payload.result[0].buckets[0];
  Object.assign(bucket, { lowSalePrice: '2.00', highSalePrice: '4.00',
    lowSalePriceWithShipping: '2.29', highSalePriceWithShipping: '4.99' });
  saveMonthHistory(store,1,payload);
  let totals = store.saleValueRows()[0];
  assert.equal(totals.priced_units,3);
  assert.equal(totals.sales_lower_usd,6);
  assert.equal(totals.sales_upper_usd,12);
  assert.equal(totals.sales_usd,null);
  assert.equal(store.saleValueRows({},'pokemon').at(-1).priced_sales_upper_usd,12);
  assert.equal([...store.volumeRows()].at(-1).low_sale_price_with_shipping_usd,2.29);
  Object.assign(bucket,{ lowSalePrice: '0.29', highSalePrice: '0.29' });
  saveMonthHistory(store,1,payload);
  assert.equal(store.saleValueRows()[0].sales_usd,0.87);
  for (const values of [{lowSalePrice:'bad'}, {lowSalePrice:'1.333'},
    {lowSalePrice:'5',highSalePrice:'4'}]) {
    const invalid = structuredClone(payload);
    Object.assign(invalid.result[0].buckets[0],values);
    assert.throws(()=>saveMonthHistory(store,1,invalid));
    assert.equal(store.saleValueRows()[0].sales_usd,0.87);
  }
  saveMonthHistory(store,2,history({ sku:102,quantity:5 }));
  totals = store.saleValueRows()[0];
  assert.equal(totals.unpriced_units,5);
  assert.equal(totals.priced_sales_lower_usd,0.87);
  assert.equal(totals.sales_lower_usd,null);
  assert.equal(totals.sales_usd,null);
  delete bucket.lowSalePrice;
  delete bucket.highSalePrice;
  saveMonthHistory(store,1,payload);
  assert.equal(store.saleValueRows()[0].priced_units,0);
  assert.equal(store.saleValueRows()[0].unpriced_units,8);
  assert.equal(store.saleValueRows({ from:'2026-09-01',to:'2026-09-01' })[0].sales_usd,null);
});

test('daily product, Pokemon and set values preserve counts, distinct set IDs, price gaps and corrections', t => {
  const store = setup(t), date = '2026-10-31';
  const insert = store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,?,?,'Fixture set',?,'','','','',?,'','build',1)`);
  insert.run(4, 85, 604, 'Charizard & Mewtwo', '["Charizard","Mewtwo"]');
  insert.run(5, 3, 605, 'Squirtle', '["Squirtle"]');
  insert.run(6, 3, 606, 'No history', '[]');
  const priced = history();
  Object.assign(priced.result[0].buckets[0], { lowSalePrice: '2', highSalePrice: '4' });
  saveMonthHistory(store, 1, priced);
  const extraSku = history({ sku: 106, quantity: 1, transactions: 1 });
  Object.assign(extraSku.result[0].buckets[0], { lowSalePrice: '0.29', highSalePrice: '0.29' });
  saveMonthHistory(store, 1, extraSku);
  saveMonthHistory(store, 2, history({ sku: 102, quantity: 5, transactions: 4 }));
  saveMonthHistory(store, 3, history({ sku: 103, condition: 'Unopened', quantity: 7, transactions: 6 }));
  const multi = history({ sku: 104, quantity: 2, transactions: 1 });
  Object.assign(multi.result[0].buckets[0], { lowSalePrice: '1.25', highSalePrice: '1.25' });
  saveMonthHistory(store, 4, multi);
  const missingPrice = history({ sku: 105, quantity: 4, transactions: 3 });
  missingPrice.result[0].buckets[0].lowSalePrice = '9';
  saveMonthHistory(store, 5, missingPrice);
  const filters = { source: volumeSource, from: date, to: date };
  const products = [...store.saleValueRows(filters, 'product-daily', true)];
  assert.deepEqual(products.map(row => row.product_id), [1, 2, 3, 4, 5]);
  assert.equal(products[0].units, 4);
  assert.equal(products[0].sale_records, 3);
  assert.equal(products[0].sales_lower_usd, 6.29);
  assert.equal(products[0].sales_upper_usd, 12.29);
  assert.equal(products[0].sales_usd, null);
  assert.equal(products[3].sales_usd, 2.5);
  assert.equal(products[4].unpriced_units, 4);
  assert.equal(products[4].sales_lower_usd, null);
  const sets = store.saleValueRows(filters, 'set-daily');
  assert.deepEqual(sets.map(row => [row.category_id, row.group_id]), [[3, 604], [3, 605], [85, 604]]);
  assert.equal(sets[0].units, 16);
  assert.equal(sets[0].unpriced_units, 12);
  assert.equal(sets[0].sales_usd, null);
  const reconcile = rows => {
    const total = store.saleValueRows(filters, 'daily')[0];
    for (const field of ['sale_records', 'units', 'priced_units', 'unpriced_units',
      'priced_sales_lower_usd', 'priced_sales_upper_usd']) {
      assert.equal(rows.reduce((sum, row) => sum + Math.round(row[field] * 100), 0),
        Math.round(total[field] * 100), field);
    }
  };
  reconcile(products);
  reconcile(sets);
  const pokemon = store.saleValueRows(filters, 'pokemon');
  const charizard = pokemon.find(row => row.pokemon_key === 'charizard');
  assert.equal(charizard.units, 6);
  assert.equal(charizard.sale_records, 4);
  assert.equal(charizard.sales_lower_usd, 8.79);
  assert.equal(pokemon.find(row => row.pokemon_key === 'mewtwo').sales_usd, 2.5);
  assert.equal(pokemon.reduce((sum, row) => sum + row.units, 0), 12);
  assert.equal(store.saleValueRows({ ...filters, kind: 'single' })[0].units, 15);
  assert.deepEqual(store.saleValueRows({ ...filters, kind: 'sealed' }, 'product-daily')
    .map(row => row.product_id), [3]);
  assert.deepEqual(store.saleValueRows({ ...filters, kind: 'sealed' }, 'pokemon'), []);
  assert.equal(store.saleValueRows({}, 'product-daily').length, 150);
  assert.equal(store.saleValueRows({}, 'set-daily').length, 90);
  assert.deepEqual(store.saleValueRows({ from: '2026-11-01' }, 'set-daily'), []);
  const zero = store.saleValueRows({ from: '2026-10-30', to: '2026-10-30' }, 'set-daily');
  assert.ok(zero.every(row => row.units === 0 && row.sale_records === 0 && row.sales_usd === 0));
  Object.assign(multi.result[0].buckets[0], { quantitySold: '0', transactionCount: '0' });
  saveMonthHistory(store, 4, multi);
  reconcile(store.saleValueRows(filters, 'product-daily'));
  reconcile(store.saleValueRows(filters, 'set-daily'));
  assert.equal(store.saleValueRows(filters, 'set-daily').at(-1).sales_usd, 0);
  assert.equal(store.saleValueRows(filters, 'pokemon')
    .find(row => row.pokemon_key === 'mewtwo').units, 0);
});

test('legacy successful jobs are backfilled for prices once without reopening priced jobs', async t => {
  const store = setup(t), calls = [];
  const options = {now:()=>new Date('2026-10-31T12:00:00Z'),pause:async()=>{},log:()=>{},
    fetchHistory:async id=>{
      calls.push(id);
      return {status:200,body:id===2?{count:0}:history({sku:id})};
    }};
  await syncVolume(store,options);
  store.db.prepare('DELETE FROM price_checks WHERE product_id=1').run();
  await syncVolume(store,options);
  assert.deepEqual(calls,[1,2,3,1]);
  await syncVolume(store,options);
  assert.equal(calls.length,4);
});
