import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Store, csv, volumeSource } from './store.js';
import { collectAll, productDetails } from './collector.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const salesFields = ['source', 'product_id', 'product_name', 'kind', 'pokemon', 'sold_at', 'quantity',
  'unit_price_usd', 'sales_usd', 'shipping_usd', 'condition', 'variant', 'language',
  'listing_type', 'first_seen', 'last_seen', 'url'];

async function body(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text) > 5_000_000) throw new Error('Request is too large (maximum 5 MB).');
  }
  try { return JSON.parse(text); } catch { throw new Error('Expected a JSON request body.'); }
}

async function streamCsv(response, rows, fields) {
  const header = csv([], fields), signal = new AbortController();
  response.once('close', () => signal.abort());
  response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
  response.write(header);
  let batch = [];
  const flush = async () => {
    if (!response.write(csv(batch, fields).slice(header.length))) {
      await once(response, 'drain', { signal: signal.signal });
    }
    batch = [];
  };
  for (const row of rows) {
    if (response.destroyed) return;
    batch.push({ ...row, pokemon: JSON.parse(row.pokemon).join(' / '),
      timezone: 'Source bucket dates; timezone not published',
      coverage: 'reported daily history; marketplace completeness unverified; actual price ranges retained, not individual-sale totals' });
    if (batch.length === 1000) await flush();
  }
  if (batch.length) await flush();
  response.end();
}

export function makeServer(store, {
  collector = collectAll, lookup = productDetails, browserSampling = false,
} = {}) {
  const state = { running: false, last_finished: null, error: null, next_run: null,
    browser_sampling_enabled: browserSampling,
    sales_feed_status: 'Complete marketplace sales ingestion requires a verified bulk transaction feed.' };
  let collection = null;
  function collect() {
    if (!browserSampling) return Promise.resolve([]);
    if (collection) return collection;
    state.running = true;
    state.error = null;
    collection = (async () => {
      try { return await collector(store); }
      catch (error) { state.error = error.message; return []; }
      finally {
        state.running = false;
        state.last_finished = new Date().toISOString();
        collection = null;
      }
    })();
    return collection;
  }
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const send = (status, payload, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type });
      response.end(type.startsWith('application/json') ? JSON.stringify(payload) : payload);
    };
    try {
      const host = request.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(403, { error: 'Local access only.' });
      const url = new URL(request.url, `http://${host}`);
      if (request.method === 'POST') {
        if (request.headers.origin && request.headers.origin !== url.origin) {
          return send(403, { error: 'Cross-origin requests are not allowed.' });
        }
        if (!request.headers['content-type']?.startsWith('application/json')) {
          return send(415, { error: 'Use application/json.' });
        }
        if (state.running && ['/api/products', '/api/import'].includes(url.pathname)) {
          return send(409, { error: 'Wait for collection to finish before changing data.' });
        }
        if (url.pathname === '/api/products') {
          const input = await body(request);
          const product = await lookup(input.url);
          const id = store.addProduct({ ...input, ...product, pokemon: input.pokemon ?? [] });
          return send(201, { id, product });
        }
        if (url.pathname === '/api/collect') {
          if (!browserSampling) return send(409, {
            error: 'Browser sampling is disabled. It cannot provide catalog-wide sales totals.',
          });
          void collect();
          return send(202, state);
        }
        if (url.pathname === '/api/import') {
          const input = await body(request);
          const product = store.products().find(p => p.id === Number(input.product_id));
          if (!product) throw new Error('Add the product before importing its sales.');
          if (!Array.isArray(input.sales) || input.sales.length > 10000) {
            throw new Error('Import must contain a sales array (up to 10,000 rows).');
          }
          return send(200, store.record(product, {
            sales: input.sales, status: 'imported', pages: 0,
            warning: 'Manual import of observed sales; source coverage is unverified.',
          }));
        }
        return send(404, { error: 'Not found.' });
      }
      if (request.method !== 'GET') return send(405, { error: 'Method not allowed.' });
      const filters = Object.fromEntries(['from', 'to', 'kind', 'source'].flatMap(key =>
        url.searchParams.has(key) ? [[key, url.searchParams.get(key)]] : []));
      if (url.pathname === '/api/status') return send(200, { ...state,
        volume_run: store.db.prepare('SELECT * FROM volume_runs ORDER BY date_utc DESC LIMIT 1').get() ?? null });
      if (url.pathname === '/api/metrics') return send(200, store.metrics(filters, { rankingLimit: 25 }));
      const catalogFilters = Object.fromEntries(['q', 'category', 'limit', 'offset'].flatMap(key =>
        url.searchParams.has(key) ? [[key, url.searchParams.get(key)]] : []));
      if (url.pathname === '/api/catalog') return send(200, store.catalogRows(catalogFilters));
      if (url.pathname === '/api/export/catalog.csv') {
        const rows = store.catalogRows(catalogFilters, true).products.map(row =>
          ({ ...row, pokemon: row.pokemon.join(' / ') }));
        response.setHeader('Content-Disposition', 'attachment; filename="pokemon-product-catalog.csv"');
        return send(200, csv(rows, ['product_id', 'category_id', 'group_id', 'set_name', 'name',
          'number', 'rarity', 'card_type', 'hp', 'pokemon', 'source_modified', 'source_build', 'url']),
        'text/csv; charset=utf-8');
      }
      if (url.pathname === '/api/export/sales.csv') {
        const rows = store.saleRows(filters).map(row => ({
          ...row, pokemon: row.pokemon.join(' / '),
          unit_price_usd: (row.unit_price_cents / 100).toFixed(2),
          sales_usd: (row.unit_price_cents * row.quantity / 100).toFixed(2),
          shipping_usd: (row.shipping_cents / 100).toFixed(2),
        }));
        response.setHeader('Content-Disposition', 'attachment; filename="observed-sales.csv"');
        return send(200, csv(rows, salesFields), 'text/csv; charset=utf-8');
      }
      if (url.pathname === '/api/export/volume.csv') {
        const rows = store.volumeRows(filters);
        response.setHeader('Content-Disposition', 'attachment; filename="daily-sku-volume.csv"');
        return await streamCsv(response, rows, ['source', 'product_id', 'product_name', 'kind',
          'pokemon', 'sku_id', 'date_source', 'quantity', 'transaction_count', 'condition',
          'variant', 'language', 'first_seen', 'last_seen', 'timezone', 'coverage',
          'low_sale_price_usd','high_sale_price_usd','low_sale_price_with_shipping_usd',
          'high_sale_price_with_shipping_usd','prices_observed_at']);
      }
      if (url.pathname === '/api/export/sales-value.csv') {
        const group = url.searchParams.get('group') ?? 'daily';
        const identities = { daily: ['date_source'], pokemon: ['date_source','pokemon_key','pokemon'],
          product: ['product_id','name'] };
        if (!Object.hasOwn(identities,group)) throw new Error('Invalid sale-value grouping.');
        response.setHeader('Content-Disposition', `attachment; filename="${group}-sales-value.csv"`);
        return send(200,csv(store.saleValueRows(filters,group),[...identities[group],
          'units','priced_units','unpriced_units','priced_sales_lower_usd','priced_sales_upper_usd',
          'sales_lower_usd','sales_upper_usd','sales_usd']), 'text/csv; charset=utf-8');
      }
      if (url.pathname === '/api/export/daily.csv') {
        const daily = store.salesSource(filters.source) === volumeSource;
        const rows = store.dailyRows(filters).map(row => ({
          ...row, [daily ? 'date_source' : 'date_utc']: row.name,
          source: store.salesSource(filters.source),
          coverage: daily ? 'reported daily history; completeness unverified; revenue unavailable'
            : 'observed sales; completeness unverified',
          timezone: daily ? 'Source bucket dates; timezone not published' : 'UTC',
        }));
        response.setHeader('Content-Disposition', 'attachment; filename="daily-observed-sales.csv"');
        return send(200, csv(rows, [daily ? 'date_source' : 'date_utc', 'sale_records', 'units',
          'sales_usd', 'source', 'coverage', 'timezone', ...(daily ? ['products_with_history', 'sku_buckets'] : [])]),
          'text/csv; charset=utf-8');
      }
      if (url.pathname === '/api/export/pokemon-daily.csv') {
        const daily = store.salesSource(filters.source) === volumeSource;
        const rows = store.pokemonDailyRows(filters).map(row => ({
          ...row, source: store.salesSource(filters.source),
          coverage: daily ? 'reported daily singles; attribution and completeness unverified; revenue unavailable'
            : 'observed singles; species attribution and completeness unverified',
          timezone: daily ? 'Source bucket dates; timezone not published' : 'UTC',
        }));
        response.setHeader('Content-Disposition', 'attachment; filename="daily-observed-pokemon-sales.csv"');
        return send(200, csv(rows, [daily ? 'date_source' : 'date_utc', 'pokemon_key', 'pokemon', 'sale_records',
          'units', 'sales_usd', 'source', 'coverage', 'timezone', ...(daily ? ['products_with_history'] : [])]),
        'text/csv; charset=utf-8');
      }
      const files = { '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/style.css': ['style.css', 'text/css; charset=utf-8'] };
      const file = files[url.pathname];
      if (!file) return send(404, { error: 'Not found.' });
      return send(200, await readFile(resolve(publicDir, file[0])), file[1]);
    } catch (error) {
      if (response.headersSent) response.destroy();
      else send(400, { error: error.message });
    }
  });
  return { server, state, collect, waitForCollection: () => collection };
}

export function scheduleDaily(app, now = () => new Date()) {
  let timer;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    const current = now();
    const next = new Date(current);
    next.setUTCHours(0, 15, 0, 0);
    if (next <= current) next.setUTCDate(next.getUTCDate() + 1);
    app.state.next_run = next.toISOString();
    timer = setTimeout(async () => { await app.collect(); arm(); }, next - current);
    timer.unref();
  };
  arm();
  return () => { stopped = true; clearTimeout(timer); };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = new Store(resolve(process.env.DATA_DIR ?? 'data', 'sales.sqlite'));
  const browserSampling = process.env.ENABLE_BROWSER_SAMPLING === '1';
  const app = makeServer(store, { browserSampling });
  const stopSchedule = browserSampling ? scheduleDaily(app) : () => {};
  const port = Number(process.env.PORT ?? 3000);
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`Pokemon sales dashboard: http://127.0.0.1:${port}`);
    console.log(browserSampling
      ? `Diagnostic browser sampling enabled. Next: ${app.state.next_run}`
      : 'Page sampling disabled. Run npm run volume -- --watch for catalog-wide daily SKU history.');
  });
  const shutdown = async () => {
    stopSchedule();
    app.server.close();
    await app.waitForCollection();
    store.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
