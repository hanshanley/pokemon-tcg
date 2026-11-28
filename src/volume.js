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

function salePrice(value) {
  if (value == null || value === '') return null;
  if (!['number', 'string'].includes(typeof value) ||
      !/^\d+(?:\.\d{1,2})?$/.test(String(value)) ||
      !Number.isSafeInteger(Math.round(Number(value) * 100))) {
    throw new Error('Invalid actual sale price; no dollar volume inferred.');
  }
  return Math.round(Number(value) * 100);
}

export function monthHistory(payload, expectedDays = 30) {
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
    if (!Array.isArray(sku.buckets) || sku.buckets.length !== expectedDays) {
      throw new Error(`Expected ${expectedDays} one-day buckets; coarser or incomplete history is not daily volume.`);
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
      const low = salePrice(bucket.lowSalePrice), high = salePrice(bucket.highSalePrice);
      if (low != null && high != null && low > high) throw new Error('Inverted sale-price bounds.');
      rows.push({
        sku_id: id, date_source: date,
        kind: sku.condition === 'Unopened' ? 'sealed'
          : singleConditions.has(sku.condition) ? 'single' : 'other',
        condition: sku.condition, variant: sku.variant, language: sku.language,
        quantity: integer(bucket.quantitySold, 'quantity'),
        transaction_count: integer(bucket.transactionCount, 'transaction count'),
        low_cents: low, high_cents: high,
        low_with_shipping_cents: salePrice(bucket.lowSalePriceWithShipping),
        high_with_shipping_cents: salePrice(bucket.highSalePriceWithShipping),
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

export function saveMonthHistory(store, productId, payload, now = new Date().toISOString(), runDate,
  requiredEndDate, expectedDays = 30) {
  const rows = monthHistory(payload, expectedDays);
  if (requiredEndDate) {
    const start = new Date(Date.parse(requiredEndDate) - (expectedDays - 1) * 86400000).toISOString().slice(0, 10);
    if (rows.some(row => row.date_source < start || row.date_source > requiredEndDate)) {
      throw new Error('History does not cover the required observation window.');
    }
  }
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
  store.db.exec('SAVEPOINT save_month_history');
  try {
    const prices = store.db.prepare(`INSERT INTO daily_sale_prices VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(product_id,sku_id,date_source) DO UPDATE SET
        low_cents=excluded.low_cents,high_cents=excluded.high_cents,
        low_with_shipping_cents=excluded.low_with_shipping_cents,
        high_with_shipping_cents=excluded.high_with_shipping_cents,observed_at=excluded.observed_at`);
    for (const row of rows) {
      insert.run(productId, row.sku_id, row.date_source, row.kind, row.condition,
        row.variant, row.language, row.quantity, row.transaction_count, now, now);
      prices.run(productId,row.sku_id,row.date_source,row.low_cents,row.high_cents,
        row.low_with_shipping_cents,row.high_with_shipping_cents,now);
    }
    store.db.prepare(`INSERT INTO price_checks VALUES (?,?)
      ON CONFLICT(product_id) DO UPDATE SET checked_at=excluded.checked_at`).run(productId,now);
    store.refreshSaleValues(productId);
    store.db.prepare('DELETE FROM volume_product_days WHERE product_id=?').run(productId);
    store.db.prepare(`INSERT INTO volume_product_days
      SELECT product_id,date_source,kind,sum(quantity),sum(transaction_count),count(*)
      FROM daily_volume WHERE product_id=? GROUP BY product_id,date_source,kind`).run(productId);
    if (runDate) store.db.prepare(`UPDATE volume_jobs
      SET status=?,fetched_at=?,buckets=?,warning='' WHERE date_utc=? AND product_id=?`)
      .run(rows.length ? 'success' : 'empty', now, rows.length, runDate, productId);
    store.db.exec('RELEASE save_month_history');
  } catch (error) {
    store.db.exec('ROLLBACK TO save_month_history; RELEASE save_month_history');
    throw error;
  }
  return rows.length;
}

export async function syncVolume(store, {
  fetchHistory, limit = Number.MAX_SAFE_INTEGER, pause = () => sleep(250),
  now = () => new Date(), queueDate, signal, log = console.log,
} = {}) {
  if (typeof fetchHistory !== 'function' || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Provide a history transport and a positive integer limit.');
  }
  const started = now().toISOString(), date = queueDate ?? started.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0,10) !== date || date > started.slice(0,10)) {
    throw new Error('Provide a valid queue date no later than the observation date.');
  }
  if (store.db.prepare('SELECT 1 FROM volume_export_days WHERE date_utc=?').get(date)) {
    throw new Error('This queue already contains a closed-day export; do not mix it with a native sweep.');
  }
  store.db.prepare(`INSERT OR IGNORE INTO volume_runs
    (date_utc,started_at,updated_at,status) VALUES (?,?,?,'paused')`).run(date, started, started);
  store.db.prepare(`INSERT OR IGNORE INTO volume_jobs (date_utc,product_id)
    SELECT ?,product_id FROM catalog_products WHERE is_current=1`).run(date);
  store.db.prepare(`UPDATE volume_jobs SET status='pending',attempts=0,warning=''
    WHERE date_utc=? AND status='success'
      AND product_id IN (SELECT product_id FROM catalog_products WHERE is_current=1)
      AND (NOT EXISTS
      (SELECT 1 FROM price_checks p WHERE p.product_id=volume_jobs.product_id
        AND p.checked_at>=?) OR NOT EXISTS
      (SELECT 1 FROM daily_volume v WHERE v.product_id=volume_jobs.product_id
        AND v.date_source=volume_jobs.date_utc AND v.last_seen>=volume_jobs.fetched_at))`)
    .run(date, `${date}T00:00:00.000Z`);
  const progress = (status, warning = '') => {
    store.db.prepare(`WITH current_jobs AS (
      SELECT j.status FROM volume_jobs j JOIN catalog_products c ON c.product_id=j.product_id
      WHERE j.date_utc=? AND c.is_current=1
    ) UPDATE volume_runs SET status=?,updated_at=?,warning=?,
      finished_at=CASE WHEN ? IN ('complete','partial') THEN ? ELSE NULL END,
      products_expected=(SELECT count(*) FROM current_jobs),
      products_checked=(SELECT count(*) FROM current_jobs WHERE status<>'pending'),
      products_with_history=(SELECT count(*) FROM current_jobs WHERE status='success'),
      products_without_history=(SELECT count(*) FROM current_jobs WHERE status='empty'),
      products_failed=(SELECT count(*) FROM current_jobs WHERE status='failed')
      WHERE date_utc=?`).run(date, status, now().toISOString(), warning, status, now().toISOString(), date);
    return store.db.prepare('SELECT * FROM volume_runs WHERE date_utc=?').get(date);
  };
  const jobs = store.db.prepare(`SELECT j.product_id FROM volume_jobs j
    JOIN catalog_products c ON c.product_id=j.product_id
    WHERE j.date_utc=? AND c.is_current=1 AND j.status IN ('pending','failed') AND j.attempts<3
    ORDER BY CASE WHEN j.status='pending' THEN j.fetched_at END IS NOT NULL,
      CASE WHEN j.status='pending' THEN j.fetched_at END,
      c.category_id,c.product_id LIMIT ?`).all(date, limit);
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
        if (['HISTORY_TRANSPORT','HISTORY_REQUEST_LIMIT'].includes(error.code)) {
          store.db.prepare(`UPDATE volume_jobs SET status='pending',attempts=attempts-1,fetched_at=?,warning=?
            WHERE date_utc=? AND product_id=?`).run(now().toISOString(), error.message, date, job.product_id);
          log(`History transport unavailable for product ${job.product_id}: ${error.message}`);
          throw error;
        }
        store.db.prepare(`UPDATE volume_jobs SET status='failed',fetched_at=?,warning=?
          WHERE date_utc=? AND product_id=?`).run(now().toISOString(), error.message, date, job.product_id);
        log(`History unavailable for product ${job.product_id}: ${error.message}`);
        consecutiveFailures++;
        if ([401, 403, 429].includes(error.status) || consecutiveFailures >= 3) throw error;
      }
      if ((index + 1) % 25 === 0) {
        const state = progress('running');
        log(`Daily history: ${state.products_checked}/${state.products_expected} products checked; ${state.products_with_history} with history, ${state.products_without_history} empty, ${state.products_failed} failed.`);
      }
    }
    const state = progress('paused');
    const unfinished = store.db.prepare(`SELECT count(*) AS n FROM volume_jobs j
      JOIN catalog_products c ON c.product_id=j.product_id
      WHERE j.date_utc=? AND c.is_current=1 AND j.status IN ('pending','failed') AND j.attempts<3`).get(date).n;
    const result = progress(unfinished ? 'paused' : state.products_failed ? 'partial' : 'complete');
    if (result.status === 'complete') store.db.prepare(`INSERT INTO volume_run_products
      SELECT ?,json_group_array(product_id) FROM catalog_products WHERE is_current=1
      ON CONFLICT(date_utc) DO UPDATE SET product_ids=excluded.product_ids`).run(date);
    return result;
  } catch (error) {
    progress(['HISTORY_TRANSPORT','HISTORY_REQUEST_LIMIT'].includes(error.code) ? 'paused' : 'failed', error.message);
    throw error;
  }
}

export async function historyFetcher(page, urlFor = id =>
  `https://infinite-api.tcgplayer.com/price/history/${id}/detailed?range=month`) {
  const session = await page.context().newCDPSession(page);
  let active;
  session.on('Network.requestWillBeSent', ({ requestId, request }) => {
    if (active && request.url === active.url) active.requests.add(requestId);
  });
  session.on('Network.responseReceivedExtraInfo', ({ requestId, statusCode }) => {
    if (active) active.statuses.set(requestId,statusCode);
  });
  await session.send('Network.enable');
  return async id => {
    const state = { url: urlFor(id), requests: new Set(), statuses: new Map() };
    active = state;
    try {
      return await page.evaluate(async url => {
        const result = await fetch(url, { signal: AbortSignal.timeout(20000) });
        return { status: result.status, body: result.ok ? await result.json() : null };
      },state.url);
    } catch (error) {
      // Observe hidden HTTP errors without reading cross-origin blocked bodies.
      const status = [...state.requests].map(key => state.statuses.get(key)).findLast(code => code >= 400);
      if (status) return { status, body: null };
      throw error;
    } finally { active = null; }
  };
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
      const error = new Error('Public storefront context is unavailable.');
      error.status = response?.status();
      throw error;
    }
    return {
      close: () => browser.close(),
      fetchHistory: await historyFetcher(page),
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
