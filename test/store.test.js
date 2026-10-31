import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, normalizeSale, productIdFromUrl, csv } from '../src/store.js';

const sale = (overrides = {}) => ({
  orderDate: '2026-10-31T03:30:00+03:00', quantity: 2, purchasePrice: 10.25,
  shippingPrice: 1.5, condition: 'Near Mint', variant: 'Holofoil', language: 'English',
  ...overrides,
});
const product = (store, id = 42382, extra = {}) => {
  store.addProduct({ url: `https://www.tcgplayer.com/product/${id}`,
    name: 'Charizard', kind: 'single', pokemon: ['Charizard'], ...extra });
  return store.products().find(p => p.id === id);
};

test('product URLs reject foreign hosts, credentials, non-HTTPS, and non-product pages', () => {
  assert.equal(productIdFromUrl('https://www.tcgplayer.com/product/42382/a-slug?foo=bar'), 42382);
  for (const url of ['http://www.tcgplayer.com/product/1', 'https://tcgplayer.com.evil.test/product/1',
    'https://user@www.tcgplayer.com/product/1', 'https://www.tcgplayer.com:9000/product/1',
    'https://www.tcgplayer.com/search']) assert.throws(() => productIdFromUrl(url));
});

test('normalization uses UTC, quantity and integer cents; never invents missing quantity or price', () => {
  assert.deepEqual(normalizeSale(sale()), {
    sold_at: '2026-10-31T00:30:00.000Z', quantity: 2, unit_price_cents: 1025,
    shipping_cents: 150, condition: 'Near Mint', variant: 'Holofoil', language: 'English',
    listing_type: '',
  });
  for (const override of [{ quantity: undefined }, { quantity: 0 }, { quantity: 1.5 },
    { purchasePrice: undefined }, { purchasePrice: '' }, { purchasePrice: -1 },
    { orderDate: '2026-10-31T00:30:00' }]) assert.throws(() => normalizeSale(sale(override)));
});

test('overlapping snapshots deduplicate without discarding identical simultaneous sales', () => {
  const store = new Store(':memory:');
  try {
    const p = product(store);
    assert.equal(store.record(p, { sales: [sale(), sale()] }).rowsAdded, 2);
    assert.equal(store.record(p, { sales: [sale(), sale()] }).rowsAdded, 0);
    assert.equal(store.record(p, { sales: [sale()] }).rowsAdded, 0);
    assert.equal(store.record(p, { sales: [sale(), sale(), sale()] }).rowsAdded, 1);
    assert.equal(store.metrics().total.units, 6);
  } finally { store.close(); }
});

test('daily units and dollars separate singles, sealed products and species tags', () => {
  const store = new Store(':memory:');
  try {
    const single = product(store);
    const sealed = product(store, 502002, { name: 'Sealed box', kind: 'sealed', pokemon: ['Charizard'] });
    const second = product(store, 12345, { name: 'Charizard ex', pokemon: ['charizard'] });
    store.record(single, { sales: [sale()] });
    store.record(second, { sales: [sale({ quantity: 1, purchasePrice: 5 })] });
    store.record(sealed, { sales: [sale({ quantity: 3, purchasePrice: 40 })] });
    assert.deepEqual(store.metrics().total, { sale_records: 3, units: 6, sales_usd: 145.5 });
    assert.deepEqual(store.metrics().pokemon, [{ name: 'Charizard', sale_records: 2, units: 3, sales_usd: 25.5 }]);
    assert.equal(store.metrics({ kind: 'sealed' }).pokemon.length, 0);
    assert.equal(store.metrics({ from: '2026-10-30', to: '2026-10-30' }).daily.length, 0);
    assert.equal(store.metrics().daily[0].name, '2026-10-31');
    assert.throws(() => store.metrics({ from: '2026-02-30' }));
    assert.throws(() => store.metrics({ from: '2026-10-31', to: '2026-10-01' }));
  } finally { store.close(); }
});

test('failure means unavailable and non-overlapping snapshots flag possible gaps', () => {
  const store = new Store(':memory:');
  try {
    const p = product(store);
    store.record(p, { sales: [], status: 'failed', warning: 'HTTP 403.' });
    assert.equal(store.products()[0].last_status, 'failed');
    assert.equal(store.metrics().daily.length, 0);
    store.record(p, { sales: [sale()] });
    const later = store.record(p, { sales: [sale({ orderDate: '2026-11-01T00:00:00Z' })] });
    assert.match(later.warnings.join(' '), /No overlap/);
  } finally { store.close(); }
});

test('invalid snapshots are atomic and saved records persist across reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pokemon-sales-test-'));
  const path = join(dir, 'sales.sqlite');
  let store = new Store(path);
  try {
    const p = product(store);
    assert.throws(() => store.record(p, { sales: [sale(), sale({ quantity: -1 })] }));
    assert.equal(store.saleRows().length, 0);
    store.record(p, { sales: [sale()] });
    store.close();
    store = new Store(path);
    assert.equal(store.metrics().total.sales_usd, 20.5);
    assert.equal(store.products().length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('CSV preserves complete rows, quotes special characters and neutralizes spreadsheet formulas', () => {
  const output = csv([{ name: 'A,"B"', value: 2 }, { name: '=1+1', value: 3 }], ['name', 'value']);
  assert.match(output, /"A,""B""","2"/);
  assert.match(output, /"'=1\+1","3"/);
  assert.equal(output.trim().split('\r\n').length, 3);
});
