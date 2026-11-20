import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { dailyCsv, writeVolumeFigure } from './figures.js';
import { csv } from './store.js';

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
  const verified = new Set(coverage.reporting_dates ?? []);
  const closedExports = new Set(coverage.closed_export_dates ?? []);
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
    const status = (row.date_source === latestDate && !closedExports.has(row.date_source)) ||
      row.date_source >= checkedDate ? 'partial_day'
      : !verified.has(row.date_source) ? 'unverified_sweep'
      : !available ? 'missing_prices' : priced < units ? 'partial_prices' : 'historical';
    const plotted = status === 'historical';
    return { ...row, plot_status: status,
      plot_lower_usd: plotted ? low : '', plot_upper_usd: plotted ? high : '',
      plot_midpoint_usd: plotted ? low + (high - low) / 2 : '' };
  }).sort((a,b) => a.date_source.localeCompare(b.date_source));
}

export function salesFigure(rows, coverage, background = '#F7F5F0') {
  if (!rows.length) throw new Error('No observed daily sales to plot.');
  if (!['#F7F5F0','#F2EFE7'].includes(background)) throw new Error('Unsupported chart background.');
  const data = salesPlotRows(rows, coverage);
  const eligible = data.filter(row => !['partial_day','unverified_sweep'].includes(row.plot_status));
  const first = (eligible[0] ?? data[0]).date_source, last = (eligible.at(-1) ?? data.at(-1)).date_source;
  const minimum = Date.parse(first), maximum = Date.parse(last);
  const x = date => maximum === minimum ? 615 : 100 + (Date.parse(date) - minimum) / (maximum - minimum) * 1030;
  const top = 160, bottom = 570;
  const visible = data.filter(row => row.plot_lower_usd !== '');
  const rawStep = Math.max(1,...visible.map(row => row.plot_upper_usd)) * 1.08 / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1,2,2.5,5,10].find(value => value >= rawStep / magnitude) * magnitude;
  const ceiling = step * 5;
  const y = value => bottom - value / ceiling * (bottom - top);
  const text = (left, baseline, value, attributes = '') =>
    `<text x="${left}" y="${baseline}" ${attributes}>${escape(value)}</text>`;
  const missing = data.filter(row => ['missing_prices','partial_prices'].includes(row.plot_status)).length;
  const sweep = coverage.sweep;
  const withheld = data.length - eligible.length;
  const latestNote = `${visible.length} dates shown. ${withheld} retained dates excluded because coverage was unverified or preliminary.`;
  const coverageNote = sweep ? `Latest collection sweep: ${count(sweep.products_checked)} / ${count(sweep.products_expected)} products checked; ${count(sweep.products_failed)} failed.`
    : 'Catalog sweep completeness is not established.';
  const caption = 'Daily observed Pokemon item-value bounds on TCGplayer, across English and Japanese catalog products. ' +
    'Bounds sum SKU-day quantities multiplied by actual low/high unit sale prices; they are not a confidence interval or exact revenue. ' +
    'Shipping and tax are excluded. Only closed source dates supported by verified catalog sweeps and complete price coverage are plotted. ' +
    'The line joins daily range midpoints, not estimated revenue; shading spans the actual low/high bounds. ' +
    'Only consecutive verified dates are joined; gaps are not interpolated. Unverified dates and incomplete prices remain in the CSV. ' +
    'A catalog sweep is not a certified marketplace total.';
  const alt = `Pokemon sales value${eligible.length ? ` from ${first} to ${last}` : ': no dates with verified sweeps'}. A line joins range midpoints with a shaded low-high band, not confidence intervals. Missing or unverified dates break the line and band. ${latestNote} ${coverageNote} ${missing} dates omitted for incomplete prices.`;
  let marks = '';
  for (let tick = 0; tick <= 5; tick++) {
    const value = step * tick;
    marks += `<path d="M100,${y(value)}H1130" class="grid"/>` +
      text(83,y(value) + 6,usd(value),'class="axis" text-anchor="end"');
  }
  let segment = [];
  const point = (row, field) => `${x(row.date_source)},${y(row[field])}`;
  const flush = () => {
    if (!segment.length) return;
    if (segment.length > 1) {
      const bounds = [...segment.map(row => point(row,'plot_upper_usd')),
        ...[...segment].reverse().map(row => point(row,'plot_lower_usd'))];
      marks += `<polygon data-series="daily-band" points="${bounds.join(' ')}" fill="#C85A3D" fill-opacity="0.16"/>`;
      marks += `<polyline data-series="daily-midpoint" points="${segment.map(row => point(row,'plot_midpoint_usd')).join(' ')}" fill="none" stroke="#C85A3D" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round"/>`;
    } else {
      const row = segment[0];
      marks += `<path data-series="isolated-range" d="M${point(row,'plot_lower_usd')}V${y(row.plot_upper_usd)}" fill="none" stroke="#C85A3D" stroke-opacity="0.5" stroke-width="2"/>`;
    }
    for (const row of segment) {
      marks += `<circle data-series="daily-observation" cx="${x(row.date_source)}" cy="${y(row.plot_midpoint_usd)}" r="2.6" fill="#C85A3D"><title>${escape(`${row.date_source}: ${usd(row.plot_lower_usd)} to ${usd(row.plot_upper_usd)}; range midpoint ${usd(row.plot_midpoint_usd)}`)}</title></circle>`;
    }
    segment = [];
  };
  for (const row of data) {
    if (row.plot_lower_usd === '' || segment.length &&
        Date.parse(row.date_source) - Date.parse(segment.at(-1).date_source) !== 86400000) flush();
    if (row.plot_lower_usd !== '') segment.push(row);
  }
  flush();
  if (!visible.length) marks += text(615,355,'No dates with verified sweep and price coverage; no zero sales inferred.',
    'class="muted" text-anchor="middle"');
  const axisDates = data.filter(row => row.date_source >= first && row.date_source <= last);
  const tickCount = eligible.length ? Math.min(6,axisDates.length) : 0;
  for (let index = 0; index < tickCount; index++) {
    const row = axisDates[Math.round(index * (axisDates.length - 1) / Math.max(1,tickCount - 1))];
    marks += text(x(row.date_source),607,dateLabel(row.date_source),'class="axis" text-anchor="middle"');
  }
  const checked = coverage.last_successful_check_at?.replace('T',' ').slice(0,16) ?? 'not established';
  return { data, caption, alt, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800" role="img" aria-labelledby="title description">
<title id="title">Daily Pokemon sales value on TCGplayer</title>
<desc id="description">${escape(alt)}</desc>
<style>text{font-family:Georgia,"Liberation Serif","Times New Roman",serif;fill:#1A1A1A;font-size:19px}.title{font-size:32px;font-weight:600}.muted,.axis{fill:#6B6B6B}.axis{font-size:18px}.note{font-size:16px;fill:#6B6B6B}.grid{stroke:#D6D3CC;stroke-width:1}</style>
<rect data-role="background" width="1200" height="800" fill="${background}"/>
${text(60,48,'Daily Pokemon sales value on TCGplayer','class="title"')}
${text(60,81,'Verified catalog sweep dates only; USD, excluding shipping and tax.','class="muted"')}
${text(60,111,eligible.length
  ? `${first === last ? dateLabel(last) : `${dateLabel(first)} to ${dateLabel(last)}`}, ${last.slice(0,4)} | English and Japanese products`
  : 'No closed dates with verified catalog coverage.','class="muted"')}
${text(100,143,'USD per source date','class="muted"')}
${text(1130,143,'Range midpoint · shaded low–high bounds','text-anchor="end" style="fill:#C85A3D"')}
${marks}
${text(60,651,latestNote,'class="muted"')}
${text(60,679,'Line: daily range midpoint. Shading: low–high bounds. Blank dates are not zero sales.','class="muted"')}
${text(60,714,'Ranges use actual SKU-day low/high sale prices × quantity; not exact revenue or confidence intervals.','class="note"')}
${text(60,740,`${missing ? `${missing} verified dates omitted for incomplete prices. ` : ''}Source timezone unpublished; catalog coverage is not marketplace completeness.`,'class="note"')}
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
