import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, normalizeSale, volumeSource } from './store.js';

export async function importTransactions(store, path, source) {
  if (typeof source !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(source) ||
      ['snapshot', volumeSource].includes(source)) throw new Error('Provide a non-reserved source name.');
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const insert = store.db.prepare(`INSERT INTO bulk_sales
    (source,transaction_key,product_id,kind,sold_at,quantity,unit_price_cents,shipping_cents,
      condition,variant,language,listing_type,first_seen,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source,transaction_key) DO UPDATE SET last_seen=excluded.last_seen`);
  const existing = store.db.prepare(
    'SELECT * FROM bulk_sales WHERE source=? AND transaction_key=?'
  );
  const product = store.db.prepare('SELECT product_id FROM catalog_products WHERE product_id=?');
  let line = 0, added = 0, read = 0;
  const now = new Date().toISOString();
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for await (const text of lines) {
      line++;
      if (!text.trim()) continue;
      if (Buffer.byteLength(text) > 1_000_000) throw new Error('Transaction line exceeds 1 MB.');
      const row = JSON.parse(text);
      if (row == null || typeof row !== 'object' || Array.isArray(row) ||
          typeof row.transaction_id !== 'string' || !row.transaction_id.trim() ||
          row.transaction_id.length > 300 || !Number.isSafeInteger(row.product_id) ||
          !['single', 'sealed', 'other'].includes(row.kind)) {
        throw new Error('Each transaction requires a stable transaction_id, product_id and kind.');
      }
      if (!product.get(row.product_id)) throw new Error(`Product ${row.product_id} is not in the Pokemon catalog.`);
      if (row.currency != null && row.currency !== 'USD') throw new Error('Only USD transactions are supported.');
      if (row.status != null && row.status !== 'completed') throw new Error('Only completed sales may be imported.');
      const sale = normalizeSale(row);
      const key = createHash('sha256').update(row.transaction_id).digest('hex');
      const previous = existing.get(source, key);
      if (previous && (previous.product_id !== row.product_id || previous.kind !== row.kind ||
          Object.entries(sale).some(([field, value]) => previous[field] !== value))) {
        throw new Error('A transaction ID was reused with different transaction data.');
      }
      if (!previous) added++;
      insert.run(source, key, row.product_id, row.kind, ...Object.values(sale), now, now);
      read++;
    }
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw new Error(`Import rejected at line ${line}; no rows committed: ${error.message}`);
  } finally { lines.close(); input.destroy(); }
  return { source, rows_read: read, rows_added: added,
    coverage: 'Imported transactions; source completeness is unverified.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = new Store(resolve(process.env.DATA_DIR ?? 'data', 'sales.sqlite'));
  try {
    if (!process.argv[2]) throw new Error('Usage: npm run import -- FILE.jsonl SOURCE_NAME');
    console.log(JSON.stringify(await importTransactions(store, resolve(process.argv[2]), process.argv[3]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { store.close(); }
}
