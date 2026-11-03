import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const volumeSource = 'tcgplayer-daily';

export function productIdFromUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'www.tcgplayer.com' || url.port ||
      url.username || url.password) {
    throw new Error('Use an HTTPS product URL from www.tcgplayer.com.');
  }
  const match = url.pathname.match(/^\/product\/(\d+)(?:\/|$)/);
  if (!match) throw new Error('The URL must point to a TCGplayer product.');
  return Number(match[1]);
}

export function normalizeSale(row) {
  const timestamp = row.orderDate ?? row.order_date ?? row.date;
  if (typeof timestamp !== 'string' ||
      !/(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) ||
      !Number.isFinite(Date.parse(timestamp))) {
    throw new Error('Sale timestamp must include a timezone.');
  }
  const quantity = Number(row.quantity);
  const rawPrice = row.purchasePrice ?? row.purchase_price ?? row.price;
  const price = Number(rawPrice);
  const shipping = Number(row.shippingPrice ?? row.shipping_price ?? 0);
  if (row.quantity == null || rawPrice == null || rawPrice === '' ||
      !Number.isSafeInteger(quantity) || quantity < 1 ||
      !Number.isFinite(price) || price < 0 ||
      !Number.isFinite(shipping) || shipping < 0) {
    throw new Error('Sale requires a positive quantity and nonnegative USD prices.');
  }
  return {
    sold_at: new Date(timestamp).toISOString(),
    quantity,
    unit_price_cents: Math.round(price * 100),
    shipping_cents: Math.round(shipping * 100),
    condition: String(row.condition ?? ''),
    variant: String(row.variant ?? row.printing ?? ''),
    language: String(row.language ?? ''),
    listing_type: String(row.listingType ?? row.listing_type ?? ''),
  };
}

export function csv(rows, fields) {
  const cell = value => {
    let text = value == null ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [fields.map(cell).join(','), ...rows.map(row => fields.map(f => cell(row[f])).join(','))]
    .join('\r\n') + '\r\n';
}

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY, url TEXT NOT NULL, name TEXT NOT NULL,
        pokemon TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('single','sealed')),
        added_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
        fingerprint TEXT NOT NULL, occurrence INTEGER NOT NULL,
        sold_at TEXT NOT NULL, quantity INTEGER NOT NULL,
        unit_price_cents INTEGER NOT NULL, shipping_cents INTEGER NOT NULL,
        condition TEXT NOT NULL, variant TEXT NOT NULL, language TEXT NOT NULL,
        listing_type TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
        UNIQUE(product_id, fingerprint, occurrence)
      );
      CREATE INDEX IF NOT EXISTS sales_date ON sales(sold_at);
      CREATE TABLE IF NOT EXISTS collections (
        id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
        started_at TEXT NOT NULL, finished_at TEXT NOT NULL, status TEXT NOT NULL,
        rows_seen INTEGER NOT NULL, rows_added INTEGER NOT NULL, pages INTEGER NOT NULL,
        oldest_sale TEXT, newest_sale TEXT, warning TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalog_products (
        product_id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL,
        group_id INTEGER NOT NULL, set_name TEXT NOT NULL, name TEXT NOT NULL,
        number TEXT NOT NULL, rarity TEXT NOT NULL, card_type TEXT NOT NULL,
        hp TEXT NOT NULL, pokemon TEXT NOT NULL, source_modified TEXT NOT NULL,
        source_build TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS catalog_category ON catalog_products(category_id, is_current);
      CREATE TABLE IF NOT EXISTS catalog_downloads (
        source_build TEXT NOT NULL, category_id INTEGER NOT NULL, group_id INTEGER NOT NULL,
        product_count INTEGER NOT NULL, PRIMARY KEY(source_build, category_id, group_id)
      );
      CREATE TABLE IF NOT EXISTS catalog_runs (
        id INTEGER PRIMARY KEY, source_build TEXT NOT NULL, started_at TEXT NOT NULL,
        finished_at TEXT, status TEXT NOT NULL, groups_expected INTEGER NOT NULL DEFAULT 0,
        groups_downloaded INTEGER NOT NULL DEFAULT 0, warning TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS pokemon_species (
        name TEXT PRIMARY KEY, fetched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bulk_sales (
        id INTEGER PRIMARY KEY, source TEXT NOT NULL, transaction_key TEXT NOT NULL,
        product_id INTEGER NOT NULL REFERENCES catalog_products(product_id),
        kind TEXT NOT NULL CHECK(kind IN ('single','sealed','other')),
        sold_at TEXT NOT NULL, quantity INTEGER NOT NULL,
        unit_price_cents INTEGER NOT NULL, shipping_cents INTEGER NOT NULL,
        condition TEXT NOT NULL, variant TEXT NOT NULL, language TEXT NOT NULL,
        listing_type TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
        UNIQUE(source, transaction_key)
      );
      CREATE INDEX IF NOT EXISTS bulk_sales_source_date ON bulk_sales(source, sold_at);
      CREATE TABLE IF NOT EXISTS daily_volume (
        product_id INTEGER NOT NULL REFERENCES catalog_products(product_id),
        sku_id INTEGER NOT NULL, date_source TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('single','sealed','other')),
        condition TEXT NOT NULL, variant TEXT NOT NULL, language TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK(quantity>=0),
        transaction_count INTEGER NOT NULL CHECK(transaction_count>=0),
        first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
        PRIMARY KEY(product_id,sku_id,date_source)
      );
      CREATE INDEX IF NOT EXISTS daily_volume_date ON daily_volume(date_source);
      CREATE TABLE IF NOT EXISTS daily_sale_prices (
        product_id INTEGER NOT NULL, sku_id INTEGER NOT NULL, date_source TEXT NOT NULL,
        low_cents INTEGER, high_cents INTEGER, low_with_shipping_cents INTEGER,
        high_with_shipping_cents INTEGER, observed_at TEXT NOT NULL,
        PRIMARY KEY(product_id,sku_id,date_source),
        FOREIGN KEY(product_id,sku_id,date_source)
          REFERENCES daily_volume(product_id,sku_id,date_source)
      );
      CREATE TABLE IF NOT EXISTS price_checks (
        product_id INTEGER PRIMARY KEY REFERENCES catalog_products(product_id),
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS price_product_days (
        product_id INTEGER NOT NULL REFERENCES catalog_products(product_id),
        date_source TEXT NOT NULL, kind TEXT NOT NULL,
        priced_units INTEGER NOT NULL, lower_cents INTEGER NOT NULL, upper_cents INTEGER NOT NULL,
        PRIMARY KEY(product_id,date_source,kind)
      );
      CREATE TABLE IF NOT EXISTS volume_runs (
        date_utc TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        finished_at TEXT, status TEXT NOT NULL, products_expected INTEGER NOT NULL DEFAULT 0,
        products_checked INTEGER NOT NULL DEFAULT 0,
        products_with_history INTEGER NOT NULL DEFAULT 0,
        products_without_history INTEGER NOT NULL DEFAULT 0,
        products_failed INTEGER NOT NULL DEFAULT 0, warning TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS volume_jobs (
        date_utc TEXT NOT NULL REFERENCES volume_runs(date_utc),
        product_id INTEGER NOT NULL REFERENCES catalog_products(product_id),
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        fetched_at TEXT, buckets INTEGER NOT NULL DEFAULT 0, warning TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(date_utc,product_id)
      );
      CREATE VIEW IF NOT EXISTS reported_volume AS
        SELECT v.*, 'tcgplayer-daily' AS source, c.name AS product_name,
          CASE WHEN v.kind <> 'single' THEN '[]'
            WHEN p.kind='single' AND p.pokemon <> '[]' THEN p.pokemon
            ELSE c.pokemon END AS pokemon
        FROM daily_volume v JOIN catalog_products c ON c.product_id=v.product_id
        LEFT JOIN products p ON p.id=v.product_id;
      CREATE VIEW IF NOT EXISTS observed_sales AS
        SELECT s.id, s.product_id, s.sold_at, s.quantity, s.unit_price_cents,
          s.shipping_cents, s.condition, s.variant, s.language, s.listing_type,
          s.first_seen, s.last_seen, 'snapshot' AS source, p.name AS product_name,
          p.kind, p.pokemon, p.url
        FROM sales s JOIN products p ON p.id=s.product_id
        UNION ALL
        SELECT s.id, s.product_id, s.sold_at, s.quantity, s.unit_price_cents,
          s.shipping_cents, s.condition, s.variant, s.language, s.listing_type,
          s.first_seen, s.last_seen, s.source, c.name AS product_name, s.kind,
          CASE WHEN s.kind <> 'single' THEN '[]'
            WHEN p.kind='single' AND p.pokemon <> '[]' THEN p.pokemon
            ELSE c.pokemon END AS pokemon,
          'https://www.tcgplayer.com/product/' || s.product_id AS url
        FROM bulk_sales s JOIN catalog_products c ON c.product_id=s.product_id
        LEFT JOIN products p ON p.id=s.product_id;
      CREATE VIEW IF NOT EXISTS observed_daily_sales AS
        SELECT source, substr(sold_at, 1, 10) AS date_utc, kind,
          count(*) AS sale_records, sum(quantity) AS units,
          sum(quantity * unit_price_cents) AS sales_cents
        FROM observed_sales GROUP BY source, date_utc, kind;
      CREATE VIEW IF NOT EXISTS observed_daily_pokemon_sales AS
        SELECT s.source, substr(s.sold_at, 1, 10) AS date_utc,
          lower(j.value) AS pokemon_key, min(j.value) AS pokemon,
          count(*) AS sale_records, sum(s.quantity) AS units,
          sum(s.quantity * s.unit_price_cents) AS sales_cents
        FROM observed_sales s, json_each(s.pokemon) j
        WHERE s.kind='single'
        GROUP BY s.source, date_utc, pokemon_key;
    `);
    if (!this.db.prepare(`SELECT 1 FROM sqlite_master
        WHERE type='table' AND name='volume_product_days'`).get()) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (!this.db.prepare(`SELECT 1 FROM sqlite_master
            WHERE type='table' AND name='volume_product_days'`).get()) this.db.exec(`
          CREATE TABLE volume_product_days (
            product_id INTEGER NOT NULL REFERENCES catalog_products(product_id),
            date_source TEXT NOT NULL, kind TEXT NOT NULL,
            quantity INTEGER NOT NULL, transaction_count INTEGER NOT NULL,
            sku_buckets INTEGER NOT NULL, PRIMARY KEY(product_id,date_source,kind)
          );
          INSERT INTO volume_product_days
            SELECT product_id,date_source,kind,sum(quantity),sum(transaction_count),count(*)
            FROM daily_volume GROUP BY product_id,date_source,kind;
        `);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS volume_product_days_date ON volume_product_days(date_source);
      CREATE INDEX IF NOT EXISTS volume_product_days_active ON volume_product_days(date_source,product_id)
        WHERE quantity>0 OR transaction_count>0;
      CREATE VIEW IF NOT EXISTS reported_product_volume AS
        SELECT v.*, 'tcgplayer-daily' AS source, c.name AS product_name,
          CASE WHEN v.kind <> 'single' THEN '[]'
            WHEN p.kind='single' AND p.pokemon <> '[]' THEN p.pokemon
            ELSE c.pokemon END AS pokemon
        FROM volume_product_days v JOIN catalog_products c ON c.product_id=v.product_id
        LEFT JOIN products p ON p.id=v.product_id;
    `);
  }

  close() { this.db.close(); }

  refreshSaleValues(productId) {
    const where = productId == null ? '' : 'WHERE s.product_id=?';
    const params = productId == null ? [] : [productId];
    this.db.prepare(`DELETE FROM price_product_days ${productId == null ? '' : 'WHERE product_id=?'}`)
      .run(...params);
    this.db.prepare(`INSERT INTO price_product_days
      SELECT s.product_id,s.date_source,s.kind,
        sum(CASE WHEN p.low_cents IS NOT NULL AND p.high_cents IS NOT NULL THEN s.quantity ELSE 0 END),
        sum(CASE WHEN p.low_cents IS NOT NULL AND p.high_cents IS NOT NULL THEN s.quantity*p.low_cents ELSE 0 END),
        sum(CASE WHEN p.low_cents IS NOT NULL AND p.high_cents IS NOT NULL THEN s.quantity*p.high_cents ELSE 0 END)
      FROM daily_volume s LEFT JOIN daily_sale_prices p
        ON p.product_id=s.product_id AND p.sku_id=s.sku_id AND p.date_source=s.date_source
      ${where} GROUP BY s.product_id,s.date_source,s.kind`).run(...params);
  }

  saleValueRows(filters, group = 'total', iterate = false) {
    if (this.salesSource(filters?.source) !== volumeSource) {
      throw new Error('Daily sale-price bounds require the tcgplayer-daily source.');
    }
    const { where, params } = this.salesFilter(filters);
    const groups = {
      total: ['', '', ''],
      daily: ['s.date_source AS date_source,', 'GROUP BY s.date_source', 'ORDER BY s.date_source'],
      pokemon: ['s.date_source,lower(j.value) AS pokemon_key,min(j.value) AS pokemon,',
        'GROUP BY s.date_source,lower(j.value)', 'ORDER BY s.date_source,priced_sales_upper_usd DESC,pokemon_key'],
      product: ['s.product_id,min(s.product_name) AS name,', 'GROUP BY s.product_id',
        'ORDER BY priced_sales_upper_usd DESC,s.product_id'],
      'product-daily': [`s.date_source,s.product_id,min(s.product_name) AS name,
        c.category_id,c.group_id,min(c.set_name) AS set_name,`,
      'GROUP BY s.date_source,s.product_id,c.category_id,c.group_id', 'ORDER BY s.date_source,s.product_id'],
      'set-daily': ['s.date_source,c.category_id,c.group_id,min(c.set_name) AS set_name,',
        'GROUP BY s.date_source,c.category_id,c.group_id', 'ORDER BY s.date_source,c.category_id,c.group_id'],
    };
    if (!Object.hasOwn(groups, group)) throw new Error('Invalid sale-value grouping.');
    const [select, grouping, order] = groups[group];
    const statement = this.db.prepare(`SELECT ${select}
      coalesce(sum(s.transaction_count),0) AS sale_records,
      coalesce(sum(s.quantity),0) AS units,
      coalesce(sum(p.priced_units),0) AS priced_units,
      coalesce(sum(s.quantity-coalesce(p.priced_units,0)),0) AS unpriced_units,
      sum(coalesce(p.lower_cents,0))/100.0 AS priced_sales_lower_usd,
      sum(coalesce(p.upper_cents,0))/100.0 AS priced_sales_upper_usd,
      CASE WHEN sum(s.quantity)=sum(coalesce(p.priced_units,0))
        THEN sum(coalesce(p.lower_cents,0))/100.0 END AS sales_lower_usd,
      CASE WHEN sum(s.quantity)=sum(coalesce(p.priced_units,0))
        THEN sum(coalesce(p.upper_cents,0))/100.0 END AS sales_upper_usd,
      CASE WHEN sum(s.quantity)=sum(coalesce(p.priced_units,0))
        AND sum(coalesce(p.lower_cents,0))=sum(coalesce(p.upper_cents,0))
        THEN sum(coalesce(p.lower_cents,0))/100.0 END AS sales_usd
      FROM reported_product_volume s LEFT JOIN price_product_days p
        ON p.product_id=s.product_id AND p.date_source=s.date_source AND p.kind=s.kind
      ${group === 'product-daily' || group === 'set-daily'
        ? 'JOIN catalog_products c ON c.product_id=s.product_id' : ''}
      ${group === 'pokemon' ? ',json_each(s.pokemon) j' : ''}
      ${where} ${group === 'pokemon' ? "AND s.kind='single'" : ''}
      ${grouping} ${order}`);
    return iterate ? statement.iterate(...params) : statement.all(...params);
  }

  products() {
    return this.db.prepare(`
      SELECT p.*, c.finished_at AS last_collected, c.status AS last_status,
        c.warning AS last_warning, c.rows_seen AS last_rows_seen
      FROM products p LEFT JOIN collections c ON c.id = (
        SELECT id FROM collections WHERE product_id = p.id ORDER BY id DESC LIMIT 1
      ) ORDER BY p.name
    `).all().map(row => ({ ...row, pokemon: JSON.parse(row.pokemon) }));
  }

  addProduct(input) {
    const id = productIdFromUrl(input.url);
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 300) throw new Error('Provide a product name (1–300 characters).');
    if (!['single', 'sealed'].includes(input.kind)) throw new Error('Choose single or sealed.');
    if (!Array.isArray(input.pokemon) || input.pokemon.length > 10 ||
        input.pokemon.some(p => typeof p !== 'string' || !p.trim() || p.length > 80)) {
      throw new Error('Pokemon must be a list of up to ten names.');
    }
    // Sealed product artwork is not evidence of a sale of the featured Pokemon.
    const pokemon = input.kind === 'single'
      ? [...new Map(input.pokemon.map(p => [p.trim().toLowerCase(), p.trim()])).values()] : [];
    this.db.prepare(`
      INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET url=excluded.url, name=excluded.name,
        pokemon=excluded.pokemon, kind=excluded.kind
    `).run(id, `https://www.tcgplayer.com/product/${id}`, name,
      JSON.stringify(pokemon), input.kind, new Date().toISOString());
    return id;
  }

  record(product, result) {
    const now = new Date().toISOString();
    const sales = result.sales.map(normalizeSale);
    const counts = new Map();
    const previous = this.db.prepare(
      'SELECT MAX(sold_at) AS latest FROM sales WHERE product_id = ?'
    ).get(product.id).latest;
    const dates = sales.map(s => s.sold_at).sort();
    const warnings = [result.warning].filter(Boolean);
    if (!previous) warnings.push('Initial snapshot; earlier sales may be missing.');
    else if (dates.length && dates[0] > previous) {
      warnings.push('No overlap with saved history; sales between collections may be missing.');
    }
    let added = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare(`
        INSERT INTO sales (product_id, fingerprint, occurrence, sold_at, quantity,
          unit_price_cents, shipping_cents, condition, variant, language, listing_type,
          first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(product_id, fingerprint, occurrence) DO UPDATE SET last_seen=excluded.last_seen
        RETURNING first_seen
      `);
      const exists = this.db.prepare(
        'SELECT id FROM sales WHERE product_id=? AND fingerprint=? AND occurrence=?'
      );
      for (const sale of sales) {
        const fingerprint = createHash('sha256').update(JSON.stringify(sale)).digest('hex');
        const occurrence = (counts.get(fingerprint) ?? 0) + 1;
        counts.set(fingerprint, occurrence);
        if (!exists.get(product.id, fingerprint, occurrence)) added++;
        insert.get(product.id, fingerprint, occurrence, ...Object.values(sale), now, now);
      }
      this.db.prepare(`
        INSERT INTO collections (product_id, started_at, finished_at, status,
          rows_seen, rows_added, pages, oldest_sale, newest_sale, warning)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(product.id, result.startedAt ?? now, now, result.status ?? 'observed',
        sales.length, added, result.pages ?? 0, dates[0] ?? null, dates.at(-1) ?? null,
        warnings.join(' '));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { productId: product.id, rowsSeen: sales.length, rowsAdded: added, warnings };
  }

  salesSource(source) {
    if (source == null || source === '') {
      if (this.db.prepare('SELECT 1 FROM daily_volume LIMIT 1').get()) return volumeSource;
      return this.db.prepare('SELECT source FROM bulk_sales ORDER BY id DESC LIMIT 1').get()?.source
        ?? 'snapshot';
    }
    if (typeof source !== 'string' || source.length > 120) throw new Error('Invalid sales source.');
    return source;
  }

  salesFilter({ from, to, kind = 'all', source } = {}) {
    const conditions = [], params = [];
    const daily = this.salesSource(source) === volumeSource;
    for (const [name, value] of [['from', from], ['to', to]]) {
      if (value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
            new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
          throw new Error(`Invalid ${name} date.`);
        }
        conditions.push(`s.${daily ? 'date_source' : 'sold_at'} ${name === 'from' ? '>=' : '<'} ?`);
        const date = new Date(`${value}T00:00:00Z`);
        if (name === 'to') date.setUTCDate(date.getUTCDate() + 1);
        params.push(daily ? date.toISOString().slice(0, 10) : date.toISOString());
      }
    }
    if (from && to && from > to) throw new Error('Start date must not follow end date.');
    if (!['all', 'single', 'sealed', 'other'].includes(kind)) throw new Error('Invalid product type.');
    if (kind !== 'all') { conditions.push('s.kind = ?'); params.push(kind); }
    conditions.push('s.source = ?');
    params.push(this.salesSource(source));
    return { where: `WHERE ${conditions.join(' AND ')}`, params };
  }

  saleRows(filters) {
    if (this.salesSource(filters?.source) === volumeSource) {
      throw new Error('Daily history contains no individual transactions. Export daily SKU buckets instead.');
    }
    const { where, params } = this.salesFilter(filters);
    return this.db.prepare(`
      SELECT s.* FROM observed_sales s ${where}
      ORDER BY s.sold_at, s.id
    `).all(...params).map(row => ({ ...row, pokemon: JSON.parse(row.pokemon) }));
  }

  dailyRows(filters) {
    const { where, params } = this.salesFilter(filters);
    if (this.salesSource(filters?.source) === volumeSource) {
      return this.db.prepare(`SELECT s.date_source AS name,
        sum(s.transaction_count) AS sale_records, sum(s.quantity) AS units,
        count(DISTINCT s.product_id) AS products_with_history, sum(s.sku_buckets) AS sku_buckets,
        NULL AS sales_usd FROM (SELECT *, 'tcgplayer-daily' AS source FROM volume_product_days) s ${where}
        GROUP BY name ORDER BY name`).all(...params);
    }
    return this.db.prepare(`SELECT substr(s.sold_at,1,10) AS name,
      count(*) AS sale_records, sum(s.quantity) AS units,
      sum(s.quantity * s.unit_price_cents)/100.0 AS sales_usd
      FROM observed_sales s ${where} GROUP BY name ORDER BY name`).all(...params);
  }

  pokemonDailyRows(filters) {
    const { where, params } = this.salesFilter(filters);
    if (this.salesSource(filters?.source) === volumeSource) {
      return this.db.prepare(`SELECT s.date_source,
        lower(j.value) AS pokemon_key, min(j.value) AS pokemon,
        sum(s.transaction_count) AS sale_records, sum(s.quantity) AS units,
        count(DISTINCT s.product_id) AS products_with_history,
        NULL AS sales_usd FROM reported_product_volume s, json_each(s.pokemon) j
        ${where} AND s.kind='single'
        GROUP BY date_source, pokemon_key ORDER BY date_source, units DESC, pokemon_key`).all(...params);
    }
    return this.db.prepare(`SELECT substr(s.sold_at,1,10) AS date_utc,
      lower(j.value) AS pokemon_key, min(j.value) AS pokemon,
      count(*) AS sale_records, sum(s.quantity) AS units,
      sum(s.quantity * s.unit_price_cents)/100.0 AS sales_usd
      FROM observed_sales s, json_each(s.pokemon) j ${where} AND s.kind='single'
      GROUP BY date_utc, pokemon_key ORDER BY date_utc, units DESC, pokemon_key`).all(...params);
  }

  metrics(filters, { rankingLimit = 0 } = {}) {
    if (!Number.isSafeInteger(rankingLimit) || rankingLimit < 0 || rankingLimit > 200) {
      throw new Error('Invalid ranking limit.');
    }
    const limit = rankingLimit ? `LIMIT ${rankingLimit}` : '';
    const source = this.salesSource(filters?.source);
    const daily = source === volumeSource;
    const relation = daily ? 'reported_product_volume' : 'observed_sales';
    const { where, params } = this.salesFilter(filters);
    const rankingWhere = daily ? `${where} AND (s.quantity>0 OR s.transaction_count>0)` : where;
    const sum = `${daily ? 'coalesce(sum(s.transaction_count),0)' : 'count(*)'} AS sale_records,
      coalesce(sum(s.quantity),0) AS units,
      ${daily ? 'NULL' : 'coalesce(sum(s.quantity * s.unit_price_cents),0)'} AS sales_cents`;
    const query = sql => this.db.prepare(sql).all(...params);
    const format = rows => rows.map(({ sales_cents, ...row }) =>
      ({ ...row, sales_usd: sales_cents == null ? null : sales_cents / 100 }));
    return {
      coverage: daily
        ? 'TCGplayer-reported daily SKU history, not individual transactions. Dollar-volume bounds use actual low/high unit sale prices, excluding shipping; priced subtotals exclude unpriced units. Exact revenue requires complete price coverage and equal bounds. Market prices are not revenue. Marketplace completeness and source-date timezone are unverified; missing products/dates are not zero sales.'
        : source === 'snapshot'
        ? 'Observed samples only; complete marketplace sales ingestion is blocked by data access.'
        : 'Imported bulk transactions; marketplace-wide completeness remains unverified.',
      sales_source: source,
      data_kind: daily ? 'daily-buckets' : 'transactions',
      available_sources: ['snapshot', ...this.db.prepare(
        'SELECT DISTINCT source FROM bulk_sales ORDER BY source'
      ).all().map(row => row.source),
      ...(this.db.prepare('SELECT 1 FROM daily_volume LIMIT 1').get() ? [volumeSource] : [])],
      timezone: daily ? 'Source bucket dates; timezone not published' : 'UTC',
      total: format(query(`SELECT ${sum} FROM ${relation} s ${rankingWhere}`))[0],
      ...(daily ? { price_volume: this.saleValueRows(filters)[0] } : {}),
      daily: this.dailyRows(filters),
      products: format(query(`SELECT s.product_id, min(s.product_name) AS name, ${sum}
        FROM ${relation} s ${rankingWhere} GROUP BY s.product_id ORDER BY units DESC, name ${limit}`)),
      pokemon: format(query(`SELECT min(j.value) AS name, ${sum}
        FROM ${relation} s, json_each(s.pokemon) j
        ${rankingWhere} AND s.kind='single' GROUP BY lower(j.value) ORDER BY units DESC, name ${limit}`)),
      catalog: this.catalogSummary(source),
      tracked_products: this.products(),
      recent_collections: this.db.prepare(`
        SELECT c.*, p.name AS product_name FROM collections c JOIN products p ON p.id=c.product_id
        ORDER BY c.id DESC LIMIT 100
      `).all(),
    };
  }

  catalogSummary(source) {
    const counts = this.db.prepare(`
      SELECT count(*) AS products, count(DISTINCT group_id) AS sets,
        coalesce(sum(json_array_length(pokemon)>0),0) AS species_mapped_products,
        coalesce(sum(cast(hp AS INTEGER)>0 AND json_array_length(pokemon)=0),0) AS species_needing_review
      FROM catalog_products WHERE is_current=1
    `).get();
    const daily = this.salesSource(source) === volumeSource;
    const withSales = daily ? this.db.prepare(
      'SELECT count(DISTINCT product_id) AS n FROM volume_product_days WHERE quantity>0 OR transaction_count>0'
    ).get().n : this.db.prepare(
      'SELECT count(DISTINCT product_id) AS n FROM observed_sales WHERE source=?'
    ).get(this.salesSource(source)).n;
    return {
      ...counts, products_with_saved_sales: withSales,
      categories: this.db.prepare(`SELECT category_id, count(*) AS products
        FROM catalog_products WHERE is_current=1 GROUP BY category_id`).all(),
      last_run: this.db.prepare('SELECT * FROM catalog_runs ORDER BY id DESC LIMIT 1').get() ?? null,
      volume_run: this.db.prepare('SELECT * FROM volume_runs ORDER BY date_utc DESC LIMIT 1').get() ?? null,
      sales_feed_status: daily
        ? 'Native daily history connected; source coverage is not certified marketplace completeness.'
        : 'No verified complete marketplace-wide transaction feed connected.',
    };
  }

  volumeRows(filters) {
    if (filters?.source && filters.source !== volumeSource) {
      throw new Error('Daily SKU export requires the tcgplayer-daily source.');
    }
    const { where, params } = this.salesFilter({ ...filters, source: volumeSource });
    return this.db.prepare(`SELECT s.*,p.low_cents/100.0 AS low_sale_price_usd,
      p.high_cents/100.0 AS high_sale_price_usd,
      p.low_with_shipping_cents/100.0 AS low_sale_price_with_shipping_usd,
      p.high_with_shipping_cents/100.0 AS high_sale_price_with_shipping_usd,
      p.observed_at AS prices_observed_at
      FROM reported_volume s LEFT JOIN daily_sale_prices p
        ON p.product_id=s.product_id AND p.sku_id=s.sku_id AND p.date_source=s.date_source ${where}
      ORDER BY s.date_source,s.product_id,s.sku_id`).iterate(...params);
  }

  catalogRows({ q = '', category, limit = 100, offset = 0 } = {}, all = false) {
    if (typeof q !== 'string' || q.length > 200) throw new Error('Invalid catalog search.');
    limit = Number(limit); offset = Number(offset);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
        !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid catalog pagination.');
    const conditions = ['is_current=1'], params = [];
    if (category) {
      if (![3, 85].includes(Number(category))) throw new Error('Invalid Pokemon category.');
      conditions.push('category_id=?'); params.push(Number(category));
    }
    if (q) {
      conditions.push("(name LIKE ? ESCAPE '\\' OR set_name LIKE ? ESCAPE '\\')");
      const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      params.push(pattern, pattern);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const total = this.db.prepare(`SELECT count(*) AS n FROM catalog_products ${where}`).get(...params).n;
    const rows = this.db.prepare(`SELECT * FROM catalog_products ${where}
      ORDER BY name, product_id ${all ? '' : 'LIMIT ? OFFSET ?'}`)
      .all(...params, ...(all ? [] : [limit, offset]));
    return { total, offset: all ? 0 : offset, limit: all ? total : limit,
      products: rows.map(row => ({ ...row, pokemon: JSON.parse(row.pokemon),
        url: `https://www.tcgplayer.com/product/${row.product_id}` })) };
  }
}
