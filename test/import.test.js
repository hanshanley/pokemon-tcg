import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { importTransactions } from '../src/import.js';
import { fetchHistoryExport, importHistory } from '../src/import-history.js';
import { checkCompleteDatabase } from '../src/publish.js';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pokemon-bulk-import-'));
  const store = new Store(':memory:');
  t.after(() => { store.close(); rmSync(dir, { recursive: true }); });
  const insert = store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,'Base Set',?,'','','','','[\"Charizard\"]','','build',1)`);
  insert.run(42382, 'Charizard');
  insert.run(502001, 'Charizard Sealed Box');
  const path = join(dir, 'sales.jsonl');
  const save = rows => writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n'));
  return { store, path, save };
}
const sale = (overrides = {}) => ({
  transaction_id: 'sale-a', product_id: 42382, kind: 'single',
  orderDate: '2026-10-31T03:30:00+03:00', quantity: 2, purchasePrice: 10.25, ...overrides,
});

const exportTime = '2026-10-31T12:00:00.000Z';
const importTime = new Date('2026-10-31T13:00:00.000Z');
const header = {
  format: 'tcgplayer-sku-history-v1', source: 'tcgplayer-daily', observed_at: exportTime,
  catalog_source_build: 'build', products_expected: 2,
};
const emptyHistory = { product_id: 502001, history: { count: 0, result: [] } };

function historyProduct(end = 31) {
  return { product_id: 42382, history: { count: 1, result: [{
    skuId: 102, condition: 'Near Mint', variant: 'Holofoil', language: 'English',
    buckets: Array.from({ length: 30 }, (_, index) => ({
      bucketStartDate: new Date(Date.UTC(2026, 9, end - index)).toISOString().slice(0, 10),
      quantitySold: 3, transactionCount: 2, lowSalePrice: '1.00', highSalePrice: '2.00',
    })),
  }] } };
}

function setupHistory(t) {
  const { store, path, save } = setup(t);
  store.db.prepare(`INSERT INTO catalog_runs (source_build,started_at,finished_at,status)
    VALUES ('build',?,?,'complete')`).run(exportTime, exportTime);
  return { store, path, save };
}

test('offline history import restores a physically verifiable sweep, including explicit empty products', async t => {
  const { store, path, save } = setupHistory(t);
  save([header, emptyHistory, historyProduct()]);
  assert.deepEqual(await importHistory(store, path, importTime), {
    source: 'tcgplayer-daily', observed_at: exportTime, products_checked: 2,
    products_with_history: 1, products_without_history: 1, buckets: 30,
  });
  const totals = store.saleValueRows({ from: '2026-10-31' })[0];
  assert.equal(totals.units, 3);
  assert.equal(totals.sale_records, 2);
  assert.equal(totals.sales_lower_usd, 3);
  assert.equal(totals.sales_upper_usd, 6);
  const { warning, ...sweep } = store.db.prepare('SELECT * FROM volume_runs').get();
  const verified = checkCompleteDatabase(store.db, {
    source: 'tcgplayer-daily', sku_buckets: 30, units: 90, transactions: 60,
    generated_at: importTime.toISOString(), last_successful_check_at: exportTime,
    catalog_products: 2, catalog_source_build: 'build', sweep,
  }, importTime);
  assert.equal(verified.products_checked, 2);
  await assert.rejects(importHistory(store, path, importTime), /newer than the existing saved observations/);

  const correction = historyProduct();
  correction.history.result[0].buckets[0].quantitySold = 100;
  save([{ ...header, observed_at: '2026-10-31T12:15:00.000Z' }, correction]);
  await assert.rejects(importHistory(store, path, importTime), /incomplete catalog/);
  assert.equal(checkCompleteDatabase(store.db, {
    source: 'tcgplayer-daily', sku_buckets: 30, units: 90, transactions: 60,
    generated_at: importTime.toISOString(), last_successful_check_at: exportTime,
    catalog_products: 2, catalog_source_build: 'build', sweep,
  }, importTime).units, 90);
});

test('offline history import rejects stale dates, wrong catalog, missing, duplicate and implicitly empty results atomically', async t => {
  const { store, path, save } = setupHistory(t);
  const valid = historyProduct();
  for (const [rows, expected] of [
    [[header, valid], /incomplete catalog/],
    [[header, valid, valid], /duplicate catalog product/],
    [[header, valid, { ...emptyHistory, product_id: 42 }], /Unknown/],
    [[header, valid, { ...emptyHistory, history: { count: 0 } }], /explicitly provide/],
    [[header, historyProduct(30), emptyHistory], /required observation window/],
    [[{ ...header, catalog_source_build: 'old' }, valid, emptyHistory], /must match/],
    [[{ ...header, observed_at: '2026-10-30T12:00:00.000Z' }, valid, emptyHistory], /current UTC/],
    [[{ ...header, observed_at: '2026-10-31T14:00:00.000Z' }, valid, emptyHistory], /current UTC/],
  ]) {
    save(rows);
    await assert.rejects(importHistory(store, path, importTime), expected);
    for (const table of ['daily_volume', 'daily_sale_prices', 'price_checks', 'volume_jobs', 'volume_runs']) {
      assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
    }
  }
});

test('approved export download does not retry, follow redirects, or import partial responses', async t => {
  const { store } = setupHistory(t);
  const url = 'https://exports.example.test/today.jsonl?signature=fixture';
  await assert.rejects(fetchHistoryExport(store, 'http://exports.example.test/history'), /approved HTTPS/);
  for (const [fetcher, error] of [
    [async () => new Response('access denied', { status: 403 }), /HTTP 403/],
    [async () => new Response('truncated export', { status: 206 }), /HTTP 206/],
    [async () => { throw new Error(url); }, /request failed or redirected/],
    [async () => new Response(JSON.stringify(header)), /incomplete catalog/],
  ]) {
    let attempts = 0;
    await assert.rejects(fetchHistoryExport(store, url, {
      now: () => importTime,
      fetcher: (address, options) => {
        attempts++;
        assert.equal(address.href, url);
        assert.equal(options.redirect, 'error');
        return fetcher();
      },
    }), err => error.test(err.message) && !err.message.includes('signature'));
    assert.equal(attempts, 1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM volume_runs').get().n, 0);
  }
});

test('bulk imports deduplicate stable IDs, retain identical separate sales and aggregate directly in SQL', async t => {
  const { store, path, save } = setup(t);
  store.addProduct({ url: 'https://www.tcgplayer.com/product/42382',
    name: 'Charizard', kind: 'single', pokemon: ['Charizard'] });
  store.record(store.products()[0], { sales: [sale()] });
  save([sale(), sale({ transaction_id: 'sale-b' }), sale({
    transaction_id: 'sale-c', product_id: 502001, kind: 'sealed', quantity: 3, purchasePrice: 40,
  })]);
  assert.equal((await importTransactions(store, path, 'feed')).rows_added, 3);
  assert.equal((await importTransactions(store, path, 'feed')).rows_added, 0);
  store.saleRows = () => { throw new Error('Metrics must not load transaction rows into JavaScript.'); };
  const metrics = store.metrics();
  assert.equal(metrics.sales_source, 'feed');
  assert.deepEqual(metrics.total, { sale_records: 3, units: 7, sales_usd: 161 });
  assert.deepEqual(metrics.pokemon, [{ name: 'Charizard', sale_records: 2, units: 4, sales_usd: 41 }]);
  assert.equal(store.metrics({ source: 'snapshot' }).total.units, 2);
  assert.equal(store.metrics({ kind: 'sealed' }).pokemon.length, 0);
  assert.equal(store.metrics({ from: '2026-10-30', to: '2026-10-30' }).total.units, 0);
  assert.equal(store.db.prepare(`SELECT units FROM observed_daily_pokemon_sales
    WHERE source='feed' AND date_utc='2026-10-31'`).get().units, 4);
  assert.equal(store.catalogSummary('feed').products_with_saved_sales, 2);
});

test('bulk import rolls back missing quantities, unknown products and reused IDs with different data', async t => {
  const { store, path, save } = setup(t);
  for (const invalid of [{ quantity: undefined }, { transaction_id: undefined },
    { product_id: 999999 }, { kind: 'unknown' }, { orderDate: undefined },
    { currency: 'EUR' }, { status: 'cancelled' }]) {
    save([sale(), sale({ transaction_id: 'bad', ...invalid })]);
    await assert.rejects(importTransactions(store, path, 'feed'), /no rows committed/);
    assert.equal(store.metrics().total.sale_records, 0);
  }
  save([sale()]);
  await importTransactions(store, path, 'feed');
  save([sale({ transaction_id: 'new' }), sale({ quantity: 3 })]);
  await assert.rejects(importTransactions(store, path, 'feed'), /reused with different/);
  assert.equal(store.metrics().total.sale_records, 1);
});

test('different bulk sources stay separate rather than inflating combined marketplace volume', async t => {
  const { store, path, save } = setup(t);
  save([sale()]);
  await importTransactions(store, path, 'first');
  await importTransactions(store, path, 'second');
  assert.equal(store.metrics().total.units, 2);
  assert.equal(store.metrics({ source: 'first' }).total.units, 2);
  assert.deepEqual(store.metrics().available_sources, ['snapshot', 'first', 'second']);
  await assert.rejects(importTransactions(store, path, 'snapshot'), /source name/);
  await assert.rejects(importTransactions(store, path, 'tcgplayer-daily'), /source name/);
});
