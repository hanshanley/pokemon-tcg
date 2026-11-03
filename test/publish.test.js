import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Store } from '../src/store.js';
import { saveMonthHistory } from '../src/volume.js';
import { exportSnapshot, checkFreshness, publishGitHub } from '../src/publish.js';

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
      lowSalePrice: index === 0 ? '10' : null, highSalePrice: index === 0 ? '12' : null,
    })) }] };
  saveMonthHistory(store, 1, payload, now.toISOString());
  payload.result[0].buckets[0].quantitySold = 3;
  saveMonthHistory(store, 1, payload, now.toISOString());
  const coverage = await exportSnapshot(store, directory, now);
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
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM daily_volume').get().n, 30);
  assert.ok(readFileSync(join(directory, 'volume.svg'), 'utf8')
    .includes('3 observed units and 5 reported transactions. Priced subset: $30 to $36'));
  assert.ok(coverage.downloads.includes('volume.svg'));
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
  process.env.PATH = `${directory}:${process.env.PATH}`;
  writeFileSync(join(directory, 'gh'), `#!/usr/bin/env node
const {writeFileSync} = require('node:fs');
const {execFileSync} = require('node:child_process');
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
});
