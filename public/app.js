const $ = selector => document.querySelector(selector);
const number = value => new Intl.NumberFormat('en-US').format(value);
const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
let metrics;
let loading = false;
let catalogOffset = 0;
let catalogLoading = false;

function message(text) { $('#message').textContent = text; }

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function post(path, data) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data) });
}

function table(target, headers, rows) {
  const wrapper = document.createElement('div');
  wrapper.className = 'table-wrap';
  if (!rows.length) {
    wrapper.className = 'empty';
    wrapper.textContent = 'No observed records in this date range.';
  } else {
    const table = document.createElement('table');
    const thead = table.createTHead();
    const heading = thead.insertRow();
    for (const header of headers) {
      const th = document.createElement('th');
      th.textContent = header;
      heading.append(th);
    }
    const body = table.createTBody();
    for (const row of rows) {
      const tr = body.insertRow();
      for (const value of row) {
        const td = tr.insertCell();
        if (value instanceof Node) td.append(value);
        else td.textContent = value;
      }
    }
    wrapper.append(table);
  }
  $(target).replaceChildren(wrapper);
}

function link(product) {
  const a = document.createElement('a');
  a.href = product.url;
  a.textContent = product.name;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function drawChart() {
  const data = metrics?.daily ?? [];
  if (!data.length) {
    $('#chart').textContent = 'No saved transactions in this range. A bulk product catalog does not establish sales volume; unavailable data is not zero.';
    return;
  }
  const key = $('#measure').value;
  const width = 1000, height = 250, left = 65, bottom = 30, top = 12;
  const max = Math.max(1, ...data.map(d => d[key]));
  const start = Date.parse(`${$('#from').value}T00:00:00Z`);
  const end = Date.parse(`${$('#to').value}T00:00:00Z`);
  const days = Math.max(1, (end - start) / 86400000 + 1);
  const space = (width - left - 12) / days;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Daily observed ${key === 'units' ? 'units sold' : 'sales value in USD'}, UTC`);
  const node = (tag, attrs, text) => {
    const el = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    if (text) el.textContent = text;
    svg.append(el);
    return el;
  };
  for (let i = 0; i <= 4; i++) {
    const y = top + (height - bottom - top) * i / 4;
    node('line', { x1: left, x2: width - 12, y1: y, y2: y, class: 'chart-grid' });
    const value = max * (1 - i / 4);
    node('text', { x: left - 10, y: y + 4, 'text-anchor': 'end', class: 'chart-label' },
      key === 'units' ? number(Math.round(value)) : `$${number(Math.round(value))}`);
  }
  for (const item of data) {
    const index = (Date.parse(`${item.name}T00:00:00Z`) - start) / 86400000;
    const barHeight = item[key] / max * (height - bottom - top);
    const rect = node('rect', { x: left + index * space + space * .15,
      y: height - bottom - barHeight, width: Math.max(.5, space * .7), height: barHeight, class: 'bar' });
    const title = document.createElementNS(ns, 'title');
    title.textContent = `${item.name}: ${number(item.units)} units, ${money(item.sales_usd)}`;
    rect.append(title);
  }
  for (const [date, x, anchor] of [
    [$('#from').value, left, 'start'], [$('#to').value, width - 12, 'end'],
  ]) node('text', { x, y: height - 6, 'text-anchor': anchor, class: 'chart-label' }, date);
  $('#chart').replaceChildren(svg);
}

async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const query = new URLSearchParams(new FormData($('#filters')));
    const [data, status] = await Promise.all([
      api(`/api/metrics?${query}`), api('/api/status'),
    ]);
    metrics = data;
    $('#coverage').textContent = data.coverage;
    const selected = $('#source').value;
    $('#source').replaceChildren(new Option(`Automatic (${data.sales_source})`, ''),
      ...data.available_sources.map(source => new Option(
        source === 'snapshot' ? 'Legacy browser samples' : source, source)));
    $('#source').value = selected;
    $('#catalog-coverage').textContent = `${number(data.catalog.products)} catalog products across ${number(data.catalog.sets)} sets. ${number(data.catalog.products_with_saved_sales)} products have saved sales for source "${data.sales_source}". ${number(data.catalog.species_mapped_products)} products have name-based species tags; ${number(data.catalog.species_needing_review)} HP-bearing products need mapping review. Last catalog sync: ${data.catalog.last_run?.status ?? 'not run'}. ${data.catalog.sales_feed_status}`;
    const hasSales = data.total.sale_records > 0;
    $('#units').textContent = hasSales ? number(data.total.units) : '—';
    $('#revenue').textContent = hasSales ? money(data.total.sales_usd) : '—';
    $('#records').textContent = hasSales ? number(data.total.sale_records) : '—';
    query.set('source', data.sales_source);
    $('#sales-export').href = `/api/export/sales.csv?${query}`;
    $('#daily-export').href = `/api/export/daily.csv?${query}`;
    $('#pokemon-export').href = `/api/export/pokemon-daily.csv?${query}`;
    $('#collect').disabled = !status.browser_sampling_enabled || status.running || !data.tracked_products.length;
    $('#collect').textContent = !status.browser_sampling_enabled ? 'Browser sampling disabled'
      : status.running ? 'Sampling…' : 'Collect diagnostic samples';
    $('#schedule').textContent = status.browser_sampling_enabled
      ? `Diagnostic sampling only. Next: ${status.next_run ?? 'not scheduled'}. ${status.error ?? ''}`
      : 'Page-based collection and its daily scheduler are disabled. Bulk metadata sync and transaction import are separate operations.';
    table('#pokemon-rank', ['Pokemon', 'Units', 'USD'], data.pokemon.slice(0, 10)
      .map(p => [p.name, number(p.units), money(p.sales_usd)]));
    table('#product-rank', ['Product', 'Units', 'USD'], data.products.slice(0, 10)
      .map(p => [p.name, number(p.units), money(p.sales_usd)]));
    table('#tracked', ['Product', 'Type', 'Species tags', 'Last result'], data.tracked_products
      .map(p => [link(p), p.kind, p.pokemon.join(', ') || '—', p.last_status ?? 'Not collected']));
    table('#health', ['Product / finished UTC', 'Result', 'Rows seen / added', 'Coverage notes'],
      data.recent_collections.slice(0, 15).map(c => {
        const warning = document.createElement('div');
        warning.className = 'warning';
        warning.textContent = c.warning;
        return [`${c.product_name} / ${c.finished_at.slice(0, 19).replace('T', ' ')}`,
          c.status, `${c.rows_seen} / ${c.rows_added}`, warning];
      }));
    drawChart();
  } catch (error) { message(error.message); }
  finally { loading = false; }
}

async function refreshCatalog() {
  if (catalogLoading) return;
  catalogLoading = true;
  try {
    const query = new URLSearchParams(new FormData($('#catalog-search')));
    $('#catalog-export').href = `/api/export/catalog.csv?${query}`;
    query.set('offset', catalogOffset);
    query.set('limit', 100);
    const data = await api(`/api/catalog?${query}`);
    table('#catalog-products', ['Product', 'Set', 'Category', 'Species tags'],
      data.products.map(product => [link(product), product.set_name,
        product.category_id === 3 ? 'Pokemon' : 'Pokemon Japan', product.pokemon.join(', ') || 'Unmapped / not a Pokemon card']));
    $('#catalog-page').textContent = data.total
      ? `${number(data.offset + 1)}–${number(data.offset + data.products.length)} of ${number(data.total)}`
      : 'No matching catalog products.';
    $('#catalog-previous').disabled = !catalogOffset;
    $('#catalog-next').disabled = catalogOffset + data.products.length >= data.total;
  } catch (error) { message(error.message); }
  finally { catalogLoading = false; }
}

$('#filters').addEventListener('submit', event => { event.preventDefault(); void refresh(); });
$('#catalog-search').addEventListener('submit', event => {
  event.preventDefault(); catalogOffset = 0; void refreshCatalog();
});
$('#catalog-previous').addEventListener('click', () => {
  catalogOffset = Math.max(0, catalogOffset - 100); void refreshCatalog();
});
$('#catalog-next').addEventListener('click', () => {
  catalogOffset += 100; void refreshCatalog();
});
$('#measure').addEventListener('change', drawChart);
$('#add-product').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const form = new FormData(event.target);
    const result = await post('/api/products', {
      url: form.get('url'),
      pokemon: form.get('pokemon').split(',').map(s => s.trim()).filter(Boolean),
    });
    message(`Added ${result.product.name} as a diagnostic sample product. This does not enable catalog-wide sales collection.`);
    event.target.reset();
    await refresh();
  } catch (error) { message(error.message); }
  finally { button.disabled = false; }
});
$('#collect').addEventListener('click', async () => {
  $('#collect').disabled = true;
  try { await post('/api/collect', {}); message('Collection started. Results and coverage notes appear below.'); }
  catch (error) { message(error.message); }
  await refresh();
});
$('#import').addEventListener('click', async () => {
  const file = $('#import-file').files[0];
  if (!file) return message('Choose a JSON file first.');
  if (file.size > 5_000_000) return message('JSON file must be smaller than 5 MB.');
  try {
    const result = await post('/api/import', JSON.parse(await file.text()));
    message(`Imported ${result.rowsAdded} new observed sale records. Coverage remains unverified.`);
    await refresh();
  } catch (error) { message(error.message); }
});
const today = new Date();
$('#to').value = today.toISOString().slice(0, 10);
today.setUTCDate(today.getUTCDate() - 29);
$('#from').value = today.toISOString().slice(0, 10);
void refresh();
void refreshCatalog();
setInterval(() => { void refresh(); }, 5000);
