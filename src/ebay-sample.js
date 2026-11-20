import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csv } from './store.js';

const endpoint = 'repos/jsonifyco/public-datasets';
const path = 'datasets/ebay-us-pok-mon-sold-listings-9c1de2dcf5cc/outputs/77b8757ad9a2/listings-8a836f245cd6/sample.json';
const source = 'https://www.jsonify.com/datasets/ebay-us-pok-mon-sold-listings-9c1de2dcf5cc';
const revisionPattern = /^[a-f0-9]{40}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const priceBases = new Set([
  'displayed sold price', 'displayed price; offer status unknown',
  'asking price; accepted offer undisclosed',
]);
const fields = ['item_id', 'sold_date', 'card', 'grade', 'condition', 'listing_format',
  'currency', 'displayed_price_usd', 'shipping_cost_usd', 'price_basis',
  'best_offer_accepted', 'captured_at', 'item_url'];

function isDate(value) {
  const time = Date.parse(value);
  return datePattern.test(value) && Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value;
}

export function normalizeSample(payload) {
  if (!Array.isArray(payload) || !payload.length || payload.length > 50) {
    throw new Error('Expected 1–50 rows in the public listing sample.');
  }
  return payload.map(row => {
    const item = /^https:\/\/www\.ebay\.com\/itm\/(\d+)$/.exec(row?.item_url);
    const capture = row && Date.parse(row.captured_at);
    const quantity = value => value == null || Number.isFinite(value) && value >= 0;
    if (!item || !isDate(row.sold_date) || !Number.isFinite(capture) ||
        !/(?:Z|[+-]\d{2}:\d{2})$/.test(row.captured_at) ||
        row.sold_date > new Date(capture).toISOString().slice(0, 10) ||
        !['card','grade','condition','listing_format'].every(key => typeof row[key] === 'string') ||
        !row.card.trim() || row.currency !== 'USD' || !priceBases.has(row.price_basis) ||
        ![null, true, false].includes(row.best_offer_accepted) ||
        !quantity(row.sold_price) || !quantity(row.shipping_cost)) {
      throw new Error('Unexpected public eBay sample row; no report was updated.');
    }
    return {
      item_id: item[1], sold_date: row.sold_date, card: row.card, grade: row.grade,
      condition: row.condition, listing_format: row.listing_format, currency: row.currency,
      displayed_price_usd: row.sold_price ?? null, shipping_cost_usd: row.shipping_cost ?? null,
      price_basis: row.price_basis, best_offer_accepted: row.best_offer_accepted,
      captured_at: new Date(capture).toISOString(), item_url: item[0],
    };
  });
}

export function summarizeSamples(samples) {
  const identities = new Map(), days = new Map();
  for (const { revision, rows } of samples) {
    for (const row of rows) {
      const key = `${row.item_id}:${row.sold_date}`;
      const old = identities.get(key);
      if (!old || old.captured_at <= row.captured_at) identities.set(key, { ...row, revision });
    }
  }
  const listings = [...identities.values()].sort((a,b) =>
    a.sold_date.localeCompare(b.sold_date) || a.item_id.localeCompare(b.item_id));
  for (const { sold_date } of listings) days.set(sold_date, (days.get(sold_date) ?? 0) + 1);
  const daily = [...days].map(([sold_date, distinct_listings]) => ({ sold_date, distinct_listings }));
  return { listings, daily };
}

function github(path) {
  return JSON.parse(execFileSync('gh', ['api', path], {
    encoding: 'utf8', env: { ...process.env, GH_PAGER: 'cat' },
    timeout: 45_000, maxBuffer: 2_000_000,
  }));
}

export function updateSample(directory, read = github) {
  let samples;
  try { samples = JSON.parse(readFileSync(join(directory, 'samples.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; samples = []; }
  if (!Array.isArray(samples) || samples.some(s => !revisionPattern.test(s.revision) || !Array.isArray(s.rows))) {
    throw new Error('Invalid retained sample archive.');
  }
  const commits = read(`${endpoint}/commits?path=${encodeURIComponent(path)}&per_page=30`);
  if (!Array.isArray(commits) || !commits.length || commits.some(c => !revisionPattern.test(c.sha))) {
    throw new Error('Missing public sample revisions.');
  }
  const seen = new Set(samples.map(sample => sample.revision));
  for (const { sha } of commits.slice().reverse()) {
    if (seen.has(sha)) continue;
    const response = read(`${endpoint}/contents/${path}?ref=${sha}`);
    if (response.encoding !== 'base64') throw new Error('Expected a public JSON sample attachment.');
    const rows = normalizeSample(JSON.parse(Buffer.from(response.content, 'base64').toString('utf8')));
    samples.push({ revision: sha, rows });
    seen.add(sha);
  }
  const { listings, daily } = summarizeSamples(samples);
  const observations = samples.flatMap(({revision, rows}) => rows.map(row => ({ ...row, revision })));
  const coverage = {
    provider: 'Jsonify', marketplace: 'eBay US', source, license: 'CC BY 4.0',
    license_url: 'https://creativecommons.org/licenses/by/4.0/',
    revisions: samples.length, sample_rows: observations.length, distinct_listings: listings.length,
    last_capture_at: observations.reduce((last, row) => last < row.captured_at ? row.captured_at : last, ''),
    first_sold_date: daily[0].sold_date, last_sold_date: daily.at(-1).sold_date,
    coverage: 'Rotating public sample; not the complete provider dataset, all eBay sales, or TCGplayer sales. Distinct listing ID and sale date pairs, not units or unique transactions.',
    changes: 'Retained factual listing fields only; images and listing titles omitted. Repeated listing/date pairs count once in summaries. Displayed prices may not be the paid amount; no dollar totals.',
  };
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'samples.json'), `${JSON.stringify(samples, null, 2)}\n`);
  writeFileSync(join(directory, 'observations.csv'), csv(observations, [...fields, 'revision']));
  writeFileSync(join(directory, 'listings.csv'), csv(listings, [...fields, 'revision']));
  writeFileSync(join(directory, 'daily.csv'), csv(daily, ['sold_date', 'distinct_listings']));
  writeFileSync(join(directory, 'coverage.json'), `${JSON.stringify(coverage, null, 2)}\n`);
  return coverage;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(updateSample(resolve('reports/ebay-sample')), null, 2));
}
