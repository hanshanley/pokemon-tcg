import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { syncCatalog, speciesForProduct, remapCatalogSpecies } from '../src/catalog.js';

const species = ['charizard', 'trevenant', 'mew', 'mewtwo', 'nidoran-f', 'mr-mime', 'farfetchd'];
const group = (id, category) => ({ groupId: id, categoryId: category, name: `Set ${id}` });
const product = (id, groupId, categoryId, name, attributes = []) => ({
  productId: id, groupId, categoryId, name, extendedData: attributes,
});
const hp = [{ name: 'HP', value: '100' }];
function fixture({ fail = false, build = '2026-10-31T12:00:00Z' } = {}) {
  const calls = [];
  return { calls, fetcher: async (url, options) => {
    calls.push(url);
    assert.equal(options.headers['User-Agent'], 'pokemon-tcg-sales/0.1.0');
    if (url.endsWith('/last-updated.txt')) return new Response(build);
    if (url.startsWith('https://pokeapi.co/')) return Response.json({
      count: species.length, next: null, results: species.map(name => ({ name })),
    });
    let results;
    if (url.endsWith('/3/groups')) results = [group(604, 3)];
    if (url.endsWith('/85/groups')) results = [group(999, 85)];
    if (url.endsWith('/3/604/products')) results = [
      product(42382, 604, 3, 'Charizard ex', hp),
      product(502001, 604, 3, 'Charizard Booster Box'),
      product(12345, 604, 3, 'Charizard Spirit Link', [{ name: 'Card Type', value: 'Trainer' }]),
    ];
    if (url.endsWith('/85/999/products')) {
      if (fail) return new Response('Unavailable', { status: 503 });
      results = [product(246708, 999, 85, 'Trevenant VMAX', hp)];
    }
    assert.ok(results, `Unexpected URL: ${url}`);
    return Response.json({ success: true, totalItems: results.length, errors: [], results });
  } };
}
const options = data => ({ fetcher: data.fetcher, pause: async () => {}, log: () => {} });

test('bulk catalog includes both categories, sealed and trainer metadata without counting prices as sales', async () => {
  const store = new Store(':memory:');
  try {
    const data = fixture();
    const result = await syncCatalog(store, options(data));
    assert.equal(result.products, 4);
    assert.equal(result.sets, 2);
    assert.equal(result.last_run.status, 'complete');
    assert.equal(result.last_run.groups_expected, 2);
    assert.equal(result.species_mapped_products, 2);
    assert.equal(result.products_with_saved_sales, 0);
    assert.equal(store.metrics().total.sale_records, 0);
    assert.deepEqual(store.catalogRows({ q: 'Booster' }).products[0].pokemon, []);
    assert.deepEqual(store.catalogRows({ q: 'Spirit Link' }).products[0].pokemon, []);
    assert.equal(store.catalogRows({ category: 85 }).total, 1);
    const repeat = fixture();
    assert.equal((await syncCatalog(store, options(repeat))).skipped, true);
    assert.deepEqual(repeat.calls, ['https://tcgcsv.com/last-updated.txt']);
  } finally { store.close(); }
});

test('failed sync preserves completed group checkpoints and resumes without redownloading them', async () => {
  const store = new Store(':memory:');
  try {
    await assert.rejects(syncCatalog(store, options(fixture({ fail: true }))), /HTTP 503/);
    assert.equal(store.catalogSummary().last_run.status, 'failed');
    assert.equal(store.catalogSummary().last_run.groups_downloaded, 1);
    const retry = fixture();
    const result = await syncCatalog(store, options(retry));
    assert.equal(result.products, 4);
    assert.equal(result.last_run.status, 'complete');
    assert.ok(!retry.calls.some(url => url.endsWith('/3/604/products')));
    assert.ok(!retry.calls.some(url => url.startsWith('https://pokeapi.co/')));
  } finally { store.close(); }
});

test('products without optional attributes retain their identity without invented card metadata', async () => {
  const store = new Store(':memory:');
  try {
    const data = fixture();
    const incoming = product(730120, 999, 85, 'Emboar');
    delete incoming.extendedData;
    const result = await syncCatalog(store, options({
      fetcher: async (url, opts) => url.endsWith('/85/999/products')
        ? Response.json({ success: true, totalItems: 2, errors: [], results: [
          product(246708, 999, 85, 'Trevenant VMAX', hp), incoming,
        ] })
        : data.fetcher(url, opts),
    }));
    assert.equal(result.last_run.status, 'complete');
    assert.equal(result.products, 5);
    assert.equal(result.species_mapped_products, 2);
    const row = store.catalogRows({ q: 'Emboar' }).products[0];
    assert.equal(row.product_id, 730120);
    assert.equal(row.category_id, 85);
    assert.equal(row.group_id, 999);
    assert.equal(row.name, 'Emboar');
    for (const field of ['hp', 'card_type', 'number', 'rarity']) assert.equal(row[field], '');
    assert.deepEqual(row.pokemon, []);
    assert.equal(store.db.prepare('SELECT product_count FROM catalog_downloads WHERE group_id=999').get().product_count, 2);
  } finally { store.close(); }
});

test('omitted attributes do not excuse invalid identities or malformed provided attributes', async () => {
  for (const invalid of [{ categoryId: 3 }, { groupId: 604 }, { extendedData: null },
    { extendedData: {} }]) {
    const store = new Store(':memory:');
    try {
      const data = fixture();
      const incoming = product(730120, 999, 85, 'Emboar');
      delete incoming.extendedData;
      Object.assign(incoming, invalid);
      await assert.rejects(syncCatalog(store, options({
        fetcher: async (url, opts) => url.endsWith('/85/999/products')
          ? Response.json({ success: true, totalItems: 2, errors: [], results: [
            product(246708, 999, 85, 'Trevenant VMAX', hp), incoming,
          ] })
          : data.fetcher(url, opts),
      })), /Invalid product in group 999/);
      assert.equal(store.catalogSummary().last_run.status, 'failed');
      assert.equal(store.catalogSummary().products, 3);
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM catalog_downloads WHERE group_id=999').get().n, 0);
    } finally { store.close(); }
  }
});

test('incomplete counts and source rollover never report a complete catalog', async () => {
  const store = new Store(':memory:');
  try {
    const data = fixture();
    let markers = 0;
    const fetcher = async (url, opts) => {
      if (url.endsWith('/last-updated.txt') && ++markers === 2) return new Response('new-build');
      return data.fetcher(url, opts);
    };
    await assert.rejects(syncCatalog(store, options({ fetcher })), /Source build changed/);
    assert.equal(store.catalogSummary().last_run.status, 'failed');
    const bad = fixture({ build: 'next-build' });
    await assert.rejects(syncCatalog(store, options({
      fetcher: async (url, opts) => url.endsWith('/3/604/products')
        ? Response.json({ success: true, totalItems: 2, results: [] })
        : bad.fetcher(url, opts),
    })), /Incomplete catalog response/);
    assert.equal(store.catalogSummary().last_run.groups_downloaded, 0);
    assert.equal(store.catalogSummary().products, 4);
  } finally { store.close(); }
});

test('species matching uses whole names, HP evidence, punctuation and gender variants', () => {
  assert.deepEqual(speciesForProduct('Mewtwo V', hp, species), ['Mewtwo']);
  assert.deepEqual(speciesForProduct('Mewtwo & Mew GX', hp, species), ['Mew', 'Mewtwo']);
  assert.deepEqual(speciesForProduct("Farfetch'd", hp, species), ["Farfetch'd"]);
  assert.deepEqual(speciesForProduct('Galarian Mr. Mime', hp, species), ['Mr. Mime']);
  assert.deepEqual(speciesForProduct('Nidoran F', hp, species), ['Nidoran (female)']);
  assert.deepEqual(speciesForProduct('NidoranF', hp, species), ['Nidoran (female)']);
  assert.deepEqual(speciesForProduct("Mewtwo's Vacation", hp, species), ['Mewtwo']);
  assert.deepEqual(speciesForProduct('Charizard Booster Box', [], species), []);
  assert.deepEqual(speciesForProduct('Charizard Spirit Link', [{ name: 'HP', value: '0' }], species), []);
  assert.deepEqual(speciesForProduct('Charizard Fossil', [
    ...hp, { name: 'Card Type', value: 'Trainer - Item' },
  ], species), []);
});

test('local remapping repairs stale species tags without fetching catalog batches again', async () => {
  const store = new Store(':memory:');
  try {
    await syncCatalog(store, options(fixture()));
    store.db.prepare("UPDATE catalog_products SET pokemon='[\"Charizard\"]' WHERE product_id=12345").run();
    assert.equal(remapCatalogSpecies(store), 1);
    assert.deepEqual(store.catalogRows({ q: 'Spirit Link' }).products[0].pokemon, []);
    assert.equal(remapCatalogSpecies(store), 0);
  } finally { store.close(); }
});

test('successful empty sets without totalItems are checkpointed as empty catalogs', async () => {
  const store = new Store(':memory:');
  try {
    const data = fixture();
    const result = await syncCatalog(store, options({
      fetcher: async (url, opts) => url.endsWith('/85/999/products')
        ? Response.json({ success: true, errors: [], results: [] })
        : data.fetcher(url, opts),
    }));
    assert.equal(result.last_run.status, 'complete');
    assert.equal(result.products, 3);
    assert.equal(store.db.prepare('SELECT product_count FROM catalog_downloads WHERE group_id=999').get().product_count, 0);
  } finally { store.close(); }
});
