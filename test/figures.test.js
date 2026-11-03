import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyTradingRows, volumeFigure } from '../src/figures.js';

const coverage = {
  units: 6, transactions: 4, last_successful_check_at: '2026-11-03T12:00:00Z',
  price_volume: { priced_units: 3, priced_sales_lower_usd: 14, priced_sales_upper_usd: 20 },
  sweep: { date_utc: '2026-11-03', status: 'paused', products_checked: 4, products_expected: 10 },
};
const daily = [2,3,1].map((units, index) => ({
  date_source: `2026-11-0${index + 1}`, units, sale_records: [1,2,1][index], products_with_history: 4,
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
  const table = svg.slice(svg.indexOf('Recent daily quantities and dollar value'));
  assert.ok(table.indexOf('>2026-11-03</text>') < table.indexOf('>2026-11-02</text>'));
  assert.match(table, /2026-11-03<\/text>[^\n]*>\$4\.00 - \$8\.00<\/text>/);
  assert.match(table, /2026-11-02<\/text>[^\n]*>Unavailable<\/text>/);
  assert.ok(table.includes('Units bought/sold'));
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

test('daily trading joins quantities and dollars without inventing prices or exact all-unit revenue', () => {
  const rows = dailyTradingRows(daily, [{ ...values[0], priced_units: 1,
    unpriced_units: 1, priced_sales_lower_usd: 10, priced_sales_upper_usd: 10 }]);
  assert.equal(rows[0].units, 2);
  assert.equal(rows[0].sale_records, 1);
  assert.equal(rows[0].priced_units, 1);
  assert.equal(rows[0].priced_sales_lower_usd, 10);
  assert.equal(rows[0].sales_usd, '');
  assert.equal(rows[1].units, 3);
  assert.equal(rows[1].priced_units, '');
  assert.equal(rows[1].sales_usd, '');
  assert.throws(() => dailyTradingRows(daily, [{ ...values[0], units: 99 }]), /disagree/);
});

test('daily table uses exact established dollars but never doubles matching purchases and sales', () => {
  const svg = volumeFigure([daily[0]], [{ ...values[0], unpriced_units: 0,
    priced_sales_lower_usd: 10.25, priced_sales_upper_usd: 10.25,
    sales_lower_usd: 10.25, sales_upper_usd: 10.25, sales_usd: 10.25 }], coverage);
  const table = svg.slice(svg.indexOf('Recent daily quantities and dollar value'));
  assert.match(table, /2026-11-01<\/text>[^\n]*>\$10\.25<\/text>/);
  assert.ok(table.includes('one trade; bought and sold quantities are not added together'));
});
