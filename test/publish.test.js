import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Store, retainVolumeRunScopes } from '../src/store.js';
import { saveMonthHistory, syncVolume } from '../src/volume.js';
import { fetchHistoryExport } from '../src/import-history.js';
import { exportSnapshot, checkFreshness, checkCompleteSweep, checkCompleteDatabase,
  needsDailyCollection, publishGitHub, uploadReleaseAssets, updateReadmeLeaderboard, verifiedReportingDates,
  checkReportDatabase, plannedCollectionDate, nextCollectionContinuation, checkCollectionHealth } from '../src/publish.js';

test('bounded runs finish an overnight queue before opening a new daily sweep', () => {
  const now = new Date('2026-11-26T00:15:00Z');
  for (const status of ['paused', 'running', 'partial', 'failed']) {
    assert.equal(plannedCollectionDate({ sweep: { date_utc: '2026-11-25', status } }, now), '2026-11-25');
    assert.equal(plannedCollectionDate({ sweep: { date_utc: '2026-11-26', status } }, now), '2026-11-26');
    assert.equal(plannedCollectionDate({ sweep: { date_utc: '2026-11-24', status } }, now), '2026-11-24');
  }
  for (const sweep of [undefined, { date_utc: '2026-11-25', status: 'complete' },
    { date_utc: '2026-10-01', status: 'paused' }, { date_utc: '2026-11-27', status: 'paused' }]) {
    assert.equal(plannedCollectionDate({ sweep }, now), '2026-11-26');
  }
});

test('bounded continuations stop on completion, failures, no progress, or exhausted budgets', () => {
  const now = new Date('2026-11-28T00:15:00Z');
  const before = { date_utc: '2026-11-27', products_checked: 12000 };
  const coverage = { source: 'tcgplayer-daily', sku_buckets: 30,
    generated_at: now.toISOString(), last_successful_check_at: now.toISOString(),
    sweep: { ...before, status: 'paused', products_checked: 18000,
      products_expected: 64000, products_failed: 0 } };
  assert.equal(nextCollectionContinuation(before, coverage, 12, now), 11);
  assert.equal(nextCollectionContinuation(before, coverage, 1, now), 0);
  assert.equal(nextCollectionContinuation(before, coverage, 0, now), null);
  for (const change of [{ status: 'complete' }, { status: 'failed' }, { products_failed: 1 },
    { products_checked: 12000 }, { products_checked: 11999 }, { products_checked: 64000 },
    { date_utc: '2026-11-28' }]) {
    assert.equal(nextCollectionContinuation(before, { ...coverage,
      sweep: { ...coverage.sweep, ...change } }, 12, now), null);
  }
  for (const budget of [-1, 13, NaN, 1.5]) {
    assert.throws(() => nextCollectionContinuation(before, coverage, budget, now), /budget/);
  }
});

test('health checks accept honest overnight progress but reject stalled or stale chart coverage', () => {
  const now = new Date('2026-11-28T00:15:00Z');
  const coverage = { source: 'tcgplayer-daily', sku_buckets: 30,
    generated_at: now.toISOString(), last_successful_check_at: '2026-11-27T22:30:00Z',
    reporting_dates: ['2026-11-24','2026-11-25'],
    sweep: { date_utc: '2026-11-27', status: 'paused', products_expected: 64000,
      products_checked: 18000, products_with_history: 17000,
      products_without_history: 1000, products_failed: 0 } };
  assert.equal(checkCollectionHealth(coverage, now).complete_sweep, false);
  assert.equal(checkCollectionHealth(coverage, now).last_verified_date, '2026-11-25');
  assert.throws(() => checkCompleteSweep(coverage, now), /incomplete/);
  for (const change of [{ status: 'failed' }, { products_failed: 1 }, { products_checked: 0 },
    { date_utc: '2026-11-25' }, { products_with_history: 16000 }]) {
    assert.throws(() => checkCollectionHealth({ ...coverage,
      sweep: { ...coverage.sweep, ...change } }, now), /stalled/);
  }
  assert.throws(() => checkCollectionHealth({ ...coverage,
    last_successful_check_at: '2026-11-27T18:00:00Z' }, now), /stalled/);
  assert.equal(checkCollectionHealth({ ...coverage, catalog_products: 64000,
    last_successful_check_at: '2026-11-27T12:00:00Z',
    reporting_dates: ['2026-11-26'], sweep: { ...coverage.sweep, status: 'complete',
      products_checked: 64000, products_with_history: 63000 } }, now).complete_sweep, true);
  for (const reporting_dates of [[], ['2026-11-24'], ['2026-11-28']]) {
    assert.throws(() => checkCollectionHealth({ ...coverage, reporting_dates }, now), /chart coverage/);
  }
});

test('retired queue jobs do not revoke reporting dates certified against the completed catalog', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (let id = 1; id <= 2; id++) store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,'Set','Charizard','','','','','["Charizard"]','','build',1)`).run(id);
  const now = new Date('2026-11-25T12:00:00Z');
  const options = { now: () => now, pause: async () => {}, log: () => {},
    fetchHistory: async id => ({ status: 200, body: id !== 1 ? { count: 0 } : {
      count: 1, result: [{ skuId: 101, condition: 'Near Mint', variant: 'Normal', language: 'English',
        buckets: Array.from({ length: 30 }, (_, index) => ({
          bucketStartDate: new Date(now - index * 86400000).toISOString().slice(0,10),
          quantitySold: 1, transactionCount: 1,
        })),
      }],
    } }),
  };
  await syncVolume(store, { ...options, limit: 1 });
  store.db.exec(`UPDATE catalog_products SET is_current=0 WHERE product_id=2;
    INSERT INTO catalog_products VALUES
    (3,3,604,'Set','Charizard','','','','','["Charizard"]','','build-2',1)`);
  await syncVolume(store, options);
  assert.equal(store.db.prepare('SELECT products_expected FROM volume_runs').get().products_expected, 2);
  assert.equal(store.db.prepare('SELECT count(*) n FROM volume_jobs').get().n, 3);
  assert.ok(verifiedReportingDates(store.db, '2026-11-25').includes('2026-11-24'));
  store.db.exec('DELETE FROM volume_run_products');
  assert.ok(verifiedReportingDates(store.db, '2026-11-25').includes('2026-11-24'));
  retainVolumeRunScopes(store.db);
  assert.deepEqual(JSON.parse(store.db.prepare('SELECT product_ids FROM volume_run_products').get().product_ids), [1,3]);
  store.db.exec(`UPDATE catalog_products SET is_current=0 WHERE product_id=3;
    INSERT INTO catalog_products VALUES
    (4,3,604,'Set','Charizard','','','','','["Charizard"]','','build-3',1)`);
  assert.ok(verifiedReportingDates(store.db, '2026-11-26').includes('2026-11-24'));
  store.db.prepare('UPDATE daily_volume SET last_seen=? WHERE date_source=?')
    .run('2026-11-20T00:00:00.000Z','2026-11-24');
  assert.ok(!verifiedReportingDates(store.db, '2026-11-26').includes('2026-11-24'));
  assert.ok(verifiedReportingDates(store.db, '2026-11-26').includes('2026-11-23'));
  store.db.prepare('UPDATE volume_run_products SET product_ids=?').run('[1,1]');
  assert.ok(!verifiedReportingDates(store.db, '2026-11-26').includes('2026-11-23'));
});

test('release uploads retry transient failures per asset without replaying successful uploads', async () => {
  const calls = [], waits = [];
  let failures = 0;
  await uploadReleaseAssets(['first.csv', 'second.csv'], {
    run: args => {
      const path = args.at(-1);
      calls.push(path);
      if (path === 'second.csv' && failures++ < 2) {
        throw Object.assign(new Error('gh failed'), { stderr: Buffer.from('HTTP 500 (upload)') });
      }
    }, pause: async delay => waits.push(delay),
  });
  assert.deepEqual(calls, ['first.csv', 'second.csv', 'second.csv', 'second.csv']);
  assert.deepEqual(waits, [5000, 15000]);
});

test('release uploads stop on permanent errors or exhausted transient retries', async () => {
  for (const [status, expected] of [ [403, 1], [500, 3] ]) {
    let calls = 0;
    await assert.rejects(uploadReleaseAssets(['first.csv', 'never.csv'], {
      run: () => { calls++; throw Object.assign(new Error('gh failed'), { stderr: `HTTP ${status}` }); },
      pause: async () => {},
    }), /gh failed/);
    assert.equal(calls, expected);
  }
});

const readmeWithLeaderboard = `# Existing heading

<!-- BEGIN POKEMON LEADERBOARD -->
Old leaderboard
<!-- END POKEMON LEADERBOARD -->

Footer
`;

test('README leaderboard limits rows to ten and skips the newest source day', () => {
  const date_source = '2026-11-17';
  const latest = '2026-11-18';
  const daily = [{ date_source: latest }, { date_source }, { date_source: '2026-11-16' }];
  const pokemon = [
    { date_source: latest, pokemon_key: 'newest', pokemon: 'Newest', units: 9999, sale_records: 9999 },
    ...Array.from({ length: 11 }, (_, i) => ({
      date_source, pokemon_key: `species-${i}`, pokemon: `Species ${i}`, units: 100 - i, sale_records: i + 1,
    })).reverse(),
    { date_source, pokemon_key: 'a', pokemon: 'A | B', units: 100, sale_records: 2 },
  ];
  const readme = updateReadmeLeaderboard(readmeWithLeaderboard, daily, pokemon, [date_source]);
  assert.match(readme, /\*\*2026-11-17\*\*/);
  assert.match(readme, /\| 1 \| A &#124; B \| 100 \| 2 \|/);
  assert.match(readme, /\| 2 \| Species 0 \| 100 \| 1 \|/);
  assert.match(readme, /\| 10 \| Species 8 \| 92 \| 9 \|/);
  assert.doesNotMatch(readme, /Newest|Species 9|Old leaderboard/);
  assert.match(readme, /^# Existing heading/);
  assert.match(readme, /\nFooter\n$/);
  assert.equal(updateReadmeLeaderboard(readme, daily, pokemon, [date_source]), readme);
});

test('README does not present preliminary or unavailable Pokemon sales as zero', () => {
  const date_source = '2026-11-17';
  assert.match(updateReadmeLeaderboard(readmeWithLeaderboard, [{ date_source }], [], []),
    /No source day with a verified catalog sweep/);
  const pokemon = [{ date_source, pokemon: 'Zero', pokemon_key: 'zero', units: 0, sale_records: 0 }];
  assert.match(updateReadmeLeaderboard(readmeWithLeaderboard, [{ date_source }], pokemon, [date_source]),
    /No mapped Pokemon sales were reported for this day/);
  assert.throws(() => updateReadmeLeaderboard('# Missing markers\n', [], [], []),
    /Invalid README leaderboard markers/);
});

test('scheduled catch-up skips only a fresh complete sweep of the current source catalog', async () => {
  const now = new Date('2026-11-17T18:00:00Z');
  const complete = { source: 'tcgplayer-daily', sku_buckets: 30, catalog_products: 10,
    catalog_source_build: 'build-1', generated_at: now.toISOString(),
    reporting_dates: ['2026-11-16'],
    last_successful_check_at: now.toISOString(),
    sweep: { date_utc: '2026-11-17', status: 'complete', products_expected: 10,
      products_checked: 10, products_with_history: 7, products_without_history: 3, products_failed: 0 } };
  const current = { now, fetcher: async () => ({ ok: true, text: async () => 'build-1\n' }) };
  assert.equal(await needsDailyCollection(complete,current),false);
  const afterMidnight = new Date('2026-11-18T00:01:00Z');
  assert.equal(await needsDailyCollection(complete,{ ...current, now: afterMidnight, date: '2026-11-17' }),false);
  assert.equal(await needsDailyCollection(complete,{ ...current, now: afterMidnight }),true);
  assert.equal(await needsDailyCollection(complete,{ now,
    fetcher: async () => ({ ok: true, text: async () => 'build-2' }) }),true);
  assert.equal(await needsDailyCollection({ ...complete, catalog_source_build: null },current),true);
  const noFetch = { now, fetcher: async () => { throw new Error('Incomplete data must be resumed'); } };
  assert.equal(await needsDailyCollection({ ...complete, reporting_dates: [] }, noFetch),true);
  for (const change of [{ status: 'paused' }, { products_checked: 9 }, { products_failed: 1 },
    { date_utc: '2026-11-16' }]) {
    assert.equal(await needsDailyCollection({ ...complete, sweep: { ...complete.sweep, ...change } },noFetch),true);
  }
  assert.equal(await needsDailyCollection({ ...complete, generated_at: '2026-11-15T00:00:00Z' },noFetch),true);
  await assert.rejects(needsDailyCollection(complete,{ now,
    fetcher: async () => ({ ok: false, status: 503 }) }),error => error.status === 503);
  await assert.rejects(needsDailyCollection(complete,{ now,
    fetcher: async () => ({ ok: true, text: async () => '' }) }),/Invalid catalog build/);
});

test('all-product verification rejects fresh but incomplete, failed, stale-date and inconsistent sweeps', () => {
  const now = new Date('2026-11-16T18:00:00Z');
  const complete = { source: 'tcgplayer-daily', sku_buckets: 30, catalog_products: 10,
    generated_at: now.toISOString(), last_successful_check_at: now.toISOString(),
    sweep: { date_utc: '2026-11-16', status: 'complete', products_expected: 10,
      products_checked: 10, products_with_history: 7, products_without_history: 3, products_failed: 0 } };
  assert.doesNotThrow(() => checkCompleteSweep(complete, now));
  for (const change of [{ status: 'failed' }, { status: 'paused' }, { products_checked: 9 },
    { products_failed: 1 }, { products_expected: 9 }, { products_with_history: 6 },
    { date_utc: '2026-11-15' }]) {
    assert.throws(() => checkCompleteSweep({ ...complete, sweep: { ...complete.sweep, ...change } }, now),
      /incomplete or failed/);
  }
  assert.throws(() => checkCompleteSweep({ ...complete, catalog_products: 0,
    sweep: { ...complete.sweep, products_expected: 0, products_checked: 0,
      products_with_history: 0, products_without_history: 0 } },now),/incomplete or failed/);
  assert.throws(() => checkCompleteSweep({ ...complete,
    sweep: { ...complete.sweep, status: 'paused', products_checked: 9 } },now),
  /9\/10 products checked; 0 failed; queue 2026-11-16 is paused/);
});

test('freshness and complete-sweep CLI checks work without installed rendering dependencies', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(),'pokemon-check-no-dependencies-')));
  t.after(() => rmSync(directory,{ recursive: true, force: true }));
  mkdirSync(join(directory,'src'));
  writeFileSync(join(directory,'package.json'),'{"type":"module"}');
  for (const name of ['publish.js','store.js','figures.js','sales-figure.js','catalog.js']) {
    copyFileSync(new URL(`../src/${name}`,import.meta.url),join(directory,'src',name));
  }
  const now = new Date().toISOString();
  const path = join(directory,'coverage.json');
  writeFileSync(path,JSON.stringify({
    source: 'tcgplayer-daily', generated_at: now, last_successful_check_at: now,
    sku_buckets: 30, catalog_products: 1,
    sweep: { date_utc: now.slice(0,10), status: 'complete', products_expected: 1,
      products_checked: 1, products_with_history: 1, products_without_history: 0, products_failed: 0 },
  }));
  for (const flag of ['--check','--complete']) {
    assert.match(execFileSync(process.execPath,[join(directory,'src/publish.js'),flag,path],
      { encoding: 'utf8' }),/passed its checks/);
  }
  assert.equal(execFileSync(process.execPath,
    [join(directory,'src/publish.js'),'--needs-collection',path],{ encoding: 'utf8' }).trim(),'true');
});

test('complete checkpoint verification checks every product and its saved rows, not just coverage counts', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(),'pokemon-checkpoint-complete-')));
  const path = join(directory,'public.sqlite'), store = new Store(path);
  t.after(() => { store.close(); rmSync(directory,{ recursive: true }); });
  for (let id = 1; id <= 4; id++) store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,'Set','Charizard','','','','','["Charizard"]','','build',?)`).run(id,id === 4 ? 0 : 1);
  store.db.prepare(`INSERT INTO catalog_runs(source_build,started_at,status)
    VALUES ('build',?,'complete')`).run(new Date().toISOString());
  const now = new Date();
  await syncVolume(store,{ pause: async () => {}, log: () => {}, now: () => now,
    fetchHistory: async id => ({ status: 200, body: id === 3 ? { count: 0 } : {
      count: 1, result: [{ skuId: 100 + id, condition: 'Near Mint', variant: 'Normal',
        language: 'English', buckets: Array.from({ length: 30 },(_,index) => ({
          bucketStartDate: new Date(now - index * 86400000).toISOString().slice(0,10),
          quantitySold: index === 0 ? 2 : 0, transactionCount: index === 0 ? 1 : 0,
          lowSalePrice: '10', highSalePrice: '12',
        })) }],
    } }),
  });
  store.db.prepare(`INSERT INTO volume_jobs(date_utc,product_id,status,attempts)
    VALUES (?,4,'failed',3)`).run(now.toISOString().slice(0,10));
  const coverage = {
    source: 'tcgplayer-daily', generated_at: now.toISOString(), last_successful_check_at: now.toISOString(),
    sku_buckets: 60, units: 4, transactions: 2, catalog_products: 3, catalog_source_build: 'build',
    sweep: { ...store.db.prepare('SELECT * FROM volume_runs').get() },
  };
  delete coverage.sweep.warning;
  const valid = checkCompleteDatabase(store.db,coverage,now);
  assert.equal(valid.products_checked,3);
  assert.equal(valid.products_without_history,1);
  assert.equal(valid.inconsistent_products,0);
  assert.throws(() => checkCompleteDatabase(store.db, { ...coverage, reporting_dates: [] }, now),
    /lacks verified reporting coverage/);
  const nextDay = new Date(now.getTime() + 86400000);
  assert.throws(() => checkCompleteDatabase(store.db,coverage,nextDay), /incomplete or failed/);
  assert.equal(checkCompleteDatabase(store.db,coverage,nextDay,now.toISOString().slice(0,10))
    .inconsistent_products,0);
  const coveragePath = join(directory,'coverage.json');
  writeFileSync(coveragePath,JSON.stringify(coverage));
  assert.match(execFileSync(process.execPath,[
    fileURLToPath(new URL('../src/publish.js',import.meta.url)),'--complete',coveragePath,path,
  ],{ encoding: 'utf8' }),/"inconsistent_products":0/);
  for (const [sql, message] of [
    ["DELETE FROM volume_jobs WHERE product_id=2", /Not every current catalog product/],
    ["UPDATE volume_jobs SET status='pending' WHERE product_id=2", /Not every current catalog product/],
    ["UPDATE volume_jobs SET fetched_at='2000-01-01T00:00:00.000Z' WHERE product_id=2", /fresh saved history/],
    ["DELETE FROM price_checks WHERE product_id=3", /fresh saved history/],
    ["DELETE FROM daily_sale_prices WHERE product_id=2; DELETE FROM daily_volume WHERE product_id=2", /fresh saved history/],
    ["DELETE FROM daily_sale_prices WHERE product_id=2", /fresh saved history/],
    ["PRAGMA defer_foreign_keys=ON; UPDATE daily_volume SET date_source=date(date_source,'-30 days') WHERE product_id=2 AND date_source=(SELECT date_utc FROM volume_runs); UPDATE daily_sale_prices SET date_source=date(date_source,'-30 days') WHERE product_id=2 AND date_source=(SELECT date_utc FROM volume_runs)", /fresh saved history/],
    ["UPDATE daily_volume SET quantity=quantity+1 WHERE product_id=2", /daily totals/],
    ["UPDATE catalog_runs SET source_build='other'", /catalog build/],
    ["UPDATE volume_runs SET products_checked=2", /saved catalog sweep/],
  ]) {
    store.db.exec('SAVEPOINT mutation');
    try {
      store.db.exec(sql);
      assert.throws(() => checkCompleteDatabase(store.db,coverage,now),message);
    } finally { store.db.exec('ROLLBACK TO mutation; RELEASE mutation'); }
  }
  store.db.exec('DELETE FROM volume_jobs WHERE product_id=2');
  assert.throws(() => execFileSync(process.execPath,[
    fileURLToPath(new URL('../src/publish.js',import.meta.url)),'--complete',coveragePath,path,
  ],{ encoding: 'utf8', stdio: 'pipe' }),/Not every current catalog product/);
});

test('published reports and complete compressed downloads retain corrected counts and zero buckets', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pokemon-publish-'));
  const store = new Store(':memory:');
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  store.db.prepare(`INSERT INTO catalog_products VALUES
    (1,3,604,'Fixture set','Charizard','','','','','["Charizard"]','','build',1)`).run();
  store.db.exec(`INSERT INTO catalog_runs(source_build,started_at,status) VALUES
    ('build-complete','2026-11-01T10:00:00Z','complete'),
    ('build-incomplete','2026-11-01T11:00:00Z','running')`);
  const now = new Date('2026-11-01T12:00:00Z');
  const payload = { count: 1, result: [{ skuId: '101', condition: 'Near Mint',
    variant: 'Holofoil', language: 'English', buckets: Array.from({ length: 30 }, (_, index) => ({
      bucketStartDate: new Date(Date.UTC(2026, 9, 31 - index)).toISOString().slice(0, 10),
      quantitySold: index === 0 ? 8 : 0, transactionCount: index === 0 ? 5 : 0,
      lowSalePrice: index === 0 ? '10' : null, highSalePrice: index === 0 ? '12' : null,
    })) }] };
  saveMonthHistory(store, 1, payload, now.toISOString());
  payload.result[0].buckets[0].quantitySold = 3;
  saveMonthHistory(store, 1, payload, now.toISOString());
  const coverage = await exportSnapshot(store, directory, now);
  assert.equal(coverage.catalog_source_build,'build-complete');
  assert.equal(coverage.units, 3);
  assert.equal(coverage.sku_buckets, 30);
  assert.equal(coverage.sales_usd, null);
  assert.equal(coverage.price_volume.sales_lower_usd,30);
  assert.equal(coverage.price_volume.sales_upper_usd,36);
  assert.equal(coverage.price_volume.unpriced_units,0);
  assert.ok(readFileSync(join(directory,'daily-sales-value.csv'),'utf8')
    .includes('"3","3","0","30","36","30","36",""'));
  const sku = gunzipSync(readFileSync(join(directory, 'daily-sku-volume.csv.gz'))).toString();
  assert.equal(sku.trimEnd().split('\n').length, 31);
  assert.ok(sku.includes('"tcgplayer-daily","1","Charizard","single"'));
  assert.ok(sku.includes('"low_sale_price_usd"'));
  assert.equal(gunzipSync(readFileSync(join(directory, 'pokemon-product-catalog.csv.gz')))
    .toString().trimEnd().split('\n').length, 2);
  assert.ok(readFileSync(join(directory, 'pokemon-daily.csv'), 'utf8')
    .includes('"2026-10-31","charizard","Charizard","5","3","","1"'));
  assert.ok(readFileSync(join(directory, 'product-volume.csv'), 'utf8').includes('"1","Charizard","3","5"'));
  const productDays = gunzipSync(readFileSync(join(directory, 'product-daily-trading.csv.gz'))).toString();
  assert.equal(productDays.trimEnd().split('\n').length, 31);
  assert.ok(productDays.includes(
    '"2026-10-31","1","Charizard","3","604","Fixture set","5","3","3","0","30","36","30","36",""'));
  const setDays = readFileSync(join(directory, 'set-daily-trading.csv'), 'utf8');
  assert.equal(setDays.trimEnd().split('\n').length, 31);
  assert.ok(setDays.includes('"2026-10-31","3","604","Fixture set","5","3","3","0","30","36","30","36",""'));
  assert.ok(readFileSync(join(directory, 'pokemon-sales-value.csv'), 'utf8')
    .includes('"2026-10-31","charizard","Charizard","5","3","3","0","30","36","30","36",""'));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM daily_volume').get().n, 30);
  assert.ok(readFileSync(join(directory, 'volume.svg'), 'utf8')
    .includes('No source dates with a verified catalog sweep'));
  assert.ok(coverage.downloads.includes('volume.svg'));
  assert.ok(coverage.downloads.includes('daily-trading.csv'));
  assert.ok(coverage.downloads.includes('product-daily-trading.csv.gz'));
  assert.ok(coverage.downloads.includes('set-daily-trading.csv'));
  for (const name of ['sales-value.svg','sales-value.png','sales-value-moe.svg',
    'sales-value-moe.png','sales-value.csv','sales-value.json']) {
    assert.ok(coverage.downloads.includes(name));
    assert.ok(readFileSync(join(directory,name)).length > 0);
  }
  const [header, ...trading] = readFileSync(join(directory, 'daily-trading.csv'), 'utf8')
    .trimEnd().split(/\r?\n/).map(line => line.split(',').map(cell => JSON.parse(cell)));
  assert.equal(trading.length, 30);
  const lastDay = Object.fromEntries(header.map((key, index) => [key, trading.at(-1)[index]]));
  assert.equal(lastDay.date_source, '2026-10-31');
  assert.equal(lastDay.units, '3');
  assert.equal(lastDay.sale_records, '5');
  assert.equal(lastDay.priced_units, '3');
  assert.equal(lastDay.priced_sales_lower_usd, '30');
  assert.equal(lastDay.priced_sales_upper_usd, '36');
  assert.equal(lastDay.sales_usd, '');
});

test('a bounded partial batch publishes reconciled reports without claiming a complete sweep', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pokemon-partial-report-'));
  const store = new Store(':memory:');
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  for (let id = 1; id <= 2; id++) store.db.prepare(`INSERT INTO catalog_products VALUES
    (?,3,604,'Set','Charizard','','','','','["Charizard"]','','build',1)`).run(id);
  const now = new Date('2026-11-26T12:00:00Z');
  await syncVolume(store, { limit: 1, now: () => now, pause: async () => {}, log: () => {},
    fetchHistory: async () => ({ status: 200, body: { count: 1, result: [{ skuId: 101,
      condition: 'Near Mint', variant: 'Normal', language: 'English',
      buckets: Array.from({ length: 30 }, (_, index) => ({
        bucketStartDate: new Date(now - index * 86400000).toISOString().slice(0,10),
        quantitySold: 1, transactionCount: 1,
      })),
    }] } }),
  });
  const coverage = await exportSnapshot(store, directory, now);
  assert.deepEqual(checkReportDatabase(store.db, coverage, now), {
    status: 'paused', products_checked: 1, products_expected: 2, reporting_dates: [],
  });
  assert.throws(() => checkCompleteSweep(coverage, now), /incomplete or failed/);
  assert.throws(() => checkReportDatabase(store.db, { ...coverage, units: 999 }, now), /units does not match/);
  assert.throws(() => checkReportDatabase(store.db, { ...coverage, reporting_dates: ['2026-11-25'] }, now),
    /reporting dates do not match/);
  assert.throws(() => checkReportDatabase(store.db, {
    ...coverage, sweep: { ...coverage.sweep, status: 'complete' },
  }, now), /does not match the saved catalog sweep/);
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
  assert.throws(() => checkFreshness({ ...coverage, generated_at: '2026-10-31T09:00:00Z',
    last_successful_check_at: now.toISOString() }, now), /generated_at/);
  assert.doesNotThrow(() => checkFreshness({ ...coverage, generated_at: '2026-10-31T11:00:00Z',
    last_successful_check_at: now.toISOString() }, now));
  assert.doesNotThrow(() => checkFreshness({ ...coverage, last_successful_check_at: now.toISOString() }, now));
});

test('authorized export publishes a verified checkpoint and preserves concurrent main commits', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pokemon-publish-main-'));
  const originalEnvironment = { ...process.env };
  t.after(() => {
    process.env = originalEnvironment;
    rmSync(directory, { recursive: true });
  });
  const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const source = join(directory, 'source');
  const remote = join(directory, 'remote.git');
  git(['init', '--initial-branch=main', source]);
  git(['-C', source, 'config', 'user.name', 'Fixture']);
  git(['-C', source, 'config', 'user.email', 'fixture@example.test']);
  writeFileSync(join(source, 'app.txt'), 'Existing application code\n');
  writeFileSync(join(source, 'README.md'), readmeWithLeaderboard);
  git(['-C', source, 'add', '.']);
  git(['-C', source, 'commit', '-m', 'Initial application']);
  git(['clone', '--bare', source, remote]);
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(remote).href}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/hanshanley/pokemon-tcg.git';
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.TEST_PUBLICATION_SOURCE = source;
  process.env.TEST_PUBLICATION_REMOTE = remote;
  process.env.TEST_PUBLICATION_ASSETS = join(directory, 'assets.json');
  process.env.TEST_PUBLICATION_CHECKPOINT = join(directory, 'checkpoint.sqlite');
  process.env.PATH = `${directory}:${process.env.PATH}`;
  writeFileSync(join(directory, 'gh'), `#!/usr/bin/env node
const {appendFileSync,readFileSync,writeFileSync} = require('node:fs');
const {execFileSync} = require('node:child_process');
const {gunzipSync} = require('node:zlib');
if (process.argv[2] === 'release' && process.argv[3] === 'upload') {
  let uploaded = [];
  try { uploaded = JSON.parse(readFileSync(process.env.TEST_PUBLICATION_ASSETS)); } catch {}
  writeFileSync(process.env.TEST_PUBLICATION_ASSETS, JSON.stringify([...uploaded, ...process.argv.slice(4)]));
  const checkpoint = process.argv.find(arg => arg.endsWith('/remote-state.sqlite.gz'));
  if (checkpoint) writeFileSync(process.env.TEST_PUBLICATION_CHECKPOINT, gunzipSync(readFileSync(checkpoint)));
}
if (process.argv[2] === 'release' && process.argv[3] === 'edit') {
  const source = process.env.TEST_PUBLICATION_SOURCE;
  const git = args => execFileSync('git', ['-C', source, ...args]);
  writeFileSync(source + '/concurrent.txt', 'Concurrent application update\\n');
  appendFileSync(source + '/README.md', '\\nConcurrent README edit\\n');
  git(['add', '.']);
  git(['commit', '-m', 'Concurrent application update']);
  git(['push', process.env.TEST_PUBLICATION_REMOTE, 'main']);
}
`, { mode: 0o755 });
  const data = join(directory, 'data');
  const store = new Store(join(data, 'sales.sqlite'));
  try {
    store.db.prepare(`INSERT INTO catalog_products VALUES
      (1,3,604,'Fixture set','Charizard','','','','','["Charizard"]','','build',1)`).run();
    const now = new Date();
    const stamp = now.toISOString();
    const payload = { count: 1, result: [{ skuId: '101',
      condition: 'Near Mint', variant: 'Holofoil', language: 'English',
      buckets: Array.from({ length: 30 }, (_, index) => ({
        bucketStartDate: new Date(now - index * 86400000).toISOString().slice(0, 10),
        quantitySold: index === 0 ? 3 : index === 1 ? 2 : 0,
        transactionCount: index === 0 ? 2 : index === 1 ? 1 : 0,
      })) }] };
    const queue = now.toISOString().slice(0, 10);
    store.db.prepare(`INSERT INTO catalog_runs (source_build,started_at,finished_at,status)
      VALUES ('build',?,?,'complete')`).run(stamp, stamp);
    const rows = [
      { format: 'tcgplayer-sku-history-v1', source: 'tcgplayer-daily', observed_at: stamp,
        catalog_source_build: 'build', products_expected: 1 },
      { product_id: 1, history: payload },
    ];
    await fetchHistoryExport(store, 'https://exports.example.test/pokemon.jsonl', {
      now: () => now, fetcher: async () => new Response(rows.map(r => JSON.stringify(r)).join('\n')),
    });
    const checkStored = () => execFileSync(process.execPath, [
      fileURLToPath(new URL('../src/publish.js', import.meta.url)), '--check-stored', join(data, 'sales.sqlite'),
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(JSON.parse(checkStored()).products_checked, 1);
    store.db.prepare('UPDATE volume_jobs SET buckets=0').run();
    assert.throws(checkStored, /lack matching fresh saved history and price checks/);
    store.db.prepare('UPDATE volume_jobs SET buckets=30').run();
    const closedDates = Array.from({length: 29}, (_, i) =>
      new Date(Date.parse(queue) - (29 - i) * 86400000).toISOString().slice(0, 10));
    const eligible = closedDates.at(-1);
    assert.deepEqual(verifiedReportingDates(store.db, queue), closedDates);
    store.db.exec('SAVEPOINT missing_historical_day');
    store.db.prepare('UPDATE daily_volume SET last_seen=? WHERE date_source=?')
      .run(`${closedDates[0]}T23:59:59.999Z`, closedDates[0]);
    assert.deepEqual(verifiedReportingDates(store.db, queue), closedDates.slice(1));
    store.db.exec('ROLLBACK TO missing_historical_day; RELEASE missing_historical_day');
    store.db.exec('SAVEPOINT incomplete_fixture');
    store.db.prepare('UPDATE volume_runs SET status=? WHERE date_utc=?').run('paused', queue);
    assert.deepEqual(verifiedReportingDates(store.db, queue), []);
    store.db.exec('ROLLBACK TO incomplete_fixture');
    store.db.prepare('UPDATE volume_jobs SET fetched_at=?').run(new Date(now.getTime() + 1).toISOString());
    assert.deepEqual(verifiedReportingDates(store.db, queue), []);
    store.db.exec('ROLLBACK TO incomplete_fixture');
    store.db.prepare('UPDATE daily_volume SET last_seen=? WHERE date_source=?')
      .run(`${eligible}T23:59:59.999Z`, queue);
    assert.deepEqual(verifiedReportingDates(store.db, queue), []);
    store.db.exec('ROLLBACK TO incomplete_fixture; RELEASE incomplete_fixture');
  } finally { store.close(); }
  const coverage = await publishGitHub(data, { fromExport: true });
  assert.equal(coverage.units, 5);
  assert.equal(git(['--git-dir', remote, 'for-each-ref', '--format=%(refname)', 'refs/heads']), 'refs/heads/main');
  assert.equal(git(['--git-dir', remote, 'show', 'main:app.txt']), 'Existing application code');
  assert.equal(git(['--git-dir', remote, 'show', 'main:concurrent.txt']), 'Concurrent application update');
  const published = JSON.parse(git(['--git-dir', remote, 'show', 'main:reports/latest/coverage.json']));
  assert.equal(published.units, 5);
  assert.equal(published.sku_buckets, 30);
  const checkpoint = new Store(process.env.TEST_PUBLICATION_CHECKPOINT);
  try { assert.equal(checkCompleteDatabase(checkpoint.db, published).products_checked, 1); }
  finally { checkpoint.close(); }
  const readme = git(['--git-dir', remote, 'show', 'main:README.md']);
  assert.ok(readme.includes(`**${new Date(Date.parse(published.last_source_date) - 86400000)
    .toISOString().slice(0, 10)}**`));
  assert.ok(readme.includes('| 1 | Charizard | 2 | 1 |'));
  assert.ok(readme.endsWith('Concurrent README edit'));
  assert.ok(git(['--git-dir', remote, 'show', 'main:reports/latest/volume.svg'])
    .includes('2 observed units and 1 reported transactions on verified-sweep dates'));
  assert.equal(git(['--git-dir', remote, 'show', 'main:reports/latest/daily-trading.csv'])
    .trimEnd().split(/\r?\n/).length, 31);
  assert.equal(git(['--git-dir', remote, 'show', 'main:reports/latest/set-daily-trading.csv'])
    .trimEnd().split(/\r?\n/).length, 31);
  assert.ok(JSON.parse(readFileSync(process.env.TEST_PUBLICATION_ASSETS, 'utf8'))
    .some(path => path.endsWith('/product-daily-trading.csv.gz')));
  const assets = JSON.parse(readFileSync(process.env.TEST_PUBLICATION_ASSETS,'utf8'));
  const tracked = git(['--git-dir',remote,'ls-tree','-r','--name-only','main']).split('\n');
  for (const name of ['sales-value.svg','sales-value.png','sales-value-moe.svg',
    'sales-value-moe.png','sales-value.csv','sales-value.json']) {
    assert.ok(assets.some(path => path.endsWith(`/${name}`)));
    assert.ok(tracked.includes(`reports/latest/${name}`));
  }
  assert.ok(!git(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main'])
    .includes('product-daily-trading.csv.gz'));
});
