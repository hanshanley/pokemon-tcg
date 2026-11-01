import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/store.js';
import { pollIndividualSales, exportIndividualSales, individualCheckpoint, publishIndividualSales } from '../src/individual.js';

const sale = (time, quantity = 1, price = 2.5) => ({
  orderDate: `2026-11-01T${time}:00Z`, quantity, purchasePrice: price,
  condition: 'Near Mint', variant: 'Holofoil', language: 'English',
});
const result = sales => ({
  sales, status: 'partial', pages: 1,
  warning: 'The site requires sign-in for additional history.',
});
function product(store, id = 42382) {
  store.addProduct({ url: `https://www.tcgplayer.com/product/${id}`,
    name: 'Charizard', kind: 'single', pokemon: ['Charizard'] });
  return { id };
}

test('forward polling retains old sales, identical-sale multiplicity and overlapping rows without double-counting', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const p = product(store);
  store.record(p, result([sale('01:00'), sale('01:00'), sale('02:00', 3)]));
  let closed = 0;
  await pollIndividualSales(store, {
    createBrowser: async () => ({ close: async () => { closed++; } }),
    collect: async (_, __, options) => {
      assert.equal(options.maxPages, 1);
      return result([sale('01:00'), sale('01:00'), sale('02:00', 3), sale('03:00')]);
    }, log: () => {},
  });
  assert.equal(closed, 1);
  const rows = store.saleRows();
  assert.equal(rows.length, 4);
  assert.equal(rows.reduce((n, row) => n + row.quantity, 0), 6);
  assert.equal(store.dailyRows()[0].sales_usd, 15);
});

test('denial stops before another product and persists failed checks without deleting observations', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.record(product(store), result([sale('01:00')]));
  product(store, 565879);
  let calls = 0, closed = 0;
  await assert.rejects(pollIndividualSales(store, {
    createBrowser: async () => ({ close: async () => { closed++; } }),
    collect: async () => {
      calls++;
      return { sales: [], status: 'failed', pages: 0, warning: 'Sales endpoint returned HTTP 403.' };
    }, log: () => {},
  }), /stopped without retrying/);
  assert.equal(calls, 1);
  assert.equal(closed, 1);
  assert.equal(store.saleRows().length, 1);
  assert.equal(store.products()[0].last_status, 'failed');
});

test('complete public exports and checkpoints preserve real prices and persistent gap warnings, excluding other sources', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pokemon-individual-'));
  const store = new Store(':memory:');
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  const p = product(store);
  store.record(p, result([sale('01:00', 2)]));
  store.record(p, result([sale('04:00')]));
  store.db.prepare(`INSERT INTO catalog_products VALUES
    (1,3,1,'Other set','Private product','','','','','[]','','build',1)`).run();
  store.db.prepare(`INSERT INTO bulk_sales
    (source,transaction_key,product_id,kind,sold_at,quantity,unit_price_cents,shipping_cents,
      condition,variant,language,listing_type,first_seen,last_seen)
    VALUES ('private','secret',1,'single','2026-11-01T00:00:00Z',100,999,0,'','','','','now','now')`).run();
  const checkpoint = join(directory, 'public.sqlite');
  individualCheckpoint(store, checkpoint);
  assert.throws(() => individualCheckpoint(store, checkpoint), /new file/);
  const clean = new Store(checkpoint);
  try {
    assert.equal(clean.db.prepare('SELECT count(*) AS n FROM bulk_sales').get().n, 0);
    assert.equal(clean.db.prepare('SELECT count(*) AS n FROM catalog_products').get().n, 0);
    const coverage = exportIndividualSales(clean, directory);
    assert.equal(coverage.records, 2);
    assert.equal(coverage.units, 3);
    assert.equal(coverage.item_sales_cents, 750);
    assert.equal(coverage.products_with_possible_gaps, 1);
    assert.equal(coverage.automatic_individual_collection, true);
    const plain = readFileSync(join(directory, 'transactions.csv'), 'utf8');
    assert.equal(gunzipSync(readFileSync(join(directory, 'public-individual-sales.csv.gz'))).toString(), plain);
    assert.equal(plain.trimEnd().split('\n').length, 3);
    assert.ok(!plain.includes('Private product'));
    assert.ok(readFileSync(join(directory, 'pokemon-daily.csv'), 'utf8')
      .includes('"2026-11-01","charizard","Charizard","2","3","7.5"'));
    const previousCheck = coverage.last_successful_check_at;
    clean.record(p, { sales: [], pages: 0, status: 'failed', warning: 'Unavailable' });
    const failed = exportIndividualSales(clean, directory);
    assert.equal(failed.last_successful_check_at, previousCheck);
    assert.equal(failed.records, 2);
    assert.equal(failed.products[0].status, 'failed');
    assert.equal(failed.products_with_possible_gaps, 1);
  } finally { clean.close(); }
});

test('empty archives and browser failures never create zero-sales success reports', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pokemon-individual-empty-'));
  const store = new Store(':memory:');
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  assert.throws(() => exportIndividualSales(store, directory), /No actual individual sales/);
  store.record(product(store), result([sale('01:00')]));
  await assert.rejects(pollIndividualSales(store, {
    createBrowser: async () => { throw new Error('Browser missing'); },
  }), /could not start/);
  assert.equal(store.products()[0].last_status, 'failed');
  assert.equal(store.saleRows().length, 1);
});

test('individual publication uploads full rows and standalone state, preserving concurrent main commits', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pokemon-individual-publish-'));
  const originalEnvironment = { ...process.env };
  t.after(() => {
    process.env = originalEnvironment;
    rmSync(directory, { recursive: true });
  });
  const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const source = join(directory, 'source'), remote = join(directory, 'remote.git');
  git(['init', '--initial-branch=main', source]);
  git(['-C', source, 'config', 'user.name', 'Fixture']);
  git(['-C', source, 'config', 'user.email', 'fixture@example.test']);
  writeFileSync(join(source, 'app.txt'), 'Existing application\n');
  git(['-C', source, 'add', '.']);
  git(['-C', source, 'commit', '-m', 'Initial application']);
  git(['clone', '--bare', source, remote]);
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(remote).href}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/hanshanley/pokemon-tcg.git';
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.PATH = `${directory}:${process.env.PATH}`;
  process.env.TEST_INDIVIDUAL_SOURCE = source;
  process.env.TEST_INDIVIDUAL_REMOTE = remote;
  writeFileSync(join(directory, 'gh'), `#!/usr/bin/env node
const assert = require('node:assert/strict');
const {readFileSync,writeFileSync} = require('node:fs');
const {gunzipSync} = require('node:zlib');
const {DatabaseSync} = require('node:sqlite');
const {execFileSync} = require('node:child_process');
if (process.argv[3] === 'upload') {
  const files = process.argv.filter(path => path.endsWith('.gz'));
  assert.equal(files.length,2);
  const csv = gunzipSync(readFileSync(files.find(path => path.endsWith('.csv.gz')))).toString();
  assert.equal(csv.trimEnd().split('\\n').length,3);
  const sqlite = files.find(path => path.endsWith('.sqlite.gz')) + '.check';
  writeFileSync(sqlite,gunzipSync(readFileSync(files.find(path => path.endsWith('.sqlite.gz')))));
  const db = new DatabaseSync(sqlite);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sales').get().n,2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM bulk_sales').get().n,0);
  db.close();
}
if (process.argv[3] === 'edit') {
  const source=process.env.TEST_INDIVIDUAL_SOURCE;
  const git=args=>execFileSync('git',['-C',source,...args]);
  writeFileSync(source+'/concurrent.txt','Concurrent application update\\n');
  git(['add','.']);git(['commit','-m','Concurrent application update']);
  git(['push',process.env.TEST_INDIVIDUAL_REMOTE,'main']);
}
`, { mode: 0o755 });
  const data = join(directory, 'data');
  const store = new Store(join(data, 'public-individual-sales.sqlite'));
  try { store.record(product(store), result([sale('01:00'), sale('02:00', 2)])); }
  finally { store.close(); }
  const coverage = await publishIndividualSales(data);
  assert.equal(coverage.records, 2);
  assert.equal(coverage.units, 3);
  assert.equal(git(['--git-dir', remote, 'show', 'main:concurrent.txt']), 'Concurrent application update');
  assert.equal(git(['--git-dir', remote, 'show', 'main:app.txt']), 'Existing application');
  assert.equal(git(['--git-dir', remote, 'for-each-ref', '--format=%(refname)', 'refs/heads']), 'refs/heads/main');
  const published = git(['--git-dir', remote, 'show', 'main:reports/individual-sales/transactions.csv']);
  assert.equal(published.split('\n').length, 3);
  assert.equal(git(['--git-dir', remote, 'log', '-1', '--format=%an']), 'Hans Hanley');
  assert.ok(!git(['--git-dir', remote, 'log', '-1', '--format=%B']).includes('Co-authored-by'));
});
