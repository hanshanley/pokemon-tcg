import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store, retainVolumeRunScopes } from './store.js';
import { syncCatalog } from './catalog.js';
import { historyBrowser, syncVolume } from './volume.js';

export function retryFailedJobs(store, date) {
  return store.db.prepare(`UPDATE volume_jobs SET status='pending',attempts=0,warning=''
    WHERE date_utc=? AND status='failed'`).run(date).changes;
}

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
    for (const table of ['daily_sale_prices', 'price_checks', 'volume_export_days', 'volume_run_products']) {
      if (target.db.prepare('SELECT 1 FROM original.sqlite_master WHERE type=? AND name=?')
        .get('table',table)) target.db.exec(`INSERT INTO ${table} SELECT * FROM original.${table}`);
    }
    retainVolumeRunScopes(target.db);
    target.refreshSaleValues();
    target.db.exec('COMMIT; DETACH DATABASE original; PRAGMA wal_checkpoint(TRUNCATE)');
    return target.db.prepare('SELECT count(*) AS sku_buckets FROM daily_volume').get();
  } finally { target.close(); }
}

export async function collectRemote(store, {
  limit = 2000, signal, refreshCatalog = syncCatalog, createTransport = historyBrowser,
  pause = delay => sleep(delay, undefined, { signal }), log = console.log, now = () => new Date(),
  requestPause = () => sleep(500),
  queueDate,
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) {
    throw new Error('Each remote collection pass must request between 1 and 2000 products.');
  }
  queueDate ??= now().toISOString().slice(0,10);
  let failures = 0, remaining = limit, denialRechecks = 0;
  const completed = () => store.db.prepare(`SELECT count(*) AS n FROM volume_jobs
    WHERE status IN ('success','empty')`).get().n;
  while (remaining > 0) {
    if (signal?.aborted) return null;
    let transport, requests = 0;
    const before = completed();
    try {
      await refreshCatalog(store);
      if (signal?.aborted) return null;
      transport = await createTransport();
      let state;
      while (requests < remaining && !signal?.aborted) {
        try {
          state = await syncVolume(store, { ...transport, limit: remaining - requests, signal, log, now, queueDate,
            pause: requestPause,
            fetchHistory: async id => {
              try {
                for (let retry = 0; ; retry++) {
                  if (requests >= remaining) throw Object.assign(
                    new Error('Remote pass request budget exhausted.'), { code: 'HISTORY_REQUEST_LIMIT' });
                  requests++;
                  const response = await transport.fetchHistory(id);
                  if (!(response.status >= 500 && response.status <= 599) || retry >= 2 ||
                      requests >= remaining || signal?.aborted) return response;
                  log(`History HTTP ${response.status} for product ${id}; retry ${retry + 1}/2 within the pass request budget.`);
                  await pause(retry === 0 ? 5000 : 15000);
                  if (signal?.aborted) throw Object.assign(
                    new Error('Remote collection deadline reached.'), { code: 'HISTORY_REQUEST_LIMIT' });
                  await requestPause();
                }
              } catch (error) {
                if (error.status == null && error.code !== 'HISTORY_REQUEST_LIMIT') error.code = 'HISTORY_TRANSPORT';
                throw error;
              }
            } });
          if (state.status !== 'paused') return state;
        } catch (error) {
          if (error.status !== 403 || denialRechecks || completed() === before || requests >= remaining) throw error;
          denialRechecks++;
          log('History HTTP 403 after successful observations; pausing requests for 30 minutes before one same-session recheck.');
          await pause(1800000);
        }
      }
      return signal?.aborted ? null : state;
    } catch (error) {
      if (signal?.aborted) return null;
      remaining -= requests;
      const productive = completed() > before;
      failures = productive ? 0 : failures + 1;
      if ([401, 403].includes(error.status)) throw error;
      if (failures >= 3) {
        if (error.code !== 'HISTORY_TRANSPORT' || error.status != null) throw error;
        log('Transport retry budget exhausted; checkpointing pending products for the next scheduled pass.');
        return store.db.prepare('SELECT * FROM volume_runs ORDER BY date_utc DESC LIMIT 1').get();
      }
      if (remaining <= 0) {
        if (error.status === 429) throw error;
        return store.db.prepare('SELECT * FROM volume_runs ORDER BY date_utc DESC LIMIT 1').get();
      }
      log(`Remote pass unavailable: ${error.message}`);
      if (transport) { await transport.close(); transport = null; }
      await pause(error.status === 429 ? 1800000 : productive ? 15000 : 900000);
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
      if (![4,5].includes(args.length) || args[0] !== '--limit' || args[2] !== '--minutes' ||
          args.length === 5 && args[4] !== '--retry-failed') {
        throw new Error('Usage: node src/remote.js --limit PRODUCTS --minutes MINUTES [--retry-failed] | --checkpoint SOURCE DESTINATION');
      }
      const limit = Number(args[1]), minutes = Number(args[3]);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000 ||
          !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 240) {
        throw new Error('Provide a product limit of 1-2000 and 1-240 minutes.');
      }
      store = new Store(resolve(process.env.DATA_DIR ?? 'data', 'sales.sqlite'));
      if (args[4]) console.log(`Requeued ${retryFailedJobs(store,
        process.env.COLLECTION_DATE ?? new Date().toISOString().slice(0,10))} failed products for a bounded fresh validation.`);
      timer = setTimeout(() => signal.abort(), minutes * 60000);
      console.log(JSON.stringify(await collectRemote(store, {
        limit, signal: signal.signal, queueDate: process.env.COLLECTION_DATE,
      }), null, 2));
    }
  } catch (error) {
    if (!signal.signal.aborted) { console.error(error.message); process.exitCode = 1; }
  } finally { clearTimeout(timer); if (store) store.close(); }
}
