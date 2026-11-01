import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { importTransactions } from '../src/import.js';

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
