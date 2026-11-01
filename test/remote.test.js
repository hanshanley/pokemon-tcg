import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { publicCheckpoint, collectRemote } from '../src/remote.js';
import { saveMonthHistory } from '../src/volume.js';

test('remote checkpoints preserve all public buckets and queue state but exclude local transactions and diagnostics', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pokemon-remote-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const source = join(directory, 'local.sqlite'), destination = join(directory, 'public.sqlite');
  const store = new Store(source);
  store.db.prepare(`INSERT INTO catalog_products VALUES
    (1,3,604,'Fixture set','Charizard','','','','','["Charizard"]','','build',1)`).run();
  store.addProduct({ url: 'https://www.tcgplayer.com/product/1', name: 'Charizard',
    kind: 'single', pokemon: ['Charizard'] });
  store.record({ id: 1 }, { sales: [{ orderDate: '2026-10-31T12:00:00Z', quantity: 100, purchasePrice: 10 }] });
  const payload = { count: 1, result: [{ skuId: '101', condition: 'Near Mint',
    variant: 'Normal', language: 'English', buckets: Array.from({ length: 30 }, (_, n) => ({
      bucketStartDate: new Date(Date.UTC(2026, 9, 31 - n)).toISOString().slice(0, 10),
      quantitySold: n === 0 ? 3 : 0, transactionCount: n === 0 ? 2 : 0,
    })) }] };
  saveMonthHistory(store, 1, payload);
  store.db.exec(`INSERT INTO volume_runs(date_utc,started_at,updated_at,status,warning)
    VALUES ('2026-11-01','now','now','running','local diagnostic');
    INSERT INTO volume_jobs(date_utc,product_id,status,attempts,warning)
    VALUES ('2026-11-01',1,'success',1,'local diagnostic')`);
  try {
    assert.equal(publicCheckpoint(source, destination).sku_buckets, 30);
    assert.throws(() => publicCheckpoint(source, source), /must not overwrite/);
    assert.throws(() => publicCheckpoint(source, destination), /must be a new file/);
  }
  finally { store.close(); }
  const remote = new Store(destination);
  try {
    assert.equal(remote.metrics().total.units, 3);
    for (const table of ['products', 'sales', 'bulk_sales', 'collections']) {
      assert.equal(remote.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    }
    assert.equal(remote.db.prepare('SELECT status FROM volume_runs').get().status, 'paused');
    assert.equal(remote.db.prepare('SELECT warning FROM volume_jobs').get().warning, '');
    assert.equal(remote.db.prepare('SELECT warning FROM volume_runs').get().warning, '');
    assert.equal(remote.db.prepare('SELECT status FROM volume_jobs').get().status, 'success');
    assert.equal([...remote.volumeRows()].length, 30);
  } finally { remote.close(); }
});

test('remote passes retry bootstrap transients but stop denied access without another request', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let starts = 0, closed = 0;
  const waits = [];
  await collectRemote(store, { refreshCatalog: async () => {}, log: () => {},
    pause: async delay => waits.push(delay),
    createTransport: async () => {
      if (++starts < 2) throw new Error('Temporary navigation failure');
      return { fetchHistory: async () => ({ status: 200, body: { count: 0 } }),
        close: async () => { closed++; } };
    } });
  assert.equal(starts, 2);
  assert.equal(closed, 1);
  assert.deepEqual(waits, [900000]);
  starts = 0;
  await assert.rejects(collectRemote(store, { refreshCatalog: async () => {}, log: () => {},
    pause: async () => { throw new Error('Must not wait and retry a denial'); },
    createTransport: async () => { starts++; throw Object.assign(new Error('Denied'), { status: 403 }); } }), /Denied/);
  assert.equal(starts, 1);
});
