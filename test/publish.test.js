import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Store } from '../src/store.js';
import { saveMonthHistory, syncVolume } from '../src/volume.js';
import { exportSnapshot, checkFreshness, checkCompleteSweep, checkCompleteDatabase,
  needsDailyCollection, publishGitHub } from '../src/publish.js';

test('scheduled catch-up skips only a fresh complete sweep of the current source catalog', async () => {
  const now = new Date('2026-11-17T18:00:00Z');
  const complete = { source: 'tcgplayer-daily', sku_buckets: 30, catalog_products: 10,
    catalog_source_build: 'build-1', generated_at: now.toISOString(),
    last_successful_check_at: now.toISOString(),
    sweep: { date_utc: '2026-11-17', status: 'complete', products_expected: 10,
      products_checked: 10, products_with_history: 7, products_without_history: 3, products_failed: 0 } };
  const current = { now, fetcher: async () => ({ ok: true, text: async () => 'build-1\n' }) };
  assert.equal(await needsDailyCollection(complete,current),false);
  assert.equal(await needsDailyCollection(complete,{ now,
    fetcher: async () => ({ ok: true, text: async () => 'build-2' }) }),true);
  assert.equal(await needsDailyCollection({ ...complete, catalog_source_build: null },current),true);
  const noFetch = { now, fetcher: async () => { throw new Error('Incomplete data must be resumed'); } };
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
    .includes('3 observed units and 5 reported transactions. Priced subset: $30 to $36'));
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

test('publishing keeps main as the only branch and preserves concurrent code commits', async t => {
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
  process.env.PATH = `${directory}:${process.env.PATH}`;
  writeFileSync(join(directory, 'gh'), `#!/usr/bin/env node
const {writeFileSync} = require('node:fs');
const {execFileSync} = require('node:child_process');
if (process.argv[2] === 'release' && process.argv[3] === 'upload') {
  writeFileSync(process.env.TEST_PUBLICATION_ASSETS, JSON.stringify(process.argv.slice(4)));
}
if (process.argv[2] === 'release' && process.argv[3] === 'edit') {
  const source = process.env.TEST_PUBLICATION_SOURCE;
  const git = args => execFileSync('git', ['-C', source, ...args]);
  writeFileSync(source + '/concurrent.txt', 'Concurrent application update\\n');
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
    saveMonthHistory(store, 1, { count: 1, result: [{ skuId: '101',
      condition: 'Near Mint', variant: 'Holofoil', language: 'English',
      buckets: Array.from({ length: 30 }, (_, index) => ({
        bucketStartDate: new Date(now - index * 86400000).toISOString().slice(0, 10),
        quantitySold: index === 0 ? 3 : 0, transactionCount: index === 0 ? 2 : 0,
      })) }] }, now.toISOString());
  } finally { store.close(); }
  const coverage = await publishGitHub(data);
  assert.equal(coverage.units, 3);
  assert.equal(git(['--git-dir', remote, 'for-each-ref', '--format=%(refname)', 'refs/heads']), 'refs/heads/main');
  assert.equal(git(['--git-dir', remote, 'show', 'main:app.txt']), 'Existing application code');
  assert.equal(git(['--git-dir', remote, 'show', 'main:concurrent.txt']), 'Concurrent application update');
  const published = JSON.parse(git(['--git-dir', remote, 'show', 'main:reports/latest/coverage.json']));
  assert.equal(published.units, 3);
  assert.equal(published.sku_buckets, 30);
  assert.ok(git(['--git-dir', remote, 'show', 'main:reports/latest/volume.svg'])
    .includes('3 observed units and 2 reported transactions'));
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
