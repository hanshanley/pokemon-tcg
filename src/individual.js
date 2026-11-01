import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { Store, csv } from './store.js';
import { collectProduct } from './collector.js';

const repo = 'hanshanley/pokemon-tcg';
const tag = 'individual-sales';
const fields = ['product_id', 'product_name', 'kind', 'pokemon', 'sold_at_utc',
  'quantity', 'unit_price_usd', 'item_sales_usd', 'reported_shipping_usd',
  'condition', 'variant', 'language', 'listing_type', 'observed_at', 'coverage'];
const reports = ['transactions.csv', 'coverage.json', 'daily-sales.csv', 'pokemon-daily.csv'];
const assets = ['public-individual-sales.csv.gz', 'public-individual-sales.sqlite.gz', ...reports];

export async function pollIndividualSales(store, {
  createBrowser = () => chromium.launch({ headless: false }),
  collect = collectProduct, log = console.log,
} = {}) {
  const products = store.products();
  if (!products.length) throw new Error('Restore the public individual-sales checkpoint first.');
  let browser;
  try { browser = await createBrowser(); }
  catch {
    for (const product of products) store.record(product, {
      status: 'failed', sales: [], pages: 0,
      warning: 'Browser could not start; no source observations made.',
    });
    throw new Error('Public storefront browser could not start; retained history is preserved.');
  }
  let checked = 0, failed = 0;
  try {
    for (const product of products) {
      let result;
      try { result = await collect(browser, product, { maxPages: 1, timeout: 25000 }); }
      catch {
        result = { sales: [], status: 'failed', pages: 0,
          warning: 'Collection failed before a usable public source response.' };
      }
      const recorded = store.record(product, result);
      if (result.status === 'failed') failed++;
      else checked++;
      log(JSON.stringify({ product_id: product.id, status: result.status,
        records_added: recorded.rowsAdded }));
      if (/HTTP (?:401|403|429)\b/.test(result.warning ?? '')) {
        throw new Error('Public sales access denied or rate limited; stopped without retrying.');
      }
    }
  } finally { await browser.close(); }
  if (failed || !checked) throw new Error(`Individual capture failed for ${failed} products; retained history is preserved.`);
  return { checked, failed };
}

export function exportIndividualSales(store, directory, now = new Date()) {
  mkdirSync(directory, { recursive: true });
  store.db.exec('BEGIN');
  let coverage;
  try {
    const totals = store.db.prepare(`SELECT count(*) AS records,coalesce(sum(quantity),0) AS units,
      coalesce(sum(quantity*unit_price_cents),0) AS item_sales_cents,
      min(sold_at) AS first_sale_utc,max(sold_at) AS last_sale_utc,
      max(last_seen) AS observed_at FROM sales`).get();
    if (!totals.records) throw new Error('No actual individual sales to export; missing history is not zero sales.');
    const products = store.products().map(product => ({
      product_id: product.id, name: product.name, status: product.last_status,
      last_collected: product.last_collected, rows_seen: product.last_rows_seen,
      warning: product.last_warning,
      possible_gap_collections: store.db.prepare(`SELECT count(*) AS n FROM collections
        WHERE product_id=? AND warning LIKE '%No overlap with saved history%'`).get(product.id).n,
    }));
    const lastCheck = store.db.prepare(`SELECT max(finished_at) AS date FROM collections
      WHERE status IN ('partial','observed') AND rows_seen>0`).get().date;
    const gapProducts = products.filter(product => product.possible_gap_collections > 0).length;
    coverage = {
      source: 'tcgplayer-public-individual-sales', generated_at: now.toISOString(), ...totals,
      item_sales_usd: totals.item_sales_cents / 100,
      last_successful_check_at: lastCheck,
      scope: 'Bounded public captures of the checkpoint products, not the whole Pokemon catalog.',
      products, products_tracked: products.length,
      products_with_possible_gaps: gapProducts,
      marketplace_completeness: 'unverified',
      history_completeness: 'incomplete; signed-out website returns five recent rows per product',
      automatic_individual_collection: true,
      scheduled_poll_interval_hours: 3,
      downloads: assets,
      notes: 'Real individual-sale rows only. Dollars sum unit price times quantity for retained captured rows, excluding shipping and tax. No stable source sale ID; content/multiplicity deduplication cannot certify completeness. A three-hour schedule cannot guarantee retaining every sale in a five-row window. Possible gaps and failures remain visible; unavailable data is never zero sales. Native daily buckets are separate. No account data, credentials or browser profile included.',
    };
    const rows = store.saleRows({ source: 'snapshot' }).map(row => ({
      ...row, pokemon: row.pokemon.join(' / '), sold_at_utc: row.sold_at,
      unit_price_usd: row.unit_price_cents / 100,
      item_sales_usd: row.unit_price_cents * row.quantity / 100,
      reported_shipping_usd: row.shipping_cents / 100,
      observed_at: row.last_seen, coverage: 'partial public history',
    }));
    const transactions = csv(rows, fields);
    writeFileSync(join(directory, 'transactions.csv'), transactions);
    writeFileSync(join(directory, 'public-individual-sales.csv.gz'), gzipSync(transactions));
    writeFileSync(join(directory, 'daily-sales.csv'),
      csv(store.dailyRows({ source: 'snapshot' }).map(row => ({ ...row, date_utc: row.name })),
        ['date_utc', 'sale_records', 'units', 'sales_usd']));
    writeFileSync(join(directory, 'pokemon-daily.csv'),
      csv(store.pokemonDailyRows({ source: 'snapshot' }),
        ['date_utc', 'pokemon_key', 'pokemon', 'sale_records', 'units', 'sales_usd']));
    writeFileSync(join(directory, 'coverage.json'), `${JSON.stringify(coverage, null, 2)}\n`);
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return coverage;
}

export function individualCheckpoint(store, destination) {
  if (existsSync(destination)) throw new Error('Checkpoint destination must be a new file.');
  const clean = new Store(destination);
  try {
    // Reconstruct only public capture fields, never upload an arbitrary local database.
    clean.db.exec('BEGIN');
    for (const product of store.products()) {
      clean.addProduct(product);
      clean.db.prepare('UPDATE products SET added_at=? WHERE id=?').run(product.added_at, product.id);
    }
    const insertSale = clean.db.prepare(`INSERT INTO sales
      (product_id,fingerprint,occurrence,sold_at,quantity,unit_price_cents,shipping_cents,
        condition,variant,language,listing_type,first_seen,last_seen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const row of store.db.prepare('SELECT * FROM sales ORDER BY id').iterate()) {
      insertSale.run(row.product_id, row.fingerprint, row.occurrence, row.sold_at, row.quantity,
        row.unit_price_cents, row.shipping_cents, row.condition, row.variant, row.language,
        row.listing_type, row.first_seen, row.last_seen);
    }
    const insertCheck = clean.db.prepare(`INSERT INTO collections
      (product_id,started_at,finished_at,status,rows_seen,rows_added,pages,oldest_sale,newest_sale,warning)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const row of store.db.prepare('SELECT * FROM collections ORDER BY id').iterate()) {
      const warning = [
        /No overlap with saved history/.test(row.warning) ? 'No overlap with saved history; possible missing sales.' : '',
        'Partial public history; additional history requires sign-in. Completeness unverified.',
      ].filter(Boolean).join(' ');
      insertCheck.run(row.product_id, row.started_at, row.finished_at, row.status,
        row.rows_seen, row.rows_added, row.pages, row.oldest_sale, row.newest_sale, warning);
    }
    clean.db.exec('COMMIT');
  } catch (error) { clean.db.exec('ROLLBACK'); throw error; }
  finally { clean.close(); }
}

export async function publishIndividualSales(dataDirectory) {
  const temporary = mkdtempSync(join(dataDirectory, 'individual-publish-'));
  const store = new Store(join(dataDirectory, 'public-individual-sales.sqlite'));
  const command = (name, args, cwd = temporary) =>
    execFileSync(name, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  try {
    const checkout = join(temporary, 'checkout');
    command('git', ['clone', '--depth', '1', '--branch', 'main',
      `https://github.com/${repo}.git`, checkout]);
    command('git', ['config', 'user.name', 'Hans Hanley'], checkout);
    command('git', ['config', 'user.email', '22331826+hanshanley@users.noreply.github.com'], checkout);
    const output = join(checkout, 'reports', 'individual-sales');
    const coverage = exportIndividualSales(store, output);
    const checkpoint = join(temporary, 'public.sqlite');
    individualCheckpoint(store, checkpoint);
    command('gh', ['release', 'view', tag, '--repo', repo]);
    writeFileSync(join(output, 'public-individual-sales.sqlite.gz'),
      execFileSync('gzip', ['-c', checkpoint]));
    command('gh', ['release', 'upload', tag, '--repo', repo, '--clobber',
      ...assets.map(name => join(output, name))]);
    command('gh', ['release', 'edit', tag, '--repo', repo, '--notes',
      `${coverage.records} retained actual public sale records from ${coverage.products_tracked} products. ` +
      'Automatically checked every three hours, with incomplete five-row source windows. ' +
      'Complete CSV/SQLite downloads; captured values are not marketplace totals. See coverage.json.']);
    command('git', ['add', '--', ...reports.map(name => `reports/individual-sales/${name}`)], checkout);
    if (command('git', ['diff', '--cached', '--name-only'], checkout)) {
      command('git', ['commit', '-m', `Update captured individual Pokemon sales: ${coverage.generated_at}`], checkout);
      for (let attempt = 0; ; attempt++) {
        try { command('git', ['push', 'origin', 'main'], checkout); break; }
        catch (error) {
          if (attempt >= 2) throw error;
          command('git', ['pull', '--rebase', 'origin', 'main'], checkout);
        }
      }
    }
    return coverage;
  } finally {
    store.close();
    rmSync(temporary, { recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.env.DATA_DIR ?? 'data');
  let store;
  try {
    if (!existsSync(join(directory, 'public-individual-sales.sqlite'))) {
      throw new Error('Missing retained public individual-sales checkpoint; refusing to start empty.');
    }
    if (process.argv[2] === '--publish' && process.argv.length === 3) {
      console.log(JSON.stringify(await publishIndividualSales(directory), null, 2));
    } else if (process.argv.length === 2) {
      store = new Store(join(directory, 'public-individual-sales.sqlite'));
      console.log(JSON.stringify(await pollIndividualSales(store), null, 2));
    } else throw new Error('Usage: npm run individual -- [--publish]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { store?.close(); }
}
