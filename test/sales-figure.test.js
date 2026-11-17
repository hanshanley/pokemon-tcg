import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { csv } from '../src/store.js';
import { salesPlotRows, salesFigure, writeSalesFigure } from '../src/sales-figure.js';

const coverage = {
  last_successful_check_at: '2026-11-04T18:00:00Z',
  sweep: { products_checked: 9, products_expected: 10, products_failed: 1 },
};
const rows = [1,2,3,4].map(date => ({
  date_source: `2026-11-0${date}`, units: 10, priced_units: 10, unpriced_units: 0,
  priced_sales_lower_usd: 100, priced_sales_upper_usd: 120,
}));

test('historical bounds preserve price gaps and never connect the partial latest day', () => {
  const data = rows.map(row => ({ ...row }));
  Object.assign(data[1], { priced_units: 5, unpriced_units: 5 });
  const figure = salesFigure(data,coverage);
  assert.deepEqual(figure.data.map(row => row.plot_status),
    ['historical','partial_prices','historical','partial_day']);
  assert.equal(figure.data[1].plot_lower_usd,'');
  assert.equal((figure.svg.match(/<polyline data-series="historical"/g) ?? []).length,4);
  assert.equal((figure.svg.match(/data-series="partial-day"/g) ?? []).length,1);
  assert.ok(!figure.svg.includes('<polygon'));
  assert.ok(figure.alt.includes('9 / 10 products checked; 1 failed'));
  assert.ok(figure.alt.includes('1 dates omitted'));
  assert.ok(figure.svg.includes('not a confidence interval or exact revenue'));
  assert.ok(!/NaN|Infinity/.test(figure.svg));
});

test('an entirely absent source date breaks the historical band', () => {
  const { svg } = salesFigure([rows[0],rows[2],rows[3]],coverage);
  assert.ok(!svg.includes('<polygon'));
  assert.equal((svg.match(/<polyline /g) ?? []).length,4);
});

test('only explicit priced zero days plot at zero, while missing prices stay unavailable', () => {
  const zero = { ...rows[0], units: 0, priced_units: 0, unpriced_units: 0,
    priced_sales_lower_usd: 0, priced_sales_upper_usd: 0 };
  assert.equal(salesPlotRows([zero],coverage)[0].plot_lower_usd,0);
  assert.ok(salesFigure([zero],coverage).svg.includes('2026-11-01: partial day, $0 to $0'));
  const absent = { ...rows[0], priced_units: '', priced_sales_lower_usd: '', priced_sales_upper_usd: '' };
  assert.equal(salesPlotRows([absent],coverage)[0].plot_status,'missing_prices');
  assert.ok(salesFigure([absent],coverage).svg.includes('no zero sales inferred'));
  assert.throws(() => salesFigure([],coverage),/No observed/);
});

test('the latest source day remains preliminary across UTC midnight with an unpublished source timezone', () => {
  const afterMidnight = { ...coverage, last_successful_check_at: '2026-11-05T00:15:00Z' };
  assert.equal(salesPlotRows(rows,afterMidnight).at(-1).plot_status,'partial_day');
  const { svg } = salesFigure(rows,afterMidnight);
  assert.equal((svg.match(/data-series="partial-day"/g) ?? []).length,1);
  assert.ok(svg.includes('Nov 4): $100 to $120; partial day'));
});

test('chart inputs reject inconsistent quantities, bounds, dates and duplicates', () => {
  for (const change of [{ units: '' }, { units: -1 }, { priced_units: 11 },
    { unpriced_units: 5 }, { priced_sales_upper_usd: 99 }, { priced_sales_lower_usd: -1 },
    { priced_sales_upper_usd: 'invalid' }, { date_source: '2026-02-31' }]) {
    assert.throws(() => salesPlotRows([{ ...rows[0], ...change }],coverage),/Invalid/);
  }
  assert.throws(() => salesPlotRows([rows[0],rows[0]],coverage),/duplicate/);
  assert.throws(() => salesPlotRows(rows,{}),/observation date/);
});

test('publication backgrounds change no non-background chart content', () => {
  const normal = salesFigure(rows,coverage).svg;
  const moe = salesFigure(rows,coverage,'#F2EFE7').svg;
  assert.equal(normal.replace('#F7F5F0','#F2EFE7'),moe);
});

test('the publication bundle includes actual PNGs, replay data, captions and verified input/output hashes', async t => {
  const directory = mkdtempSync(join(tmpdir(),'pokemon-sales-figure-'));
  t.after(() => rmSync(directory,{ recursive: true, force: true }));
  writeFileSync(join(directory,'coverage.json'),JSON.stringify({
    ...coverage, last_successful_check_at: '2026-11-05T00:15:00Z',
  }));
  writeFileSync(join(directory,'daily-trading.csv'),csv(rows,Object.keys(rows[0])));
  await writeSalesFigure(directory);
  const metadata = JSON.parse(readFileSync(join(directory,'sales-value.json'),'utf8'));
  const hash = name => createHash('sha256').update(readFileSync(join(directory,name))).digest('hex');
  for (const [name,digest] of Object.entries({ ...metadata.source_sha256, ...metadata.files_sha256 })) {
    assert.equal(hash(name),digest);
  }
  assert.equal(metadata.rows,4);
  assert.ok(metadata.caption.includes('not a confidence interval'));
  assert.ok(metadata.alt.includes('partial day'));
  assert.ok(readFileSync(join(directory,'sales-value.csv'),'utf8').includes('"partial_day"'));
  for (const name of ['sales-value.png','sales-value-moe.png']) {
    const bytes = readFileSync(join(directory,name));
    assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16),1200);
    assert.equal(bytes.readUInt32BE(20),800);
  }
});
