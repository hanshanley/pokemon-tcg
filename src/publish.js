import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync,
  createWriteStream, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { Store, csv, volumeSource } from './store.js';

const repo = 'hanshanley/pokemon-tcg';
const branch = 'daily-data';
const tag = 'daily-volume';
const reportFiles = ['coverage.json', 'daily-volume.csv', 'pokemon-daily.csv', 'product-volume.csv'];
const assetFiles = ['daily-sku-volume.csv.gz', 'pokemon-product-catalog.csv.gz', ...reportFiles];

export function checkFreshness(coverage, now = new Date()) {
  for (const field of ['generated_at', 'last_successful_check_at']) {
    const age = now - new Date(coverage[field]);
    if (!Number.isFinite(age) || age < -300000 || age > 26 * 3600000) {
      throw new Error(`Daily data is stale or invalid: ${field}. Check the remote daily collection workflow.`);
    }
  }
  if (coverage.source !== volumeSource || !(coverage.sku_buckets > 0)) {
    throw new Error('No native daily SKU data is published.');
  }
}

function* csvChunks(rows, fields) {
  const header = csv([], fields);
  yield header;
  let batch = [];
  for (const row of rows) {
    batch.push(row);
    if (batch.length === 1000) {
      yield csv(batch, fields).slice(header.length);
      batch = [];
    }
  }
  if (batch.length) yield csv(batch, fields).slice(header.length);
}

export async function exportSnapshot(store, directory, now = new Date()) {
  mkdirSync(directory, { recursive: true });
  store.db.exec('BEGIN');
  try {
    const totals = store.db.prepare(`SELECT count(*) AS sku_buckets,
      coalesce(sum(quantity),0) AS units, coalesce(sum(transaction_count),0) AS transactions,
      min(date_source) AS first_source_date, max(date_source) AS last_source_date,
      max(last_seen) AS last_observed_at FROM daily_volume`).get();
    if (!totals.sku_buckets) throw new Error('No daily SKU history to publish; no zero-sales report created.');
    const run = store.db.prepare('SELECT * FROM volume_runs ORDER BY date_utc DESC LIMIT 1').get();
    const lastCheck = store.db.prepare(`SELECT max(fetched_at) AS date FROM volume_jobs
      WHERE status IN ('success','empty')`).get().date ?? totals.last_observed_at;
    const coverage = {
      source: volumeSource, generated_at: now.toISOString(), ...totals,
      last_successful_check_at: lastCheck, sales_usd: null,
      catalog_products: store.db.prepare('SELECT count(*) AS n FROM catalog_products WHERE is_current=1').get().n,
      sweep: run ? Object.fromEntries(['date_utc', 'status', 'updated_at', 'products_expected',
        'products_checked', 'products_with_history', 'products_without_history', 'products_failed']
        .map(key => [key, run[key]])) : null,
      marketplace_completeness: 'unverified',
      source_timezone: 'not published',
      notes: 'Reported daily SKU buckets, not individual sales. Missing history is unknown, not zero. Multi-Pokemon rankings are nonadditive.',
      downloads: assetFiles,
    };
    checkFreshness(coverage, now);
    const filters = { source: volumeSource };
    writeFileSync(join(directory, 'daily-volume.csv'), csv(store.dailyRows(filters).map(row => ({
      ...row, date_source: row.name,
    })), ['date_source', 'sale_records', 'units', 'sales_usd', 'products_with_history', 'sku_buckets']));
    writeFileSync(join(directory, 'pokemon-daily.csv'), csv(store.pokemonDailyRows(filters),
      ['date_source', 'pokemon_key', 'pokemon', 'sale_records', 'units', 'sales_usd', 'products_with_history']));
    const products = store.db.prepare(`SELECT product_id,min(product_name) AS name,
      sum(quantity) AS units,sum(transaction_count) AS sale_records
      FROM reported_product_volume GROUP BY product_id ORDER BY units DESC,product_id`).all();
    writeFileSync(join(directory, 'product-volume.csv'), csv(products,
      ['product_id', 'name', 'units', 'sale_records']));
    await pipeline(Readable.from(csvChunks(store.volumeRows(filters),
      ['source', 'product_id', 'product_name', 'kind', 'pokemon', 'sku_id', 'date_source',
        'quantity', 'transaction_count', 'condition', 'variant', 'language', 'first_seen', 'last_seen'])),
    createGzip(), createWriteStream(join(directory, 'daily-sku-volume.csv.gz')));
    const catalog = store.catalogRows({}, true).products.map(row =>
      ({ ...row, pokemon: row.pokemon.join(' / ') }));
    await pipeline(Readable.from(csvChunks(catalog,
      ['product_id', 'category_id', 'group_id', 'set_name', 'name', 'number', 'rarity',
        'card_type', 'hp', 'pokemon', 'source_modified', 'source_build', 'url'])),
    createGzip(), createWriteStream(join(directory, 'pokemon-product-catalog.csv.gz')));
    writeFileSync(join(directory, 'coverage.json'), `${JSON.stringify(coverage, null, 2)}\n`);
    store.db.exec('COMMIT');
    return coverage;
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}

export async function publishGitHub(dataDirectory) {
  const lockPath = join(dataDirectory, 'github-publish.lock');
  try {
    const pid = Number(readFileSync(lockPath, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid GitHub publisher lock.');
    try { process.kill(pid, 0); }
    catch (error) { if (error.code !== 'ESRCH') throw error; unlinkSync(lockPath); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lock = openSync(lockPath, 'wx');
  writeFileSync(lock, String(process.pid));
  closeSync(lock);
  const temporary = mkdtempSync(join(dataDirectory, 'github-publish-'));
  let store;
  try {
    store = new Store(join(dataDirectory, 'sales.sqlite'));
    const checkout = join(temporary, 'checkout');
    const command = (name, args, cwd = temporary) =>
      execFileSync(name, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
    command('git', ['clone', '--depth', '1', `https://github.com/${repo}.git`, checkout]);
    const exists = command('git', ['ls-remote', '--heads', 'origin', branch], checkout);
    if (exists) {
      command('git', ['fetch', '--depth', '1', 'origin', branch], checkout);
      command('git', ['switch', '-c', branch, 'FETCH_HEAD'], checkout);
    } else command('git', ['switch', '-c', branch], checkout);
    const output = join(checkout, 'reports', 'latest');
    const coverage = await exportSnapshot(store, output);
    store.close(); store = null;
    const notes = `Snapshot ${coverage.generated_at}: ${coverage.sku_buckets} saved SKU-day buckets. ` +
      'Complete matching SKU and catalog CSV downloads; no local database or individual transactions uploaded. ' +
      'Coverage remains partial/unverified; see coverage.json for sweep progress and source dates.';
    try { command('gh', ['release', 'view', tag, '--repo', repo]); }
    catch { command('gh', ['release', 'create', tag, '--repo', repo, '--target', 'main',
      '--title', 'Daily Pokemon sales-volume downloads', '--notes', notes]); }
    command('gh', ['release', 'upload', tag, '--repo', repo, '--clobber',
      ...assetFiles.map(name => join(output, name))]);
    command('gh', ['release', 'edit', tag, '--repo', repo, '--notes', notes]);
    command('git', ['add', '--', ...reportFiles.map(name => `reports/latest/${name}`)], checkout);
    command('git', ['-c', 'user.name=Hans Hanley',
      '-c', 'user.email=22331826+hanshanley@users.noreply.github.com', 'commit',
      '-m', `Update daily Pokemon volume: ${coverage.generated_at.slice(0, 10)}`], checkout);
    command('git', ['push', 'origin', branch], checkout);
    console.log(JSON.stringify({ ...coverage, github_branch: branch,
      commit: command('git', ['rev-parse', 'HEAD'], checkout) }, null, 2));
    return coverage;
  } finally {
    if (store) store.close();
    rmSync(temporary, { recursive: true });
    unlinkSync(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--check' && args.length <= 2) {
      checkFreshness(JSON.parse(readFileSync(args[1] ?? 'reports/latest/coverage.json', 'utf8')));
      console.log('Daily GitHub data is fresh; marketplace completeness remains unverified.');
    } else if (!args.length) {
      const dir = resolve(process.env.DATA_DIR ?? 'data');
      if (!statSync(join(dir, 'sales.sqlite')).size) throw new Error('Sales database is empty.');
      await publishGitHub(dir);
    } else throw new Error('Usage: npm run publish -- [--check [COVERAGE_JSON]]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
