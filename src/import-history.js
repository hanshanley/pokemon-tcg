import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { Store, volumeSource } from './store.js';
import { saveMonthHistory } from './volume.js';

export async function importHistory(store, path, now = new Date()) {
  const db = store.db;
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let line = 0, date, observed, products = 0, withHistory = 0, buckets = 0;
  let remaining;
  db.exec('BEGIN IMMEDIATE');
  try {
    const catalog = db.prepare(`SELECT product_id, source_build FROM catalog_products WHERE is_current=1`).all();
    const build = db.prepare(`SELECT source_build FROM catalog_runs
      WHERE status='complete' ORDER BY id DESC LIMIT 1`).get()?.source_build;
    if (!catalog.length || !build || catalog.some(product => product.source_build !== build)) {
      throw new Error('Restore or sync a complete catalog before importing history.');
    }
    remaining = new Set(catalog.map(product => product.product_id));
    const addJob = db.prepare(`INSERT INTO volume_jobs (date_utc,product_id) VALUES (?,?)`);
    for await (const text of lines) {
      line++;
      if (!text.trim()) continue;
      if (Buffer.byteLength(text) > 5_000_000) throw new Error('History line exceeds 5 MB.');
      let row;
      try { row = JSON.parse(text); } catch { throw new Error('Invalid JSON in history export.'); }
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Expected a JSON object.');
      if (!observed) {
        const time = Date.parse(row.observed_at);
        if (row.format !== 'tcgplayer-sku-history-v1' || row.source !== volumeSource ||
            row.catalog_source_build !== build || row.products_expected !== catalog.length ||
            !Number.isFinite(time) || new Date(time).toISOString() !== row.observed_at ||
            time > now.getTime() || row.observed_at.slice(0, 10) !== now.toISOString().slice(0, 10)) {
          throw new Error('Export must match the complete catalog and have a current UTC observation timestamp.');
        }
        observed = row.observed_at;
        date = observed.slice(0, 10);
        if (db.prepare(`SELECT 1 FROM price_checks p JOIN catalog_products c USING(product_id)
          WHERE c.is_current=1 AND p.checked_at>=? LIMIT 1`).get(observed)) {
          throw new Error('Export must be newer than the existing saved observations.');
        }
        db.prepare(`DELETE FROM volume_jobs WHERE date_utc=?
          AND product_id IN (SELECT product_id FROM catalog_products WHERE is_current=1)`).run(date);
        db.prepare(`INSERT INTO volume_runs (date_utc,started_at,updated_at,status) VALUES (?,?,?,'running')
          ON CONFLICT(date_utc) DO UPDATE SET started_at=excluded.started_at,updated_at=excluded.updated_at,
          finished_at=NULL,status='running'`).run(date, observed, observed);
        continue;
      }
      if (!remaining.delete(row.product_id)) throw new Error('Unknown or duplicate catalog product.');
      if (!row.history || !Object.hasOwn(row.history, 'result') || !Array.isArray(row.history.result)) {
        throw new Error('Each product must explicitly provide its history, including an empty result if applicable.');
      }
      addJob.run(date, row.product_id);
      const saved = saveMonthHistory(store, row.product_id, row.history, observed, date, date);
      products++;
      buckets += saved;
      withHistory += Number(saved > 0);
    }
    if (!observed || remaining.size || !withHistory) {
      throw new Error(`Missing header, all histories empty, or incomplete catalog (${remaining.size} products missing).`);
    }
    db.prepare(`UPDATE volume_runs SET updated_at=?,finished_at=?,status='complete',warning='Offline authorized export',
      products_expected=?,products_checked=?,products_with_history=?,products_without_history=?,products_failed=0
      WHERE date_utc=?`).run(observed, observed, products, products, withHistory, products - withHistory, date);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`History import rejected at line ${line}; no rows committed: ${error.message}`);
  } finally { lines.close(); input.destroy(); }
  return { source: volumeSource, observed_at: observed, products_checked: products,
    products_with_history: withHistory, products_without_history: products - withHistory, buckets };
}

export async function fetchHistoryExport(store, address, {
  fetcher = fetch, now = () => new Date(),
} = {}) {
  let url;
  try { url = new URL(address); } catch { throw new Error('Configure an approved HTTPS history export URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Configure an approved HTTPS history export URL without inline credentials.');
  }
  const directory = await mkdtemp(join(tmpdir(), 'tcg-history-export-'));
  const path = join(directory, 'history.jsonl');
  try {
    let response;
    try { response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(600_000) }); }
    catch { throw new Error('Authorized history export request failed or redirected.'); }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error(`Authorized history export unavailable (HTTP ${response.status}).`);
    }
    try {
      await pipeline(Readable.fromWeb(response.body), async function* (chunks) {
        let bytes = 0;
        for await (const chunk of chunks) {
          bytes += chunk.length;
          if (bytes > 4 * 1024 ** 3) throw new Error('Export too large.');
          yield chunk;
        }
      }, createWriteStream(path, { mode: 0o600 }));
    } catch { throw new Error('Authorized history export download was incomplete or exceeded 4 GiB.'); }
    return await importHistory(store, path, now());
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) {
      throw new Error('Usage: npm run import:history -- AUTHORIZED_EXPORT.jsonl | --download');
    }
    const store = new Store(resolve(process.env.DATA_DIR ?? 'data', 'sales.sqlite'));
    try {
      const result = process.argv[2] === '--download'
        ? await fetchHistoryExport(store, process.env.TCGPLAYER_HISTORY_EXPORT_URL)
        : await importHistory(store, resolve(process.argv[2]));
      console.log(JSON.stringify(result, null, 2));
    }
    finally { store.close(); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
