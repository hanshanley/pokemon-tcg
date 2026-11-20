import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { publicCheckpoint, collectRemote, retryFailedJobs } from '../src/remote.js';
import { saveMonthHistory } from '../src/volume.js';
import { exportSnapshot } from '../src/publish.js';
import { dailyCsv } from '../src/figures.js';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

test('daily workflow defaults to native collection while retaining explicit pause and export modes', () => {
  const workflow = readFileSync(new URL('../.github/workflows/daily-volume.yml', import.meta.url), 'utf8');
  const selector = workflow.match(/          case "\$TCGPLAYER_HISTORY_ACCESS" in\n[\s\S]*?          esac/)[0];
  const mode = access => execFileSync('bash', ['-e', '-c', `${selector}\nprintf '%s' "$mode"`], {
    encoding: 'utf8', env: { ...process.env, TCGPLAYER_HISTORY_ACCESS: access },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(mode(''), 'native');
  assert.equal(mode('approved'), 'native');
  assert.equal(mode('approved-export'), 'export');
  assert.throws(() => mode('paused'), error => error.status === 1 && /explicitly paused/.test(error.stdout));
  assert.throws(() => mode('invalid'), error => error.status === 1 && /Unknown/.test(error.stdout));
});

test('historical backfills survive newer rolling windows, public checkpoints and complete downloads', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pokemon-retained-history-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const source = join(directory,'source.sqlite'), destination = join(directory,'public.sqlite');
  const observed = '2026-11-19T16:00:00.000Z';
  const store = new Store(source);
  store.db.prepare(`INSERT INTO catalog_products VALUES
    (1,3,604,'Fixture set','Charizard','','','','','["Charizard"]','','build',1)`).run();
  try {
    for (const end of ['2019-01-31','2026-11-19','2017-05-31']) {
      const payload = { count: 1, result: [{ skuId: '101', condition: 'Near Mint',
        variant: 'Normal', language: 'English', buckets: Array.from({length:30},(_,index) => ({
          bucketStartDate: new Date(Date.parse(end) - index * 86400000).toISOString().slice(0,10),
          quantitySold: index === 0 ? 3 : 0, transactionCount: index === 0 ? 2 : 0,
          lowSalePrice: '2', highSalePrice: '3',
        })) }] };
      saveMonthHistory(store,1,payload,observed);
    }
    assert.equal(publicCheckpoint(source,destination).sku_buckets,90);
  } finally { store.close(); }
  const restored = new Store(destination);
  try {
    const output = join(directory,'reports');
    const coverage = await exportSnapshot(restored,output,new Date('2026-11-19T17:00:00Z'));
    assert.equal(coverage.first_source_date,'2017-05-02');
    assert.equal(coverage.last_source_date,'2026-11-19');
    assert.equal(coverage.sku_buckets,90);
    const rows = dailyCsv(join(output,'daily-trading.csv'));
    assert.equal(rows.length,90);
    assert.deepEqual(rows.filter(row => Number(row.units)>0).map(row => row.date_source),
      ['2017-05-31','2019-01-31','2026-11-19']);
    for (const row of rows.filter(row => Number(row.units)>0)) {
      assert.equal(Number(row.priced_sales_lower_usd),6);
      assert.equal(Number(row.priced_sales_upper_usd),9);
    }
    const full = gunzipSync(readFileSync(join(output,'daily-sku-volume.csv.gz'))).toString();
    assert.equal(full.trimEnd().split(/\r?\n/).length,91);
    assert.match(full,/2017-05-31/);
    assert.match(full,/2019-01-31/);
    assert.match(full,/2026-11-19/);
  } finally { restored.close(); }
});

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

test('three unproductive transports pause the pass and leave pending products resumable', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (let id = 1; id <= 3; id++) store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,'Set','Charizard','','','','','["Charizard"]','','build',1)`).run(id);
  let starts = 0, closed = 0;
  const waits = [];
  const state = await collectRemote(store, { refreshCatalog: async () => {}, log: () => {},
    pause: async delay => waits.push(delay),
    createTransport: async () => {
      starts++;
      return { fetchHistory: async () => { throw new Error('Temporary fetch failure'); },
        close: async () => { closed++; } };
    } });
  assert.equal(state.status, 'paused');
  assert.equal(state.products_checked, 0);
  assert.equal(state.products_failed, 0);
  assert.equal(starts, 3);
  assert.equal(closed, 3);
  assert.deepEqual(waits, [900000,900000]);
  assert.deepEqual({ ...store.db.prepare('SELECT status,attempts FROM volume_jobs LIMIT 1').get() },
    { status: 'pending', attempts: 0 });
  const resumed = await collectRemote(store, {
    refreshCatalog: async () => {}, log: () => {},
    createTransport: async () => ({ fetchHistory: async () => ({ status: 200, body: { count: 0 } }),
      close: async () => {} }),
  });
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.products_checked, 3);
  assert.equal(resumed.products_failed, 0);
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

test('one unavailable product does not block the rest of the catalog or claim completion', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (let id = 1; id <= 3; id++) store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,'Set','Charizard','','','','','["Charizard"]','','build',1)`).run(id);
  const calls = [];
  const state = await collectRemote(store,{
    limit: 10, refreshCatalog: async () => {}, pause: async () => {}, log: () => {},
    createTransport: async () => ({ fetchHistory: async id => {
      calls.push(id);
      if (id === 1) throw new TypeError('Failed to fetch');
      return { status: 200, body: { count: 0 } };
    }, close: async () => {} }),
  });
  assert.deepEqual(calls.slice(0,3),[1,2,3]);
  assert.equal(state.status,'paused');
  assert.equal(state.products_checked,2);
  assert.equal(state.products_failed,0);
  assert.equal(store.db.prepare('SELECT attempts FROM volume_jobs WHERE product_id=1').get().attempts,0);
  const recovered = [];
  const complete = await collectRemote(store,{
    refreshCatalog: async () => {}, log: () => {},
    createTransport: async () => ({ fetchHistory: async id => {
      recovered.push(id);
      return { status: 200, body: { count: 0 } };
    }, close: async () => {} }),
  });
  assert.deepEqual(recovered,[1]);
  assert.equal(complete.status,'complete');
  assert.equal(complete.products_checked,3);
});

test('a reconnect across UTC midnight finishes the same queue without replaying successful products', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (let id = 1; id <= 3; id++) store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,'Set','Charizard','','','','','["Charizard"]','','build',1)`).run(id);
  let time = new Date('2026-11-17T23:59:59Z'), round = 0;
  const calls = [];
  const state = await collectRemote(store,{
    now: () => time, refreshCatalog: async () => {}, pause: async () => {}, log: () => {},
    createTransport: async () => {
      const current = ++round;
      return { close: async () => {}, fetchHistory: async id => {
        calls.push(id);
        if (current === 1 && id === 2) {
          time = new Date('2026-11-18T00:00:01Z');
          throw new TypeError('Failed to fetch');
        }
        return { status: 200, body: { count: 0 } };
      } };
    },
  });
  assert.deepEqual(calls,[1,2,3,2]);
  assert.equal(state.date_utc,'2026-11-17');
  assert.equal(state.status,'complete');
  assert.equal(state.products_checked,3);
  assert.deepEqual(store.db.prepare('SELECT DISTINCT date_utc FROM volume_jobs').all()
    .map(row => row.date_utc),['2026-11-17']);
  assert.equal(store.db.prepare('SELECT fetched_at FROM volume_jobs WHERE product_id=2')
    .get().fetched_at,'2026-11-18T00:00:01.000Z');
  assert.equal(store.db.prepare('SELECT checked_at FROM price_checks WHERE product_id=2')
    .get().checked_at,'2026-11-18T00:00:01.000Z');
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

test('a denial at the request limit stops without waiting or creating another transport', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (let id = 1; id <= 2; id++) store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,'Set','Charizard','','','','','["Charizard"]','','build',1)`).run(id);
  let starts = 0, closed = 0, requests = 0;
  await assert.rejects(collectRemote(store, { limit: 2,
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

test('one intermittent denial after progress recovers in the same session after a thirty-minute cooldown', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (let id = 1; id <= 2; id++) store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,'Set','Charizard','','','','','["Charizard"]','','build',1)`).run(id);
  let starts = 0, closed = 0;
  const calls = [], waits = [];
  const state = await collectRemote(store, { limit: 3,
    refreshCatalog: async () => {}, requestPause: async () => {}, log: () => {},
    pause: async delay => waits.push(delay),
    createTransport: async () => {
      starts++;
      return { fetchHistory: async id => {
        calls.push(id);
        return { status: calls.length === 2 ? 403 : 200, body: { count: 0 } };
      }, close: async () => { closed++; } };
    },
  });
  assert.deepEqual(calls, [1, 2, 2]);
  assert.deepEqual(waits, [1800000]);
  assert.equal(starts, 1);
  assert.equal(closed, 1);
  assert.equal(state.status, 'complete');
  assert.equal(state.products_checked, 2);
  assert.equal(state.products_failed, 0);
});

test('a second denial stops the pass even after more progress, preserving the failed product', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (let id = 1; id <= 3; id++) store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,'Set','Charizard','','','','','["Charizard"]','','build',1)`).run(id);
  let closed = 0;
  const calls = [], waits = [];
  await assert.rejects(collectRemote(store, { limit: 10,
    refreshCatalog: async () => {}, requestPause: async () => {}, log: () => {},
    pause: async delay => waits.push(delay),
    createTransport: async () => ({ fetchHistory: async id => {
      calls.push(id);
      return { status: calls.length === 2 || id === 3 ? 403 : 200, body: { count: 0 } };
    }, close: async () => { closed++; } }),
  }), /HTTP 403/);
  assert.deepEqual(calls, [1, 2, 2, 3]);
  assert.deepEqual(waits, [1800000]);
  assert.equal(closed, 1);
  assert.equal(store.db.prepare('SELECT status FROM volume_runs').get().status, 'failed');
  assert.equal(store.db.prepare("SELECT count(*) n FROM volume_jobs WHERE status='empty'").get().n, 2);
  assert.equal(store.db.prepare("SELECT status FROM volume_jobs WHERE product_id=3").get().status, 'failed');
});
