import test from 'node:test';
import assert from 'node:assert/strict';
import { volumeFigure } from '../src/figures.js';

const coverage = {
  units: 6, transactions: 4, last_successful_check_at: '2026-11-03T12:00:00Z',
  price_volume: { priced_units: 3, priced_sales_lower_usd: 14, priced_sales_upper_usd: 20 },
  sweep: { date_utc: '2026-11-03', status: 'paused', products_checked: 4, products_expected: 10 },
};
const daily = [2,3,1].map((units, index) => ({
  date_source: `2026-11-0${index + 1}`, units, products_with_history: 4,
}));
const values = daily.map((row, index) => ({
  ...row, priced_units: [2,0,1][index],
  priced_sales_lower_usd: [10,0,4][index], priced_sales_upper_usd: [12,0,8][index],
}));

test('volume figure separates priced-subset bounds from unit totals and leaves missing prices as gaps', () => {
  const svg = volumeFigure(daily, values, coverage);
  assert.ok(svg.includes('6 observed units and 4 reported transactions. Priced subset: $14 to $20'));
  assert.ok(svg.includes('3 of 6 observed units (50.0%)'));
  assert.equal((svg.match(/<polygon /g) ?? []).length, 2);
  assert.ok(!svg.includes('2026-11-02: $0'));
  assert.ok(svg.includes('2026-11-02: 3 observed units'));
  assert.ok(svg.includes('4 / 10 products checked'));
  assert.ok(svg.includes('not total revenue'));
  assert.ok(!/NaN|Infinity/.test(svg));
});

test('volume figure rejects absent history and handles a single zero day without inventing revenue', () => {
  assert.throws(() => volumeFigure([], [], coverage), /No observed daily volume/);
  const svg = volumeFigure([{ ...daily[0], units: 0 }], [], {
    ...coverage, units: 0, transactions: 0, sweep: null,
    price_volume: { priced_units: 0, priced_sales_lower_usd: 0, priced_sales_upper_usd: 0 },
  });
  assert.ok(svg.includes('Unavailable'));
  assert.ok(svg.includes('Sale-price coverage unavailable'));
  assert.ok(!/NaN|Infinity/.test(svg));
});
