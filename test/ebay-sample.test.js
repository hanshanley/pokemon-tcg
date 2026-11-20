import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateSample, normalizeSample } from '../src/ebay-sample.js';

const row = {
  item_url: 'https://www.ebay.com/itm/123', sold_date: '2026-11-18',
  captured_at: '2026-11-19T09:00:00+00:00', card: 'Magikarp', grade: 'raw',
  condition: 'Pre-Owned', listing_format: 'best offer accepted',
  currency: 'USD', best_offer_accepted: true, sold_price: 400, shipping_cost: null,
  price_basis: 'asking price; accepted offer undisclosed', listing_title: 'Not archived',
};

test('daily import keeps each sample observation but counts repeated listing/date pairs once', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ebay-sample-test-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const old = '1'.repeat(40), newest = '2'.repeat(40);
  const updated = { ...row, captured_at: '2026-11-20T09:00:00Z' };
  const sameItemLater = { ...updated, sold_date: '2026-11-19' };
  let version = 1, fetched = 0;
  const read = endpoint => {
    if (endpoint.includes('/commits?')) return (version === 1 ? [old] : [newest,old]).map(sha => ({ sha }));
    fetched++;
    const data = endpoint.endsWith(old) ? [row] : [updated,sameItemLater];
    return { encoding: 'base64', content: Buffer.from(JSON.stringify(data)).toString('base64') };
  };
  assert.equal(updateSample(dir, read, new Date('2026-11-19T13:00:00Z')).distinct_listings, 1);
  version = 2;
  const now = new Date('2026-11-20T13:00:00Z');
  const coverage = updateSample(dir, read, now);
  assert.equal(coverage.distinct_listings, 2);
  assert.equal(coverage.sample_rows, 3);
  assert.equal(coverage.last_capture_at, '2026-11-20T09:00:00.000Z');
  assert.deepEqual(updateSample(dir, read, now), coverage);
  assert.equal(fetched, 2);
  const csv = readFileSync(join(dir, 'listings.csv'), 'utf8');
  assert.match(csv, /asking price; accepted offer undisclosed/);
  assert.doesNotMatch(csv, /transaction_count|quantity|paid_price|Not archived/);
  assert.match(readFileSync(join(dir, 'daily.csv'), 'utf8'), /"2026-11-18","1"\r\n"2026-11-19","1"/);
  assert.equal(readFileSync(join(dir, 'observations.csv'), 'utf8').trim().split('\r\n').length, 4);
  const files = ['samples.json', 'observations.csv', 'listings.csv', 'daily.csv', 'coverage.json'];
  const before = files.map(file => readFileSync(join(dir, file), 'utf8'));
  for (const invalidNow of ['2026-11-21T15:20:00Z', '2026-11-20T08:54:00Z']) {
    assert.throws(() => updateSample(dir, read, new Date(invalidNow)), /stale or invalid/);
    assert.deepEqual(files.map(file => readFileSync(join(dir, file), 'utf8')), before);
  }
});

test('unexpected price units, impossible dates and foreign listing links fail validation', () => {
  for (const overrides of [
    { sold_price: '400' }, { price_basis: 'unknown format' }, { currency: 'EUR' },
    { sold_date: '2026-02-31' }, { sold_date: '2026-11-20' },
    { item_url: 'https://www.ebay.com.example.org/itm/123' },
  ]) assert.throws(() => normalizeSample([{ ...row, ...overrides }]), /Unexpected public eBay sample row/);
});
