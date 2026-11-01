import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Store } from '../src/store.js';
import { saveMonthHistory } from '../src/volume.js';
import { exportSnapshot, checkFreshness } from '../src/publish.js';

test('published reports and complete compressed downloads retain corrected counts and zero buckets', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pokemon-publish-'));
  const store = new Store(':memory:');
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  store.db.prepare(`INSERT INTO catalog_products VALUES
    (1,3,604,'Fixture set','Charizard','','','','','["Charizard"]','','build',1)`).run();
  const now = new Date('2026-11-01T12:00:00Z');
  const payload = { count: 1, result: [{ skuId: '101', condition: 'Near Mint',
    variant: 'Holofoil', language: 'English', buckets: Array.from({ length: 30 }, (_, index) => ({
      bucketStartDate: new Date(Date.UTC(2026, 9, 31 - index)).toISOString().slice(0, 10),
      quantitySold: index === 0 ? 8 : 0, transactionCount: index === 0 ? 5 : 0,
    })) }] };
  saveMonthHistory(store, 1, payload, now.toISOString());
  payload.result[0].buckets[0].quantitySold = 3;
  saveMonthHistory(store, 1, payload, now.toISOString());
  const coverage = await exportSnapshot(store, directory, now);
  assert.equal(coverage.units, 3);
  assert.equal(coverage.sku_buckets, 30);
  assert.equal(coverage.sales_usd, null);
  const sku = gunzipSync(readFileSync(join(directory, 'daily-sku-volume.csv.gz'))).toString();
  assert.equal(sku.trimEnd().split('\n').length, 31);
  assert.ok(sku.includes('"tcgplayer-daily","1","Charizard","single"'));
  assert.equal(gunzipSync(readFileSync(join(directory, 'pokemon-product-catalog.csv.gz')))
    .toString().trimEnd().split('\n').length, 2);
  assert.ok(readFileSync(join(directory, 'pokemon-daily.csv'), 'utf8')
    .includes('"2026-10-31","charizard","Charizard","5","3","","1"'));
  assert.ok(readFileSync(join(directory, 'product-volume.csv'), 'utf8').includes('"1","Charizard","3","5"'));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM daily_volume').get().n, 30);
});

test('publishing rejects absent or stale observations rather than producing fresh-looking zero sales', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pokemon-publish-empty-'));
  const store = new Store(':memory:');
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  await assert.rejects(exportSnapshot(store, directory), /No daily SKU history/);
  const now = new Date('2026-11-01T12:00:00Z');
  const coverage = { source: 'tcgplayer-daily', sku_buckets: 30,
    generated_at: now.toISOString(), last_successful_check_at: '2026-10-30T12:00:00Z' };
  assert.throws(() => checkFreshness(coverage, now), /last_successful_check_at/);
  assert.throws(() => checkFreshness({ ...coverage, last_successful_check_at: 'bad' }, now), /invalid/);
  assert.doesNotThrow(() => checkFreshness({ ...coverage, last_successful_check_at: now.toISOString() }, now));
});
