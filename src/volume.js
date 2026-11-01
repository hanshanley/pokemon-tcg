import { chromium } from 'playwright';
import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { syncCatalog } from './catalog.js';

const singleConditions = new Set([
  'Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged',
]);

function integer(value, name) {
  if (!(typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) ||
      !Number.isSafeInteger(Number(value)) || Number(value) < 0) {
    throw new Error(`Invalid ${name}; no volume inferred.`);
  }
  return Number(value);
}

export function monthHistory(payload) {
  if (!payload || payload.error || !Number.isSafeInteger(payload.count) || payload.count < 0) {
    throw new Error('Unexpected daily-history response.');
  }
  if (payload.count === 0 && (payload.result == null ||
      Array.isArray(payload.result) && payload.result.length === 0)) return [];
  if (!Array.isArray(payload.result) || payload.result.length !== payload.count) {
    throw new Error('Daily-history SKU count does not match the response.');
  }
  const seen = new Set(), rows = [];
  for (const sku of payload.result) {
    const id = integer(sku.skuId, 'SKU ID');
    if (!id || seen.has(id)) throw new Error('Invalid or duplicate history SKU.');
    seen.add(id);
    for (const field of ['condition', 'variant', 'language']) {
      if (typeof sku[field] !== 'string' || !sku[field].trim() || sku[field].length > 200) {
        throw new Error(`Missing history ${field}.`);
      }
    }
    if (!Array.isArray(sku.buckets) || sku.buckets.length !== 30) {
      throw new Error('Expected 30 one-day buckets; coarser or incomplete history is not daily volume.');
    }
    const dates = [];
    for (const bucket of sku.buckets) {
      const date = bucket.bucketStartDate;
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
          new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
        throw new Error('Invalid source bucket date.');
      }
      dates.push(date);
      rows.push({
        sku_id: id, date_source: date,
        kind: sku.condition === 'Unopened' ? 'sealed'
          : singleConditions.has(sku.condition) ? 'single' : 'other',
        condition: sku.condition, variant: sku.variant, language: sku.language,
        quantity: integer(bucket.quantitySold, 'quantity'),
        transaction_count: integer(bucket.transactionCount, 'transaction count'),
      });
    }
    dates.sort();
    if (dates.some((date, index) => index > 0 &&
        Date.parse(date) - Date.parse(dates[index - 1]) !== 86400000)) {
      throw new Error('History buckets are not distinct consecutive one-day dates.');
    }
  }
  return rows;
}

export function saveMonthHistory(store, productId, payload, now = new Date().toISOString(), runDate) {
  const rows = monthHistory(payload);
  if (!store.db.prepare('SELECT 1 FROM catalog_products WHERE product_id=?').get(productId)) {
    throw new Error('History product is not in the Pokemon catalog.');
  }
  const insert = store.db.prepare(`INSERT INTO daily_volume
    (product_id,sku_id,date_source,kind,condition,variant,language,quantity,transaction_count,first_seen,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(product_id,sku_id,date_source) DO UPDATE SET
      kind=excluded.kind,condition=excluded.condition,variant=excluded.variant,
      language=excluded.language,quantity=excluded.quantity,
      transaction_count=excluded.transaction_count,last_seen=excluded.last_seen`);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) insert.run(productId, ...Object.values(row), now, now);
    if (runDate) store.db.prepare(`UPDATE volume_jobs
      SET status=?,fetched_at=?,buckets=?,warning='' WHERE date_utc=? AND product_id=?`)
      .run(rows.length ? 'success' : 'empty', now, rows.length, runDate, productId);
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return rows.length;
}

export async function syncVolume(store, {
  fetchHistory, limit = Number.MAX_SAFE_INTEGER, pause = () => sleep(250),
  now = () => new Date(), signal, log = console.log,
} = {}) {
  if (typeof fetchHistory !== 'function' || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Provide a history transport and a positive integer limit.');
  }
  const started = now().toISOString(), date = started.slice(0, 10);
  store.db.prepare(`INSERT OR IGNORE INTO volume_runs
    (date_utc,started_at,updated_at,status) VALUES (?,?,?,'paused')`).run(date, started, started);
  store.db.prepare(`INSERT OR IGNORE INTO volume_jobs (date_utc,product_id)
    SELECT ?,product_id FROM catalog_products WHERE is_current=1`).run(date);
  const progress = (status, warning = '') => {
    store.db.prepare(`UPDATE volume_runs SET status=?,updated_at=?,warning=?,
      finished_at=CASE WHEN ? IN ('complete','partial') THEN ? ELSE NULL END,
      products_expected=(SELECT count(*) FROM volume_jobs WHERE date_utc=?),
      products_checked=(SELECT count(*) FROM volume_jobs WHERE date_utc=? AND status<>'pending'),
      products_with_history=(SELECT count(*) FROM volume_jobs WHERE date_utc=? AND status='success'),
      products_without_history=(SELECT count(*) FROM volume_jobs WHERE date_utc=? AND status='empty'),
      products_failed=(SELECT count(*) FROM volume_jobs WHERE date_utc=? AND status='failed')
      WHERE date_utc=?`).run(status, now().toISOString(), warning, status, now().toISOString(),
      date, date, date, date, date, date);
    return store.db.prepare('SELECT * FROM volume_runs WHERE date_utc=?').get(date);
  };
  const jobs = store.db.prepare(`SELECT j.product_id FROM volume_jobs j
    JOIN catalog_products c ON c.product_id=j.product_id
    WHERE j.date_utc=? AND j.status IN ('pending','failed') AND j.attempts<3
    ORDER BY c.category_id,c.product_id LIMIT ?`).all(date, limit);
  progress('running');
  let consecutiveFailures = 0;
  try {
    for (const [index, job] of jobs.entries()) {
      if (signal?.aborted) break;
      await pause();
      if (signal?.aborted) break;
      store.db.prepare('UPDATE volume_jobs SET attempts=attempts+1 WHERE date_utc=? AND product_id=?')
        .run(date, job.product_id);
      try {
        const response = await fetchHistory(job.product_id);
        if (response.status !== 200) {
          const error = new Error(`History HTTP ${response.status}; unavailable data, not zero sales.`);
          error.status = response.status;
          throw error;
        }
        saveMonthHistory(store, job.product_id, response.body, now().toISOString(), date);
        consecutiveFailures = 0;
      } catch (error) {
        store.db.prepare(`UPDATE volume_jobs SET status='failed',fetched_at=?,warning=?
          WHERE date_utc=? AND product_id=?`).run(now().toISOString(), error.message, date, job.product_id);
        consecutiveFailures++;
        if ([401, 403, 429].includes(error.status) || consecutiveFailures >= 3) throw error;
      }
      if ((index + 1) % 25 === 0) {
        const state = progress('running');
        log(`Daily history: ${state.products_checked}/${state.products_expected} products checked; ${state.products_with_history} with history, ${state.products_without_history} empty, ${state.products_failed} failed.`);
      }
    }
    const state = progress('paused');
    const unfinished = store.db.prepare(`SELECT count(*) AS n FROM volume_jobs
      WHERE date_utc=? AND status IN ('pending','failed') AND attempts<3`).get(date).n;
    return progress(unfinished ? 'paused' : state.products_failed ? 'partial' : 'complete');
  } catch (error) {
    progress('failed', error.message);
    throw error;
  }
}

export async function historyBrowser() {
  const browser = await chromium.launch({
    headless: process.env.HEADLESS === '1',
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
  });
  try {
    const page = await browser.newPage();
    const response = await page.goto('https://www.tcgplayer.com', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    });
    if (!response?.ok() || new URL(page.url()).hostname !== 'www.tcgplayer.com') {
      throw new Error('Public storefront context is unavailable.');
    }
    return {
      close: () => browser.close(),
      fetchHistory: id => page.evaluate(async productId => {
        const result = await fetch(
          `https://infinite-api.tcgplayer.com/price/history/${productId}/detailed?range=month`,
          { signal: AbortSignal.timeout(20000) });
        return { status: result.status, body: result.ok ? await result.json() : null };
      }, id),
    };
  } catch (error) { await browser.close(); throw error; }
}

function lock(path) {
  try {
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid volume lock; inspect it before restarting.');
    try { process.kill(pid, 0); }
    catch (error) {
      if (error.code !== 'ESRCH') throw error;
      unlinkSync(path);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let fd;
  try { fd = openSync(path, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('A daily-volume collector is already running.');
    throw error;
  }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return () => { unlinkSync(path); };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.env.DATA_DIR ?? 'data');
  const store = new Store(resolve(dir, 'sales.sqlite'));
  const signal = new AbortController();
  process.once('SIGINT', () => signal.abort());
  process.once('SIGTERM', () => signal.abort());
  let unlock, transport;
  try {
    const args = process.argv.slice(2), watch = args.includes('--watch');
    const index = args.indexOf('--limit');
    const limit = index < 0 ? Number.MAX_SAFE_INTEGER : Number(args[index + 1]);
    if (!(args.length === 0 || args.length === 1 && args[0] === '--watch' ||
        args.length === 2 && args[0] === '--limit') ||
        !Number.isSafeInteger(limit) || limit < 1 || watch && index >= 0) {
      throw new Error('Usage: npm run volume -- [--limit POSITIVE_INTEGER | --watch]');
    }
    unlock = lock(resolve(dir, 'volume.lock'));
    do {
      await syncCatalog(store);
      transport = await historyBrowser();
      let state, retryDelay;
      try { state = await syncVolume(store, { ...transport, limit, signal: signal.signal }); }
      catch (error) {
        if (!watch || [401, 403].includes(error.status)) throw error;
        console.error(error.message);
        state = store.db.prepare('SELECT * FROM volume_runs ORDER BY date_utc DESC LIMIT 1').get();
        retryDelay = error.status === 429 ? 1800000 : 900000;
      }
      finally { await transport.close(); transport = null; }
      console.log(JSON.stringify(state, null, 2));
      if (!watch || signal.signal.aborted) break;
      const current = new Date(), tomorrow = new Date(current);
      tomorrow.setUTCHours(24, 15, 0, 0);
      const delay = retryDelay ?? (state.status === 'paused' ? 900000 : tomorrow - current);
      console.log(`Next daily-history pass: ${new Date(Date.now() + delay).toISOString()}`);
      await sleep(delay, undefined, { signal: signal.signal }).catch(error => {
        if (error.name !== 'AbortError') throw error;
      });
    } while (!signal.signal.aborted);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { if (transport) await transport.close(); if (unlock) unlock(); store.close(); }
}
