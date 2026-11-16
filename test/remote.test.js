import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { publicCheckpoint, collectRemote, retryFailedJobs } from '../src/remote.js';
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
      lowSalePrice: n === 0 ? '2' : null, highSalePrice: n === 0 ? '3' : null,
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
    store.db.exec('DROP TABLE daily_sale_prices; DROP TABLE price_checks; DROP TABLE price_product_days');
    const legacyPath = join(directory,'legacy-public.sqlite');
    assert.equal(publicCheckpoint(source,legacyPath).sku_buckets,30);
    const legacy = new Store(legacyPath);
    try { assert.equal(legacy.saleValueRows()[0].unpriced_units,3); }
    finally { legacy.close(); }
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
    assert.equal(remote.saleValueRows()[0].sales_lower_usd,6);
    assert.equal(remote.saleValueRows()[0].sales_upper_usd,9);
    assert.equal(remote.db.prepare('SELECT count(*) AS n FROM price_checks').get().n,1);
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

test('productive remote recovery resets the failure budget without exceeding the request limit', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (let id = 1; id <= 12; id++) store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,'Set','Charizard','','','','','["Charizard"]','','build',1)`).run(id);
  let starts = 0, requests = 0, closed = 0;
  const waits = [];
  const state = await collectRemote(store, { limit: 15,
    refreshCatalog: async () => {}, log: () => {},
    pause: async delay => waits.push(delay),
    createTransport: async () => {
      const round = ++starts;
      let calls = 0;
      return {
        fetchHistory: async () => {
          requests++;
          if (++calls > 1 && round <= 3) throw new Error('Temporary fetch failure');
          return { status: 200, body: { count: 0 } };
        },
        close: async () => { closed++; },
      };
    } });
  assert.equal(starts, 4);
  assert.equal(closed, 4);
  assert.equal(requests, 15);
  assert.deepEqual(waits, [15000,15000,15000]);
  assert.equal(state.products_without_history, 12);
  assert.equal(state.products_failed, 0);
  assert.equal(state.status, 'complete');
});

test('remote recovery stops after three unproductive transports', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (let id = 1; id <= 3; id++) store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,'Set','Charizard','','','','','["Charizard"]','','build',1)`).run(id);
  let starts = 0, closed = 0;
  const waits = [];
  await assert.rejects(collectRemote(store, { refreshCatalog: async () => {}, log: () => {},
    pause: async delay => waits.push(delay),
    createTransport: async () => {
      starts++;
      return { fetchHistory: async () => { throw new Error('Temporary fetch failure'); },
        close: async () => { closed++; } };
    } }), /Temporary fetch failure/);
  assert.equal(starts, 3);
  assert.equal(closed, 3);
  assert.deepEqual(waits, [900000,900000]);
  assert.deepEqual({ ...store.db.prepare('SELECT status,attempts FROM volume_jobs LIMIT 1').get() },
    { status: 'pending', attempts: 0 });
});

test('remote passes retry trailing product failures within the same request budget', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.db.prepare(`INSERT INTO catalog_products VALUES
    (1,3,604,'Set','Charizard','','','','','["Charizard"]','','build',1)`).run();
  let requests = 0, closed = 0;
  const options = {
    refreshCatalog: async () => {}, log: () => {},
    createTransport: async () => ({
      fetchHistory: async () => {
        if (++requests === 1) return { status: 500, body: null };
        return { status: 200, body: { count: 0 } };
      },
      close: async () => { closed++; },
    }),
  };
  const first = await collectRemote(store, { ...options, limit: 1 });
  assert.equal(first.status, 'paused');
  assert.equal(requests, 1);
  requests = 0;
  const recovered = await collectRemote(store, { ...options, limit: 10 });
  assert.equal(recovered.status, 'complete');
  assert.equal(recovered.products_failed, 0);
  assert.equal(requests, 2);
  assert.equal(closed, 2);
});

test('persistent trailing failures exhaust three attempts without reporting completion', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.db.prepare(`INSERT INTO catalog_products VALUES
    (1,3,604,'Set','Charizard','','','','','["Charizard"]','','build',1)`).run();
  let requests = 0;
  const state = await collectRemote(store, {
    limit: 10, refreshCatalog: async () => {}, log: () => {},
    createTransport: async () => ({
      fetchHistory: async () => { requests++; return { status: 500, body: null }; },
      close: async () => {},
    }),
  });
  assert.equal(requests, 3);
  assert.equal(state.products_failed, 1);
  assert.equal(state.status, 'partial');
});

test('a transport failure at the pass limit stays pending without exhausting product attempts', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.db.prepare(`INSERT INTO catalog_products VALUES
    (1,3,604,'Set','Charizard','','','','','["Charizard"]','','build',1)`).run();
  const options = { limit: 1, refreshCatalog: async () => {}, log: () => {},
    pause: async () => { throw new Error('Budget exhausted: must not retry'); },
    createTransport: async () => ({ fetchHistory: async () => { throw new TypeError('Failed to fetch'); },
      close: async () => {} }) };
  for (let pass = 0; pass < 4; pass++) {
    const state = await collectRemote(store, options);
    assert.equal(state.status, 'paused');
    assert.equal(state.products_failed, 0);
    assert.equal(store.db.prepare('SELECT attempts FROM volume_jobs').get().attempts, 0);
  }
});

test('explicit failed-product repair resets only the requested date and preserves successes', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (let id = 1; id <= 2; id++) store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,'Set','Charizard','','','','','["Charizard"]','','build',1)`).run(id);
  store.db.exec(`INSERT INTO volume_runs(date_utc,started_at,updated_at,status) VALUES
    ('2026-11-15','now','now','partial'),('2026-11-16','now','now','partial');
    INSERT INTO volume_jobs(date_utc,product_id,status,attempts) VALUES
    ('2026-11-15',1,'failed',3),('2026-11-16',1,'failed',3),('2026-11-16',2,'success',1)`);
  assert.equal(retryFailedJobs(store,'2026-11-16'),1);
  assert.deepEqual(store.db.prepare('SELECT status,attempts FROM volume_jobs ORDER BY date_utc,product_id')
    .all().map(row => ({ ...row })), [
    { status: 'failed', attempts: 3 }, { status: 'pending', attempts: 0 }, { status: 'success', attempts: 1 },
  ]);
});

test('rate limits retain their thirty-minute backoff even after productive progress', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (let id = 1; id <= 2; id++) store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,'Set','Charizard','','','','','["Charizard"]','','build',1)`).run(id);
  const waits = [];
  let requests = 0;
  const options = { limit: 10, refreshCatalog: async () => {}, log: () => {},
    pause: async delay => waits.push(delay),
    createTransport: async () => ({ fetchHistory: async () => ++requests === 2 ?
      { status: 429, body: null } : { status: 200, body: { count: 0, result: [] } },
    close: async () => {} }) };
  const state = await collectRemote(store,options);
  assert.equal(state.status,'complete');
  assert.deepEqual(waits,[1800000]);
  await assert.rejects(collectRemote(store,{ ...options, limit: 1,
    createTransport: async () => ({ fetchHistory: async () => ({ status: 429, body: null }),
      close: async () => {} }),
    refreshCatalog: async () => {
      store.db.exec("UPDATE volume_jobs SET status='pending',attempts=0");
    },
  }),error => error.status === 429);
  assert.deepEqual(waits,[1800000]);
});

test('a denial after committed progress still stops immediately without another transport', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (let id = 1; id <= 2; id++) store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,'Set','Charizard','','','','','["Charizard"]','','build',1)`).run(id);
  let starts = 0, closed = 0, requests = 0;
  await assert.rejects(collectRemote(store, { limit: 10,
    refreshCatalog: async () => {}, log: () => {},
    pause: async () => { throw new Error('Must not retry a denial'); },
    createTransport: async () => {
      starts++;
      return { fetchHistory: async () => ({ status: ++requests === 1 ? 200 : 403,
        body: { count: 0 } }), close: async () => { closed++; } };
    } }), /HTTP 403/);
  assert.equal(starts, 1);
  assert.equal(closed, 1);
  assert.equal(requests, 2);
  assert.equal(store.db.prepare("SELECT count(*) n FROM volume_jobs WHERE status='empty'").get().n, 1);
});
