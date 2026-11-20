import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync,
  createReadStream, createWriteStream, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { Store, csv, volumeSource } from './store.js';
import { writeVolumeFigure } from './figures.js';
import { writeSalesFigure } from './sales-figure.js';
import { sourceBuild } from './catalog.js';

const repo = 'hanshanley/pokemon-tcg';
const branch = 'main';
const tag = 'daily-volume';
const reportFiles = ['coverage.json', 'daily-volume.csv', 'pokemon-daily.csv', 'product-volume.csv',
  'daily-sales-value.csv', 'pokemon-sales-value.csv', 'product-sales-value.csv',
  'daily-trading.csv', 'set-daily-trading.csv', 'volume.svg',
  'sales-value.svg','sales-value.png','sales-value-moe.svg','sales-value-moe.png',
  'sales-value.csv','sales-value.json'];
const assetFiles = ['daily-sku-volume.csv.gz', 'pokemon-product-catalog.csv.gz',
  'product-daily-trading.csv.gz', ...reportFiles];

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

export function checkCompleteSweep(coverage, now = new Date()) {
  checkFreshness(coverage, now);
  const sweep = coverage.sweep;
  if (!Number.isSafeInteger(coverage.catalog_products) || coverage.catalog_products < 1 ||
      !sweep || sweep.date_utc !== now.toISOString().slice(0,10) ||
      sweep.status !== 'complete' || sweep.products_failed !== 0 ||
      sweep.products_checked !== sweep.products_expected ||
      sweep.products_with_history + sweep.products_without_history !== sweep.products_expected ||
      sweep.products_expected !== coverage.catalog_products) {
    throw new Error(`Catalog sweep is incomplete or failed: ${sweep?.products_checked ?? 'unknown'}/` +
      `${coverage.catalog_products ?? 'unknown'} products checked; ${sweep?.products_failed ?? 'unknown'} failed; ` +
      `queue ${sweep?.date_utc ?? 'unknown'} is ${sweep?.status ?? 'unknown'} ` +
      `(required UTC date ${now.toISOString().slice(0,10)}). Retained data is not an all-product success.`);
  }
}

export function checkCompleteDatabase(db, coverage, now = new Date()) {
  checkCompleteSweep(coverage, now);
  db.exec('SAVEPOINT verify_complete_database');
  try {
    if (Object.values(db.prepare('PRAGMA quick_check').get())[0] !== 'ok') {
      throw new Error('Public checkpoint failed SQLite integrity checks.');
    }
    const sweep = coverage.sweep;
    const saved = db.prepare('SELECT * FROM volume_runs WHERE date_utc=?').get(sweep.date_utc);
    if (!saved || Object.keys(sweep).some(key => saved[key] !== sweep[key])) {
      throw new Error('Published coverage does not match the saved catalog sweep.');
    }
    const build = db.prepare(`SELECT source_build FROM catalog_runs
      WHERE status='complete' ORDER BY id DESC LIMIT 1`).get()?.source_build;
    if (!build || build !== coverage.catalog_source_build) {
      throw new Error('Published catalog build does not match the public checkpoint.');
    }
    const counts = db.prepare(`SELECT count(*) AS products_expected,
      coalesce(sum(j.status IN ('success','empty')),0) AS products_checked,
      coalesce(sum(j.status='success'),0) AS products_with_history,
      coalesce(sum(j.status='empty'),0) AS products_without_history,
      coalesce(sum(j.status='failed'),0) AS products_failed
      FROM catalog_products c LEFT JOIN volume_jobs j
        ON j.product_id=c.product_id AND j.date_utc=?
      WHERE c.is_current=1`).get(sweep.date_utc);
    if (Object.entries(counts).some(([key, value]) => value !== sweep[key])) {
      throw new Error('Not every current catalog product has a saved successful or empty result.');
    }
    const inconsistent = db.prepare(`SELECT count(*) AS n FROM volume_jobs j
      JOIN catalog_products c ON c.product_id=j.product_id AND c.is_current=1
      LEFT JOIN price_checks p ON p.product_id=j.product_id
      WHERE j.date_utc=? AND (
        julianday(j.fetched_at) IS NULL OR j.fetched_at<? OR j.fetched_at>?
        OR p.checked_at IS NULL OR p.checked_at<>j.fetched_at
        OR (j.status='empty' AND j.buckets<>0)
        OR (j.status='success' AND (j.buckets<=0 OR j.buckets%30<>0))
        OR j.buckets<>(SELECT count(*) FROM daily_volume v
          WHERE v.product_id=j.product_id AND v.last_seen=j.fetched_at)
        OR j.buckets<>(SELECT count(*) FROM daily_sale_prices v
          WHERE v.product_id=j.product_id AND v.observed_at=j.fetched_at)
      )`).get(sweep.date_utc, `${sweep.date_utc}T00:00:00.000Z`, coverage.generated_at).n;
    if (inconsistent) {
      throw new Error(`${inconsistent} catalog products lack matching fresh saved history and price checks.`);
    }
    const totals = db.prepare(`SELECT count(*) AS sku_buckets,sum(quantity) AS units,
      sum(transaction_count) AS transactions FROM daily_volume`).get();
    if (Object.entries(totals).some(([key, value]) => value !== coverage[key])) {
      throw new Error('Published daily totals do not match the saved SKU buckets.');
    }
    return { ...counts, ...totals, catalog_source_build: build, inconsistent_products: inconsistent };
  } finally { db.exec('RELEASE verify_complete_database'); }
}

export async function needsDailyCollection(coverage, { now = new Date(), fetcher = fetch } = {}) {
  try { checkCompleteSweep(coverage, now); }
  catch { return true; }
  if (!coverage.catalog_source_build) return true;
  return coverage.catalog_source_build !== await sourceBuild(fetcher);
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

export function verifiedReportingDates(db, latestDate) {
  const sweeps = db.prepare(`SELECT *, date(date_utc,'-29 days') AS window_start
    FROM volume_runs
    WHERE status='complete' AND products_failed=0 AND products_expected>0
      AND products_checked=products_expected AND products_with_history>0
      AND products_with_history+products_without_history=products_expected
      AND date_utc<=? AND finished_at IS NOT NULL
    ORDER BY date_utc DESC`).all(latestDate);
  const counts = db.prepare(`SELECT count(*) AS jobs,
      count(*) FILTER (WHERE status='success' AND buckets>0 AND buckets%30=0
        AND julianday(fetched_at) BETWEEN julianday(?) AND julianday(?)) AS histories,
      count(*) FILTER (WHERE status='empty' AND buckets=0
        AND julianday(fetched_at) BETWEEN julianday(?) AND julianday(?)) AS empty
    FROM volume_jobs WHERE date_utc=?`);
  const dates = db.prepare(`SELECT DISTINCT date_source FROM daily_volume WHERE date_source<?`)
    .all(latestDate).map(row => row.date_source);
  const verified = new Set();
  for (const run of sweeps) {
    const { date_utc: queue, window_start: start, finished_at: finished } = run;
    const candidates = dates.filter(date => date >= start && date < queue && !verified.has(date));
    if (!candidates.length) continue;
    const saved = counts.get(queue,finished,queue,finished,queue);
    if (saved.jobs !== run.products_expected || saved.histories !== run.products_with_history ||
        saved.empty !== run.products_without_history) continue;
    // The later bucket establishes the date boundary; historical buckets must cover the response's SKU count.
    const covered = db.prepare(`SELECT date_source,count(*) AS products FROM (
      SELECT v.date_source FROM daily_volume v NOT INDEXED CROSS JOIN volume_jobs j
        ON j.product_id=v.product_id AND v.last_seen>=j.fetched_at
      WHERE j.date_utc=? AND j.status='success'
        AND v.date_source IN (${[...candidates,queue].map(() => '?').join(',')})
      GROUP BY j.product_id,v.date_source HAVING count(*)>=j.buckets/30 OR v.date_source=?
    ) GROUP BY date_source`).all(queue,...candidates,queue,queue)
      .filter(row => row.products === run.products_with_history).map(row => row.date_source);
    if (covered.includes(queue)) for (const date of covered) if (date !== queue) verified.add(date);
  }
  return [...verified].sort();
}

export function updateReadmeLeaderboard(readme, daily, pokemon, reportingDates) {
  const start = '<!-- BEGIN POKEMON LEADERBOARD -->';
  const end = '<!-- END POKEMON LEADERBOARD -->';
  const sections = readme.split(`${start}\n`);
  const rest = sections[1]?.split(`\n${end}`);
  if (sections.length !== 2 || rest?.length !== 2) throw new Error('Invalid README leaderboard markers.');

  const verified = new Set(reportingDates);
  const date = daily.map(row => row.date_source).filter(day => verified.has(day)).sort().at(-1);
  const top = pokemon.filter(row => row.date_source === date && row.units > 0)
    .sort((a, b) => b.units - a.units ||
      (a.pokemon_key < b.pokemon_key ? -1 : a.pokemon_key > b.pokemon_key ? 1 : 0)).slice(0, 10);
  const format = new Intl.NumberFormat('en-US');
  const name = value => value.replace(/[\r\n]+/g, ' ')
    .replace(/[&<>\\|`*_[\]~]/g, char => `&#${char.charCodeAt(0)};`);
  const table = top.length ? [
    '| Rank | Pokemon | Units sold | Reported transactions |',
    '| ---: | --- | ---: | ---: |',
    ...top.map((row, i) => `| ${i + 1} | ${name(row.pokemon)} | ${format.format(row.units)} | ${format.format(row.sale_records)} |`),
  ].join('\n') : 'No mapped Pokemon sales were reported for this day.';
  const body = date
    ? `**${date}** (TCGplayer source date; verified catalog sweep) · ranked by reported units sold.\n\n${table}`
    : 'No source day with a verified catalog sweep is available yet.';
  return `${sections[0]}${start}\n\n${body}\n\n${end}${rest[1]}`;
}

function snapshotState(db, now) {
  const totals = db.prepare(`SELECT count(*) AS sku_buckets,
      coalesce(sum(quantity),0) AS units, coalesce(sum(transaction_count),0) AS transactions,
      min(date_source) AS first_source_date, max(date_source) AS last_source_date,
      max(last_seen) AS last_observed_at FROM daily_volume`).get();
  if (!totals.sku_buckets) throw new Error('No daily SKU history to publish; no zero-sales report created.');
  const run = db.prepare('SELECT * FROM volume_runs ORDER BY date_utc DESC LIMIT 1').get();
  const lastCheck = db.prepare(`SELECT max(fetched_at) AS date FROM volume_jobs
      WHERE status IN ('success','empty')`).get().date ?? totals.last_observed_at;
  return {
    source: volumeSource, generated_at: now.toISOString(), ...totals, last_successful_check_at: lastCheck,
    catalog_products: db.prepare('SELECT count(*) AS n FROM catalog_products WHERE is_current=1').get().n,
    catalog_source_build: db.prepare(`SELECT source_build FROM catalog_runs
      WHERE status='complete' ORDER BY id DESC LIMIT 1`).get()?.source_build ?? null,
    sweep: run ? Object.fromEntries(['date_utc', 'status', 'updated_at', 'products_expected',
      'products_checked', 'products_with_history', 'products_without_history', 'products_failed']
      .map(key => [key, run[key]])) : null,
  };
}

export function checkStoredSweep(db, now = new Date()) {
  return checkCompleteDatabase(db, snapshotState(db, now), now);
}

export async function exportSnapshot(store, directory, now = new Date(), { readmePath } = {}) {
  mkdirSync(directory, { recursive: true });
  store.db.exec('BEGIN');
  try {
    const snapshot = snapshotState(store.db, now);
    const priceVolume = store.saleValueRows({ source: volumeSource })[0];
    const coverage = {
      ...snapshot, sales_usd: priceVolume.sales_usd,
      reporting_dates: verifiedReportingDates(store.db, snapshot.last_source_date),
      marketplace_completeness: 'unverified',
      source_timezone: 'not published',
      price_volume: priceVolume,
      notes: 'Reported daily SKU buckets, not individual sales. Dollar bounds use actual daily low/high unit sale prices, excluding shipping. Priced subtotals exclude unpriced units; exact total is unavailable unless all units have equal lower/upper bounds. Market prices are not revenue. Missing history is unknown, not zero. Multi-Pokemon rankings are nonadditive.',
      downloads: assetFiles,
    };
    checkFreshness(coverage, now);
    const filters = { source: volumeSource };
    const valueFields = ['sale_records','units','priced_units','unpriced_units','priced_sales_lower_usd',
      'priced_sales_upper_usd','sales_lower_usd','sales_upper_usd','sales_usd'];
    for (const [group, fields] of [['daily',['date_source']],
      ['pokemon',['date_source','pokemon_key','pokemon']], ['product',['product_id','name']]]) {
      writeFileSync(join(directory, `${group}-sales-value.csv`),
        csv(store.saleValueRows(filters,group), [...fields,...valueFields]));
    }
    writeFileSync(join(directory, 'set-daily-trading.csv'),
      csv(store.saleValueRows(filters, 'set-daily'),
        ['date_source','category_id','group_id','set_name',...valueFields]));
    await pipeline(Readable.from(csvChunks(store.saleValueRows(filters, 'product-daily', true),
      ['date_source','product_id','name','category_id','group_id','set_name',...valueFields])),
    createGzip(), createWriteStream(join(directory, 'product-daily-trading.csv.gz')));
    const daily = store.dailyRows(filters).map(row => ({
      ...row, date_source: row.name,
    }));
    const pokemon = store.pokemonDailyRows(filters);
    writeFileSync(join(directory, 'daily-volume.csv'), csv(daily,
      ['date_source', 'sale_records', 'units', 'sales_usd', 'products_with_history', 'sku_buckets']));
    writeFileSync(join(directory, 'pokemon-daily.csv'), csv(pokemon,
      ['date_source', 'pokemon_key', 'pokemon', 'sale_records', 'units', 'sales_usd', 'products_with_history']));
    const products = store.db.prepare(`SELECT product_id,min(product_name) AS name,
      sum(quantity) AS units,sum(transaction_count) AS sale_records
      FROM reported_product_volume GROUP BY product_id ORDER BY units DESC,product_id`).all();
    writeFileSync(join(directory, 'product-volume.csv'), csv(products,
      ['product_id', 'name', 'units', 'sale_records']));
    await pipeline(Readable.from(csvChunks(store.volumeRows(filters),
      ['source', 'product_id', 'product_name', 'kind', 'pokemon', 'sku_id', 'date_source',
        'quantity', 'transaction_count', 'condition', 'variant', 'language', 'first_seen', 'last_seen',
        'low_sale_price_usd','high_sale_price_usd','low_sale_price_with_shipping_usd',
        'high_sale_price_with_shipping_usd','prices_observed_at'])),
    createGzip(), createWriteStream(join(directory, 'daily-sku-volume.csv.gz')));
    const catalog = store.catalogRows({}, true).products.map(row =>
      ({ ...row, pokemon: row.pokemon.join(' / ') }));
    await pipeline(Readable.from(csvChunks(catalog,
      ['product_id', 'category_id', 'group_id', 'set_name', 'name', 'number', 'rarity',
        'card_type', 'hp', 'pokemon', 'source_modified', 'source_build', 'url'])),
    createGzip(), createWriteStream(join(directory, 'pokemon-product-catalog.csv.gz')));
    writeFileSync(join(directory, 'coverage.json'), `${JSON.stringify(coverage, null, 2)}\n`);
    writeVolumeFigure(directory);
    await writeSalesFigure(directory);
    if (readmePath) {
      const readme = readFileSync(readmePath, 'utf8');
      writeFileSync(readmePath, updateReadmeLeaderboard(readme, daily, pokemon, coverage.reporting_dates));
    }
    store.db.exec('COMMIT');
    return coverage;
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}

export async function publishGitHub(dataDirectory, { fromExport = false } = {}) {
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
    command('git', ['clone', '--depth', '1', '--branch', branch,
      `https://github.com/${repo}.git`, checkout]);
    command('git', ['config', 'user.name', 'Hans Hanley'], checkout);
    command('git', ['config', 'user.email', '22331826+hanshanley@users.noreply.github.com'], checkout);
    const output = join(checkout, 'reports', 'latest');
    const coverage = await exportSnapshot(store, output, new Date(), { readmePath: join(checkout, 'README.md') });
    store.close(); store = null;
    const assets = assetFiles.map(name => join(output, name));
    if (fromExport) {
      const { publicCheckpoint } = await import('./remote.js');
      const checkpoint = join(temporary, 'public-state.sqlite');
      publicCheckpoint(join(dataDirectory, 'sales.sqlite'), checkpoint);
      const db = new DatabaseSync(checkpoint, { readOnly: true });
      try { checkCompleteDatabase(db, coverage); }
      finally { db.close(); }
      const compressed = join(temporary, 'remote-state.sqlite.gz');
      await pipeline(createReadStream(checkpoint), createGzip(), createWriteStream(compressed));
      assets.push(compressed);
    }
    const notes = `Snapshot ${coverage.generated_at}: ${coverage.sku_buckets} saved SKU-day buckets. ` +
      'Complete matching SKU and catalog CSV downloads; no private data or individual transactions uploaded. ' +
      'Coverage remains partial/unverified; see coverage.json for sweep progress and source dates.';
    try { command('gh', ['release', 'view', tag, '--repo', repo]); }
    catch { command('gh', ['release', 'create', tag, '--repo', repo, '--target', 'main',
      '--title', 'Daily Pokemon sales-volume downloads', '--notes', notes]); }
    command('gh', ['release', 'upload', tag, '--repo', repo, '--clobber', ...assets]);
    command('gh', ['release', 'edit', tag, '--repo', repo, '--notes', notes]);
    command('git', ['add', '--', 'README.md', ...reportFiles.map(name => `reports/latest/${name}`)], checkout);
    command('git', ['commit',
      '-m', `Update daily Pokemon volume: ${coverage.generated_at.slice(0, 10)}`], checkout);
    for (let attempt = 0; ; attempt++) {
      try { command('git', ['push', 'origin', branch], checkout); break; }
      catch (error) {
        if (attempt >= 2) throw error;
        command('git', ['pull', '--rebase', 'origin', branch], checkout);
      }
    }
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
    if (args[0] === '--needs-collection' && args.length <= 2) {
      console.log(await needsDailyCollection(
        JSON.parse(readFileSync(args[1] ?? 'reports/latest/coverage.json', 'utf8'))));
    } else if (args[0] === '--check-stored' && args.length === 2) {
      const db = new DatabaseSync(resolve(args[1]), { readOnly: true });
      try { console.log(JSON.stringify(checkStoredSweep(db))); }
      finally { db.close(); }
    } else if (['--check','--complete'].includes(args[0]) &&
        args.length <= (args[0] === '--complete' ? 3 : 2)) {
      const coverage = JSON.parse(readFileSync(args[1] ?? 'reports/latest/coverage.json', 'utf8'));
      (args[0] === '--complete' ? checkCompleteSweep : checkFreshness)(coverage);
      if (args[2]) {
        const db = new DatabaseSync(resolve(args[2]), { readOnly: true });
        try { console.log(JSON.stringify(checkCompleteDatabase(db, coverage))); }
        finally { db.close(); }
      }
      console.log('Daily GitHub data passed its checks; marketplace completeness remains unverified.');
    } else if (!args.length || args.length === 1 && args[0] === '--from-export') {
      const dir = resolve(process.env.DATA_DIR ?? 'data');
      if (!statSync(join(dir, 'sales.sqlite')).size) throw new Error('Sales database is empty.');
      await publishGitHub(dir, { fromExport: args[0] === '--from-export' });
    } else throw new Error('Usage: npm run publish -- [--from-export | --check | --check-stored PUBLIC_SQLITE | --needs-collection [COVERAGE_JSON] | --complete COVERAGE_JSON [PUBLIC_SQLITE]]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
