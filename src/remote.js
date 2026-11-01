import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from './store.js';
import { syncCatalog } from './catalog.js';
import { historyBrowser, syncVolume } from './volume.js';

export function publicCheckpoint(source, destination) {
  if (resolve(source) === resolve(destination)) throw new Error('Checkpoint must not overwrite its source.');
  if (existsSync(destination)) throw new Error('Public checkpoint destination must be a new file.');
  const target = new Store(destination);
  try {
    const uri = pathToFileURL(resolve(source));
    uri.searchParams.set('mode', 'ro');
    target.db.prepare('ATTACH DATABASE ? AS original').run(uri.href);
    target.db.exec(`
      BEGIN;
      INSERT INTO catalog_products SELECT * FROM original.catalog_products;
      INSERT INTO pokemon_species SELECT * FROM original.pokemon_species;
      INSERT INTO catalog_downloads SELECT * FROM original.catalog_downloads;
      INSERT INTO catalog_runs SELECT id,source_build,started_at,finished_at,status,
        groups_expected,groups_downloaded,'' FROM original.catalog_runs;
      INSERT INTO daily_volume SELECT * FROM original.daily_volume;
      INSERT INTO volume_product_days
        SELECT product_id,date_source,kind,sum(quantity),sum(transaction_count),count(*)
        FROM daily_volume GROUP BY product_id,date_source,kind;
      INSERT INTO volume_runs SELECT date_utc,started_at,updated_at,finished_at,
        CASE WHEN status IN ('running','failed') THEN 'paused' ELSE status END,
        products_expected,products_checked,products_with_history,products_without_history,
        products_failed,'' FROM original.volume_runs;
      INSERT INTO volume_jobs SELECT date_utc,product_id,status,attempts,fetched_at,buckets,''
        FROM original.volume_jobs;
    `);
    for (const table of ['daily_sale_prices', 'price_checks']) {
      if (target.db.prepare('SELECT 1 FROM original.sqlite_master WHERE type=? AND name=?')
        .get('table',table)) target.db.exec(`INSERT INTO ${table} SELECT * FROM original.${table}`);
    }
    target.refreshSaleValues();
    target.db.exec('COMMIT; DETACH DATABASE original; PRAGMA wal_checkpoint(TRUNCATE)');
    return target.db.prepare('SELECT count(*) AS sku_buckets FROM daily_volume').get();
  } finally { target.close(); }
}

export async function collectRemote(store, {
  limit = 25000, signal, refreshCatalog = syncCatalog, createTransport = historyBrowser,
  pause = delay => sleep(delay, undefined, { signal }), log = console.log,
} = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) return null;
    let transport;
    try {
      await refreshCatalog(store);
      if (signal?.aborted) return null;
      transport = await createTransport();
      return await syncVolume(store, { ...transport, limit, signal, log });
    } catch (error) {
      if (signal?.aborted) return null;
      if ([401, 403].includes(error.status) || attempt === 2) throw error;
      log(`Remote pass unavailable: ${error.message}`);
      if (transport) { await transport.close(); transport = null; }
      await pause(error.status === 429 ? 1800000 : 900000);
    } finally { if (transport) await transport.close(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let store, timer;
  const signal = new AbortController();
  process.once('SIGINT', () => signal.abort());
  process.once('SIGTERM', () => signal.abort());
  try {
    const args = process.argv.slice(2);
    if (args.length === 3 && args[0] === '--checkpoint') {
      console.log(JSON.stringify(publicCheckpoint(args[1], args[2])));
    } else {
      if (args.length !== 4 || args[0] !== '--limit' || args[2] !== '--minutes') {
        throw new Error('Usage: node src/remote.js --limit PRODUCTS --minutes MINUTES | --checkpoint SOURCE DESTINATION');
      }
      const limit = Number(args[1]), minutes = Number(args[3]);
      if (!Number.isSafeInteger(limit) || limit < 1 ||
          !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 240) {
        throw new Error('Provide a positive product limit and 1-240 minutes.');
      }
      store = new Store(resolve(process.env.DATA_DIR ?? 'data', 'sales.sqlite'));
      timer = setTimeout(() => signal.abort(), minutes * 60000);
      console.log(JSON.stringify(await collectRemote(store, { limit, signal: signal.signal }), null, 2));
    }
  } catch (error) {
    if (!signal.signal.aborted) { console.error(error.message); process.exitCode = 1; }
  } finally { clearTimeout(timer); if (store) store.close(); }
}
