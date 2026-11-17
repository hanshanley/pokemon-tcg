import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { dailyCsv, writeVolumeFigure } from './figures.js';
import { csv } from './store.js';

const day = 86400000;
const escape = value => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const count = value => Number(value).toLocaleString('en-US');
const dateLabel = value => new Date(`${value}T00:00:00Z`).toLocaleDateString('en-US',
  { month: 'short', day: 'numeric', timeZone: 'UTC' });
const usd = value => value === 0 ? '$0' : value >= 1e6 ? `$${+(value / 1e6).toFixed(2)}m`
  : value >= 1000 ? `$${+(value / 1000).toFixed(1)}k` : `$${+value.toFixed(2)}`;

export function salesPlotRows(rows, coverage) {
  const checkedDate = (coverage.last_successful_check_at ?? coverage.generated_at)?.slice(0,10);
  if (!checkedDate || !/^\d{4}-\d{2}-\d{2}$/.test(checkedDate) ||
      !Number.isFinite(Date.parse(checkedDate))) throw new Error('Missing sales chart observation date.');
  const latestDate = rows.reduce((latest,row) => row.date_source > latest ? row.date_source : latest,'');
  const seen = new Set();
  return rows.map(row => {
    const time = Date.parse(`${row.date_source}T00:00:00Z`);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,10) !== row.date_source ||
        seen.has(row.date_source)) throw new Error('Invalid or duplicate sales chart date.');
    seen.add(row.date_source);
    const units = Number(row.units), priced = Number(row.priced_units);
    const available = row.priced_units !== '' && row.priced_units != null &&
      row.priced_sales_lower_usd !== '' && row.priced_sales_lower_usd != null &&
      row.priced_sales_upper_usd !== '' && row.priced_sales_upper_usd != null;
    const low = available ? Number(row.priced_sales_lower_usd) : null;
    const high = available ? Number(row.priced_sales_upper_usd) : null;
    if (row.units === '' || row.units == null || !Number.isSafeInteger(units) || units < 0 ||
        available && (!Number.isSafeInteger(priced) || priced < 0 || priced > units ||
          !Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < low ||
          row.unpriced_units != null && row.unpriced_units !== '' && Number(row.unpriced_units) !== units - priced)) {
      throw new Error('Invalid sales chart quantity or price bounds.');
    }
    const status = !available ? 'missing_prices' : priced < units ? 'partial_prices'
      : row.date_source === latestDate || row.date_source >= checkedDate ? 'partial_day' : 'historical';
    const plotted = ['historical','partial_day'].includes(status);
    return { ...row, plot_status: status,
      plot_lower_usd: plotted ? low : '', plot_upper_usd: plotted ? high : '' };
  }).sort((a,b) => a.date_source.localeCompare(b.date_source));
}

export function salesFigure(rows, coverage, background = '#F7F5F0') {
  if (!rows.length) throw new Error('No observed daily sales to plot.');
  if (!['#F7F5F0','#F2EFE7'].includes(background)) throw new Error('Unsupported chart background.');
  const data = salesPlotRows(rows, coverage);
  const first = data[0].date_source, last = data.at(-1).date_source;
  const minimum = Date.parse(first), maximum = Date.parse(last);
  const x = date => maximum === minimum ? 615 : 100 + (Date.parse(date) - minimum) / (maximum - minimum) * 1030;
  const top = 160, bottom = 570;
  const visible = data.filter(row => row.plot_lower_usd !== '');
  const rawCeiling = Math.max(1,...visible.map(row => row.plot_upper_usd)) * 1.08;
  const magnitude = 10 ** Math.floor(Math.log10(rawCeiling));
  const ceiling = [1,2,2.5,5,10].find(value => value >= rawCeiling / magnitude) * magnitude;
  const y = value => bottom - value / ceiling * (bottom - top);
  const text = (left, baseline, value, attributes = '') =>
    `<text x="${left}" y="${baseline}" ${attributes}>${escape(value)}</text>`;
  const missing = data.filter(row => ['missing_prices','partial_prices'].includes(row.plot_status)).length;
  const latest = data.findLast(row => row.plot_status === 'partial_day');
  const sweep = coverage.sweep;
  const latestNote = latest ? `Latest source date (${dateLabel(latest.date_source)}): ${usd(latest.plot_lower_usd)} to ${usd(latest.plot_upper_usd)}; partial day, shown separately.`
    : 'No same-day estimate is connected to the historical series.';
  const coverageNote = sweep ? `Catalog sweep: ${count(sweep.products_checked)} / ${count(sweep.products_expected)} products checked; ${count(sweep.products_failed)} failed.`
    : 'Catalog sweep completeness is not established.';
  const caption = 'Daily observed Pokemon item-value bounds on TCGplayer, across English and Japanese catalog products. ' +
    'Bounds sum SKU-day quantities multiplied by actual low/high unit sale prices; they are not a confidence interval or exact revenue. ' +
    'Shipping and tax are excluded. Dates with incomplete price coverage are omitted from the line but retained in the CSV. ' +
    'The latest source day is shown separately when still in progress. Catalog and historical sales coverage are not certified marketplace totals.';
  const alt = `Pokemon sales value from ${first} to ${last}. ${latestNote} ${coverageNote} ${missing} dates omitted for incomplete prices.`;
  let marks = '';
  for (let tick = 0; tick <= 4; tick++) {
    const value = ceiling * tick / 4;
    marks += `<path d="M100,${y(value)}H1130" class="grid"/>` +
      text(83,y(value) + 6,usd(value),'class="axis" text-anchor="end"');
  }
  const segments = [];
  let segment = [];
  const flush = () => { if (segment.length) segments.push(segment); segment = []; };
  for (const row of data) {
    if (row.plot_status !== 'historical' ||
        segment.length && Date.parse(row.date_source) - Date.parse(segment.at(-1).date_source) !== day) flush();
    if (row.plot_status === 'historical') segment.push(row);
  }
  flush();
  for (const part of segments) {
    const coordinates = field => part.map(row => `${x(row.date_source)},${y(row[field])}`);
    if (part.length > 1) marks += `<polygon data-series="historical" points="${[
      ...coordinates('plot_upper_usd'), ...coordinates('plot_lower_usd').reverse(),
    ].join(' ')}" fill="#C85A3D" fill-opacity="0.18"/>`;
    for (const field of ['plot_lower_usd','plot_upper_usd']) {
      marks += `<polyline data-series="historical" points="${coordinates(field).join(' ')}" fill="none" stroke="#C85A3D" stroke-width="2.2"/>`;
      for (const row of part) marks += `<circle cx="${x(row.date_source)}" cy="${y(row[field])}" r="2" fill="#C85A3D"><title>${escape(`${row.date_source}: ${usd(row.plot_lower_usd)} to ${usd(row.plot_upper_usd)}`)}</title></circle>`;
    }
  }
  for (const row of data.filter(row => row.plot_status === 'partial_day')) {
    const left = x(row.date_source), low = y(row.plot_lower_usd), high = y(row.plot_upper_usd);
    marks += `<path data-series="partial-day" d="M${left},${low}V${high}M${left - 5},${low}h10M${left - 5},${high}h10" fill="none" stroke="#3D6F8C" stroke-width="2.5"><title>${escape(`${row.date_source}: partial day, ${usd(row.plot_lower_usd)} to ${usd(row.plot_upper_usd)}`)}</title></path>`;
  }
  if (!visible.length) marks += text(615,355,'Price coverage unavailable; no zero sales inferred.',
    'class="muted" text-anchor="middle"');
  const tickCount = Math.min(6,data.length);
  for (let index = 0; index < tickCount; index++) {
    const row = data[Math.round(index * (data.length - 1) / Math.max(1,tickCount - 1))];
    marks += text(x(row.date_source),607,dateLabel(row.date_source),'class="axis" text-anchor="middle"');
  }
  const checked = coverage.last_successful_check_at?.replace('T',' ').slice(0,16) ?? 'not established';
  return { data, caption, alt, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800" role="img" aria-labelledby="title description">
<title id="title">Daily Pokemon sales value on TCGplayer</title>
<desc id="description">${escape(alt)}</desc>
<style>text{font-family:Georgia,"Liberation Serif","Times New Roman",serif;fill:#1A1A1A;font-size:19px}.title{font-size:32px;font-weight:600}.muted,.axis{fill:#6B6B6B}.axis{font-size:18px}.note{font-size:16px;fill:#6B6B6B}.grid{stroke:#D6D3CC;stroke-width:1}</style>
<rect data-role="background" width="1200" height="800" fill="${background}"/>
${text(60,48,'Daily Pokemon sales value on TCGplayer','class="title"')}
${text(60,81,'All observed Pokemon catalog products; USD, excluding shipping and tax.','class="muted"')}
${text(60,111,`${dateLabel(first)} to ${dateLabel(last)}, ${last.slice(0,4)} | English and Japanese singles and sealed products`,'class="muted"')}
${text(100,143,'USD per source date','class="muted"')}
${text(1130,143,'Observed low-high bounds','text-anchor="end" style="fill:#C85A3D"')}
${marks}
${text(60,651,latestNote,'style="fill:#3D6F8C"')}
${text(60,679,coverageNote,'class="muted"')}
${text(60,714,'Band = actual SKU-day price bounds x quantity, not a confidence interval or exact revenue.','class="note"')}
${text(60,740,`${missing} dates with incomplete prices omitted. Historical coverage varies; source timezone unpublished.`,'class="note"')}
${text(60,766,`Source: TCGplayer native SKU-day histories. Last successful source check: ${checked} UTC.`,'class="note"')}
</svg>\n` };
}

export async function writeSalesFigure(directory) {
  const sources = ['daily-trading.csv','coverage.json'];
  const coverage = JSON.parse(readFileSync(join(directory,'coverage.json'),'utf8'));
  const rows = dailyCsv(join(directory,'daily-trading.csv'));
  const figure = salesFigure(rows,coverage);
  const variants = [['sales-value','#F7F5F0'],['sales-value-moe','#F2EFE7']];
  const files = [];
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
    for (const [name,background] of variants) {
      const { svg } = salesFigure(rows,coverage,background);
      writeFileSync(join(directory,`${name}.svg`),svg);
      await page.setContent(`<style>html,body{margin:0}</style>${svg}`);
      await page.evaluate(() => document.fonts.ready);
      const outside = await page.locator('svg text').evaluateAll(elements => elements.filter(element => {
        const box = element.getBBox();
        return box.x < 0 || box.y < 0 || box.x + box.width > 1200 || box.y + box.height > 800;
      }).map(element => element.textContent));
      if (outside.length) throw new Error(`Sales chart text is clipped: ${outside.join('; ')}`);
      await page.screenshot({ path: join(directory,`${name}.png`) });
      files.push(`${name}.svg`,`${name}.png`);
    }
  } finally { await browser.close(); }
  writeFileSync(join(directory,'sales-value.csv'),csv(figure.data,Object.keys(figure.data[0])));
  files.push('sales-value.csv');
  const hash = name => createHash('sha256').update(readFileSync(join(directory,name))).digest('hex');
  writeFileSync(join(directory,'sales-value.json'),`${JSON.stringify({
    title: 'Daily Pokemon sales value on TCGplayer', caption: figure.caption, alt: figure.alt,
    source_sha256: Object.fromEntries(sources.map(name => [name,hash(name)])),
    files_sha256: Object.fromEntries(files.map(name => [name,hash(name)])),
    backgrounds: Object.fromEntries(variants), latest_sweep: coverage.sweep,
    rows: figure.data.length,
  },null,2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve('reports/latest');
  writeVolumeFigure(directory);
  await writeSalesFigure(directory);
}
