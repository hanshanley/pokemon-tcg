import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const number = value => new Intl.NumberFormat('en-US').format(value);
const compact = value => new Intl.NumberFormat('en-US',
  { notation: 'compact', maximumFractionDigits: 2 }).format(value);
const xml = value => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

// These two exported CSVs contain only quoted date labels and numeric fields.
function dailyCsv(path) {
  const [header, ...lines] = readFileSync(path, 'utf8').trimEnd().split(/\r?\n/);
  const cells = line => line.split(',').map(cell => {
    if (!/^"[\w.-]*"$/.test(cell)) throw new Error('Unexpected daily report CSV field.');
    return cell.slice(1, -1);
  });
  const keys = cells(header);
  return lines.map(line => {
    const values = cells(line);
    if (values.length !== keys.length) throw new Error('Incomplete daily report CSV row.');
    return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
  });
}

export function volumeFigure(daily, values, coverage) {
  if (!daily.length) throw new Error('No observed daily volume to plot.');
  const points = daily.map(row => ({ ...row, time: Date.parse(`${row.date_source}T00:00:00Z`) }))
    .sort((a, b) => a.time - b.time);
  const prices = new Map(values.map(row => [row.date_source, row]));
  const text = (x, y, value, attributes = '') =>
    `<text x="${x}" y="${y}" ${attributes}>${xml(value)}</text>`;
  const minimum = points[0].time, maximum = points.at(-1).time;
  const coordinates = (left, time) => left + 52 + (maximum === minimum ? 226
    : (time - minimum) / (maximum - minimum) * 452);
  const bottom = 415, height = 190;
  const plot = (left, money) => {
    const data = points.map(row => {
      const price = prices.get(row.date_source);
      return { ...row, low: money ? price && (Number(price.priced_units) > 0 ||
        Number(price.units) === 0) ? Number(price.priced_sales_lower_usd) : null : Number(row.units),
      high: money ? price && (Number(price.priced_units) > 0 ||
        Number(price.units) === 0) ? Number(price.priced_sales_upper_usd) : null : Number(row.units) };
    });
    const ceiling = Math.max(1, ...data.map(row => row.high ?? 0)) * 1.1;
    const y = value => bottom - value / ceiling * height;
    let markup = text(left, 181, money ? 'Daily item-value bounds' : 'Daily units',
      'class="heading"') + text(left, 202, money ? 'Priced subset only; USD, excluding shipping and tax'
      : 'Reported quantities, not a count of customer orders', 'class="muted"');
    for (let tick = 0; tick <= 4; tick++) {
      const value = ceiling * tick / 4;
      markup += `<path d="M${left + 52},${y(value)}h452" class="grid"/>` +
        text(left + 44, y(value) + 4, `${money ? '$' : ''}${compact(value)}`, 'text-anchor="end" class="axis"');
    }
    if (!money) {
      const width = Math.min(16, 452 / Math.max(1, (maximum - minimum) / 86400000 + 1) * 0.7);
      for (const row of data) markup += `<rect x="${coordinates(left, row.time) - width / 2}" y="${y(row.low)}" width="${width}" height="${bottom - y(row.low)}" fill="#375f7d"><title>${xml(row.date_source)}: ${number(row.low)} observed units; ${number(Number(row.products_with_history))} products with history</title></rect>`;
    } else {
      let segment = [];
      const flush = () => {
        if (!segment.length) return;
        const path = [...segment.map(row => `${coordinates(left, row.time)},${y(row.high)}`),
          ...[...segment].reverse().map(row => `${coordinates(left, row.time)},${y(row.low)}`)];
        markup += `<polygon points="${path.join(' ')}" fill="#dbe5dc"/>`;
        for (const field of ['low','high']) markup += `<polyline points="${segment.map(row =>
          `${coordinates(left, row.time)},${y(row[field])}`).join(' ')}" fill="none" stroke="#607c67" stroke-width="1.5"/>`;
        for (const row of segment) markup += `<circle cx="${coordinates(left, row.time)}" cy="${y(row.high)}" r="2" fill="#607c67"><title>${xml(row.date_source)}: $${number(row.low)} to $${number(row.high)}, priced units only</title></circle>`;
        segment = [];
      };
      for (const row of data) {
        if (row.low == null || segment.length && row.time - segment.at(-1).time !== 86400000) flush();
        if (row.low != null) segment.push(row);
      }
      flush();
      if (data.every(row => row.low == null)) markup += text(left + 278, 325,
        'Sale-price coverage unavailable', 'text-anchor="middle" class="muted"');
    }
    const ticks = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
    for (const index of ticks) {
      const row = points[index];
      markup += text(coordinates(left, row.time), 440, new Date(row.time).toLocaleDateString('en-US',
        { month: 'short', day: 'numeric', timeZone: 'UTC' }), 'text-anchor="middle" class="axis"');
    }
    return markup;
  };
  const price = coverage.price_volume, priced = Number(price.priced_units);
  const percent = coverage.units ? (priced / coverage.units * 100).toFixed(1) : '0.0';
  const bounds = priced ? `$${compact(price.priced_sales_lower_usd)} - $${compact(price.priced_sales_upper_usd)}`
    : 'Unavailable';
  const sweep = coverage.sweep;
  const sourceCheck = coverage.last_successful_check_at?.replace('T', ' ').slice(0, 16) ?? 'unknown';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="570" viewBox="0 0 1200 570" role="img" aria-labelledby="title description">
<title id="title">Observed Pokemon sales volume</title>
<desc id="description">${xml(`${number(coverage.units)} observed units and ${number(coverage.transactions)} reported transactions. Priced subset: ${priced ? `$${number(price.priced_sales_lower_usd)} to $${number(price.priced_sales_upper_usd)}` : 'unavailable'}. Coverage is incomplete; missing prices are gaps, not zero revenue.`)}</desc>
<style>text{font-family:Arial,Helvetica,sans-serif;fill:#25333e;font-size:14px}.heading{font-size:17px;font-weight:600}.muted{fill:#66727c;font-size:12px}.axis{fill:#66727c;font-size:11px}.value{font-size:30px;font-weight:600}.grid{stroke:#e5e9ec;stroke-width:1}</style>
<rect width="1200" height="570" fill="#fafbfc"/>
${text(38, 35, 'Observed Pokemon sales volume', 'class="heading"')}
${text(38, 57, `${points[0].date_source} to ${points.at(-1).date_source} | Source checked ${sourceCheck} UTC`, 'class="muted"')}
${text(38, 93, 'Observed units', 'class="muted"')}${text(38, 128, number(coverage.units), 'class="value"')}
${text(330, 93, 'Reported transactions', 'class="muted"')}${text(330, 128, number(coverage.transactions), 'class="value"')}
${text(670, 93, 'Item-value bounds: priced subset, not total revenue', 'class="muted"')}${text(670, 128, bounds, 'class="value"')}
${plot(38, false)}${plot(642, true)}
${text(38, 481, `Price coverage: ${number(priced)} of ${number(coverage.units)} observed units (${percent}%). Missing price bounds appear as gaps.`, 'class="muted"')}
${text(38, 504, 'Coverage differs across dates. Recent dates can be partial; neither chart is a certified marketplace-wide trend.', 'class="muted"')}
${text(38, 527, sweep ? `Latest sweep (${sweep.date_utc}): ${sweep.status}; ${number(sweep.products_checked)} / ${number(sweep.products_expected)} products checked.`
    : 'Catalog-wide sweep completeness is unverified.', 'class="muted"')}
</svg>\n`;
}

export function writeVolumeFigure(directory) {
  const figure = volumeFigure(dailyCsv(join(directory, 'daily-volume.csv')),
    dailyCsv(join(directory, 'daily-sales-value.csv')),
    JSON.parse(readFileSync(join(directory, 'coverage.json'), 'utf8')));
  writeFileSync(join(directory, 'volume.svg'), figure);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeVolumeFigure(resolve('reports/latest'));
}
