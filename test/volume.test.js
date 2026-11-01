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
