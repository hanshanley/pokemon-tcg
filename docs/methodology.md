# Data, methodology and operations

Return to the [project overview](../README.md) or the
[alternative-source assessment](sources.md). Run commands below from the repository root.

**The goal is all Pokemon products, not a watchlist.** This application now
downloads the published Pokemon and Pokemon Japan catalogs in set-level batches,
stores them in SQLite, supports streaming bulk transaction imports, and computes
daily volume and Pokemon rankings in SQL. Native monthly history now supplies
reported daily quantities and transaction counts per SKU. A resumable job covers
the entire catalog through direct API calls in **one storefront browser context**,
not page visits per product. Catalog sync, transaction import and reporting do
not open storefront pages.

**Daily quantity ingestion works; complete individual-transaction ingestion
and marketplace-wide coverage certification remain unresolved.**
The bulk catalog contains metadata, not completed sales. Its product count
must not be mistaken for transaction coverage. The existing 15 real browser
sample records are retained separately; they do not establish daily market totals.
Legacy page-based sampling is disabled. The native daily-volume job is separate.

## Architecture and remaining data requirement

`bulk catalog -> product/species dimensions -> daily SKU API / transaction feed -> SQLite GROUP BY -> dashboard/CSV`

- Catalog: TCGCSV's daily cached TCGplayer API export, categories **3 and 85**.
  Includes singles, sealed products, code cards and other published products;
  it does not filter to currently available listings. Completeness means every
  group in that source snapshot was successfully downloaded and its product
  count reconciled, not that every historical marketplace product is guaranteed.
- Species: PokeAPI's species list, refreshed at most daily during catalog sync.
  Whole-name matching requires positive HP and excludes explicit trainer/energy
  types, avoiding sealed packaging and fossil/trainer name matches. English names, forms and named multi-Pokemon
  cards are handled; missing/localized names and unnamed fusion components still
  need review. Name-based tags are not certified species attribution.
- Daily volume: the native `price/history/{product_id}/detailed?range=month`
  endpoint supplies 30 consecutive one-day buckets per returned SKU, including
  quantity and transaction count. Conditions identify singles versus unopened
  products. Empty histories and errors are recorded separately, not fabricated
  as zeroes. Source date labels are retained; their timezone is not published.
  The first full-catalog sweep takes hours and is not an atomic daily snapshot.
- Transactions: a complete feed must provide product ID, a stable per-transaction ID,
  timezone-aware sale timestamp, units, unit price, and product type, with explicit
  coverage of conditions, languages, variants, history and delayed records.
  A source adapter/data agreement is needed before claiming marketplace totals.
  No such feed is connected, and no paid subscription has been purchased.
- TCGplayer public search and TCGCSV prices are not transaction counts. The
  provider TCGAPIs documents its "full" archive as overlapping three-day buckets,
  not exact daily transaction data. SQL cannot recover missing transactions or
  uniquely reconstruct daily totals from those coarser buckets. This application
  specifically requests the native **month**, not quarter, range for daily volume.

## Run

Requires Node.js 22.13+.

```sh
npm install
npm run catalog
npm start
# In another terminal, collect all products and repeat daily:
npm run volume -- --watch
```

Open `http://127.0.0.1:3000`. **Bulk product catalog** searches the local database
and displays 100 products per page. Its CSV includes every matching product,
not just that page. The dashboard separately reports catalog products,
products with saved sales, species-mapping gaps and daily-volume collection progress.
Native daily history is the automatic source once buckets exist; imported
transaction sources and legacy samples can still be explicitly selected.

## Native daily SKU volume

```sh
# One resumable full-catalog sweep:
npm run volume
# Small live batch, retaining checkpoints for the full sweep:
npm run volume -- --limit 100
# Daily catalog refresh and full sweeps:
npm run volume -- --watch
```

Local manual collection requires Playwright Chromium and a graphical desktop
session in the verified visible mode. GitHub Actions supplies a virtual display
with Xvfb, so remote collection requires no personal desktop session.
If the browser binary is missing, install it with
`npx playwright install chromium`. `HEADLESS=1` is optional, but unsigned Node
requests returned HTTP 403 and headless access is not guaranteed. The collector
does not solve challenges, log in, copy signed requests, or use a personal browser
profile. One ordinary homepage navigation establishes the public browser origin;
every product is then fetched using a plain API request.

SQLite queues **all current catalog IDs**, including singles, trainers, code
cards, sealed products and Pokemon Japan. Calls are sequential with a 250 ms
pause. A per-process lock prevents concurrent collectors. A rerun within the
same UTC queue day skips completed products and retries failed products at most
three times. Successful empty responses mean **no published history**, not zero
sales. HTTP 401/403/429 or three consecutive failures stop the current pass.
Watch mode backs off 30 minutes for rate limits and 15 minutes for transient
failures; denied access exits without attempts to bypass it. Completed sweeps
repeat at the next 00:15 UTC, refreshing the bulk catalog first.

## Daily GitHub updates

The GitHub Actions **Daily remote Pokemon sales** workflow starts at
**00:15 UTC daily**, using GitHub-hosted Ubuntu runners, not this Mac.
It runs three sequential passes of up to 25,000 products each. Each pass
has a four-hour collection deadline, persists its checkpoint, and publishes
complete aggregate CSVs and coverage to the
[`main` branch](https://github.com/hanshanley/pokemon-tcg/tree/main/reports/latest)
as **Hans Hanley**, without Copilot trailers. Publishing uses an isolated checkout and
does not stage or change the development worktree. `main` is the only branch;
if code advances during publication, the report commit is rebased onto it
before retrying the push.

The [daily-volume release](https://github.com/hanshanley/pokemon-tcg/releases/tag/daily-volume)
contains **all retained daily SKU buckets** and the entire current product
catalog as compressed CSVs, alongside the aggregate reports. Downloads are not
metadata-only or limited to the top 25 products. No local SQLite database,
individual transaction records, credentials or browser profile is uploaded.
Release assets are refreshed before the report commit is pushed.
`daily-sales-value.csv`, `pokemon-sales-value.csv` and `product-sales-value.csv`
report actual sale-price bounds, priced/unpriced units, and exact dollars only
where the published bounds establish them. These files are also committed on
`main`; multi-Pokemon species totals remain nonadditive.

`remote-state.sqlite.gz` is a separately constructed **public-only checkpoint**,
containing catalog/species metadata, native daily buckets and resumable queue
state. Local transactions, watchlist records and diagnostics are excluded.
The next runner restores it from GitHub Releases; missing or corrupt state
fails the run instead of silently losing historical data. Corrections replace
counts, and previously saved days survive the rolling source window.

```sh
# Publish a consistent snapshot immediately (requires authenticated git and gh):
npm run publish
# Check an exported coverage file:
npm run publish -- --check coverage.json
```

**No Mac, personal computer or self-hosted runner is required.**
The GitHub reports and release downloads are the remotely updated dataset;
`npm start` remains a local dashboard over that machine's local database.
The old local collection/publishing LaunchAgents are disabled after remote
validation to prevent competing uploads. Transient catalog/browser failures
back off 15 minutes and rate limits 30 minutes. Three consecutive unproductive
transports stop the pass; committed progress resets that recovery budget.
Retries share the pass's product-request limit and four-hour deadline.
Denied access stops the workflow without bypass attempts.

The GitHub Actions **Daily sales data freshness** workflow checks at 16:45 UTC
and can be run manually. It fails if either publication or successful source
checking is over 26 hours old; a newly generated timestamp alone cannot hide
stale data. A fresh partial sweep remains partial, not certified marketplace
coverage. Run **Daily remote Pokemon sales** manually with `max_products=100`
for a bounded validation, or its default of 25,000 for production.

## Daily volume storage and reporting

`daily_volume` keeps only product/SKU identifiers, date labels, condition,
printing, language, quantities, transaction counts and observation timestamps.
The `(product_id, sku_id, date_source)` key **replaces**, rather than adds,
overlapping counts, including downward corrections. Previously saved historical
days remain when the rolling window advances. Updates occur per product, so
today's counts and source corrections can change during collection.

`volume_product_days` maintains product/date/kind rollups in the same transaction
as raw bucket updates. Existing databases backfill these once on startup.
Dashboard and species queries use the rollups; complete SKU exports still read
the original buckets, including explicit zero days.

`daily_sale_prices` preserves the source's daily low/high unit sale prices and
its separate shipping-inclusive price fields, using integer cents. Price and
quantity corrections are atomic. `price_product_days` maintains matching
product/date/kind price-value rollups. Older checkpoints without prices load
as **unpriced**, not zero dollars. Successful legacy queue entries are
automatically rechecked once for prices; old dates outside the source's rolling
window can remain unpriced.

Only explicit daily bucket counts are summed. On live responses, the top-level
SKU total counters sometimes differed from the bucket sums; they are not used
to invent missing daily sales. Market price is **not** average purchase price
or revenue. For a SKU/day with quantity Q and actual low/high unit prices L/H,
item-dollar volume is bounded by Q*L and Q*H. These are **bounds, not an average
or a list of individual sales**. Exact value is determined only when the bounds
coincide. Aggregate `sales_lower_usd`/`sales_upper_usd` require price coverage of
every reported unit; `sales_usd` additionally requires equal bounds.
`priced_sales_lower_usd`/`priced_sales_upper_usd` are subtotals for priced units
only, accompanied by `priced_units` and `unpriced_units`. Shipping and tax are
excluded from these item-dollar calculations. Unknown exact revenue remains
`null`/blank, and market price is never multiplied by quantity.

The dashboard shows the **priced subset's** dollar bounds and price coverage;
its unit chart remains separate. Complete SKU CSVs include all four reported
sale-price fields and `prices_observed_at`. Native unit-only reports retain
blank `sales_usd` columns; use the separate sales-value exports or API
`price_volume` for monetary bounds and derivable exact values.
The current storefront sends signed recent-sale requests; unsigned public POST
access has not been verified.
A complete individual-sale archive is still not connected.

### Automatically retained individual-sale archive

`reports/individual-sales/transactions.csv` was seeded with **20 actual public sale
records** captured on November 1, 2026 across Charizard, Trevenant VMAX, Surging
Sparks Booster Box and Japanese Pikachu: 27 units and $4,497.69
in **captured item-sales value**, not total marketplace volume. Fields include
UTC sale timestamps, quantities, unit prices, reported shipping, condition,
printing and language. Every captured row is downloadable, not just metadata.

The separate `individual-sales` GitHub release contains the complete CSV and
public-only SQLite archive, both compressed, plus `coverage.json`, daily captured
item-sales totals and daily Pokemon rankings. The **Retain public individual
Pokemon sales** GitHub Actions workflow checks these four products every three
hours (`35 */3 * * *` UTC), without this Mac. Each runner restores the archive,
captures ordinary public storefront responses, deduplicates overlapping rows,
retains older sales and republishes every captured row on `main` as Hans Hanley.
This is a bounded forward-retention job, **not** a product-page crawl of the whole catalog.
Signed-out sales-history responses returned five recent rows per product and
the normal UI required sign-in for more. A three-hour check cannot guarantee
capturing every sale in a five-row window. Possible non-overlapping windows
remain flagged across future checkpoints. Failed checks preserve older rows
and do not advance `last_successful_check_at`; denials and rate limits stop
without retrying. A missing/corrupt checkpoint fails instead of restarting empty.

```sh
# Poll only the dedicated public archive, never the production database:
npm run individual
npm run individual -- --publish
```

Before a manual publication, restore the latest release checkpoint, as the
workflow does; an old local copy is not a synchronized remote archive.

Complete catalog-wide transaction ingestion still needs
authenticated access or an authorized feed. Account data, credentials and signed request values
are not included. Daily SKU prices remain a separate dataset.

The native source is `tcgplayer-daily`, reserved from transaction imports.
**All daily SKU buckets CSV** streams every matching bucket, not the ranking
limit or UI page. Daily and per-Pokemon CSVs contain source date labels and
per-date product coverage counts. Empty/failed products and omitted dates remain
unknown. Published SKU histories are not proof that every marketplace sale,
language, listing type or adjustment was included.

Primary endpoint references:
[Crawlora monthly bucket documentation](https://crawlora.net/docs/tcgplayer/tcgplayer-price-history)
and [ReefAPI daily-volume documentation](https://reefapi.com/docs/tcgplayer.md).
Neither paid provider is required or connected; the native endpoint was tested
directly.

### Alternative actual-sale sources

The [source assessment](sources.md) distinguishes actual transactions from
aggregates, lists verified access limitations, and documents additional
providers investigated on November 3, 2026. No paid alternative is connected.

Run `npm run catalog` from a daily external scheduler. It identifies this
application in its User-Agent, waits at least 100 ms between requests, checks
TCGCSV's build marker, and skips an unchanged successful build. Interrupted
syncs resume at the last committed set. Empty successful sets are checkpointed;
failed/incomplete responses cannot mark the catalog complete. Retired catalog
records remain in the database for historical joins. The browser scheduler does
not run unless explicitly enabled for diagnostics.

```sh
# Optional configuration:
PORT=3001 DATA_DIR=./data npm start
```

## Bulk transaction import

Once transaction data is available, import newline-delimited JSON, one
transaction per line. This is **synthetic format documentation**, not a real sale:

```json
{"transaction_id":"example-sale-001","product_id":42382,"kind":"single","orderDate":"2026-10-31T12:00:00Z","quantity":2,"purchasePrice":10.25,"condition":"Near Mint","variant":"Holofoil","language":"English"}
```

```sh
npm run import -- transactions.jsonl licensed-provider
```

`kind` is `single`, `sealed` or `other`. `purchasePrice` is the USD unit price.
If supplied, `currency` must be `USD` and `status` must be `completed`.
Products must already exist in the bulk catalog; no individual-page lookup is
performed. Only transaction fields are retained, and source identifiers are
hashed for deduplication. Reimporting a file adds no duplicates. Identical
transactions with distinct IDs remain distinct. Invalid rows, ID reuse with
changed data, and unknown products roll back the entire file. Large files are
streamed rather than loaded into memory; SQLite may need substantial disk space
for the atomic write transaction. Split provider deliveries into manageable files.

Sources are never summed together: the dashboard automatically selects the
native daily history once present, otherwise the source with the latest newly
inserted transaction. You can explicitly choose
a source. Browser snapshots remain under `snapshot`. Bulk rows do not silently
duplicate legacy browser samples. Complete transaction CSV and daily CSV exports
honor the selected source/date/type filters. Imports remain labeled
**unverified completeness**, even if a file contains many transactions.
**Pokemon daily CSV** includes every matching species/day, not only the dashboard's
top-ranked species. The dashboard API bounds ranking lists to 25 rows; totals,
daily reports and exports remain complete for the selected stored data.

## SQL queries

Run these against `data/sales.sqlite`, for example with the `sqlite3` CLI.
The views are queryable across the entire persisted catalog; they do not load
every transaction into JavaScript. Choose one source to avoid double counting:

```sql
-- Catalog counts, not sales counts.
SELECT category_id, count(*) AS products
FROM catalog_products WHERE is_current=1 GROUP BY category_id;

-- Exact UTC grouping of the supplied transactions, not proof of market coverage.
SELECT date_utc, sum(units) AS units, sum(sales_cents)/100.0 AS sales_usd
FROM observed_daily_sales
WHERE source='licensed-provider'
GROUP BY date_utc ORDER BY date_utc;

-- Pokemon singles volume across products/sets; multi-Pokemon totals are nonadditive.
SELECT pokemon_key, min(pokemon) AS pokemon, sum(units) AS units
FROM observed_daily_pokemon_sales
WHERE source='licensed-provider' AND date_utc BETWEEN '2026-10-01' AND '2026-10-31'
GROUP BY pokemon_key ORDER BY units DESC;

-- HP-bearing products whose species names did not match the taxonomy.
SELECT product_id, name, set_name FROM catalog_products
WHERE is_current=1 AND cast(hp AS INTEGER)>0 AND json_array_length(pokemon)=0;

-- Native daily reported quantities, with explicit per-date product coverage.
-- These are source date labels, not fabricated UTC transaction timestamps.
SELECT date_source, sum(quantity) AS units,
       sum(transaction_count) AS transactions,
       count(DISTINCT product_id) AS products_with_history
FROM reported_volume GROUP BY date_source ORDER BY date_source;

-- All saved native singles, grouped across products and SKUs by Pokemon.
SELECT lower(j.value) AS pokemon, sum(v.quantity) AS units
FROM reported_volume v, json_each(v.pokemon) j
WHERE v.kind='single'
GROUP BY lower(j.value) ORDER BY units DESC;

-- Sweep coverage, including missing and failed histories.
SELECT * FROM volume_runs ORDER BY date_utc DESC LIMIT 1;
SELECT status, count(*) AS products FROM volume_jobs
WHERE date_utc=(SELECT max(date_utc) FROM volume_runs) GROUP BY status;
```

Useful tables: `catalog_products`, `catalog_downloads`, `catalog_runs`,
`pokemon_species`, `bulk_sales`, `daily_volume`, `volume_runs`, `volume_jobs`;
the older `products`, `sales` and `collections`
retain diagnostic sample history.

## Data accuracy and coverage

- **Not marketplace-wide totals.** Legacy browser records cover only sampled
  products; imported feeds remain unverified until their actual coverage is
  established. Initial snapshots cannot establish earlier historical volume.
- **Observed units** sum transaction quantities. **Observed sales dollars** sum
  quantity times the reported purchase price, interpreted as unit price in USD,
  excluding shipping and taxes. Sale records are not unique customer orders.
- Transaction days are grouped by the timestamp in **UTC**. A timestamp without
  a timezone is rejected rather than silently assigning it to a day.
- Native daily history keeps the source's date labels and reports the unknown
  timezone explicitly. Zero bucket counts are retained, but failed/empty
  histories do not create zero-sales records.
- Website default filters can limit the returned conditions, variants, and
  languages. The collector clears filters when that control is available and
  records the scope. Completeness remains unverified even if every exposed page
  is collected.
- Three-day or weekly buckets are **not** imported as daily sales. Overlapping
  provider archives cannot be summed to infer exact daily transactions.
- The legacy browser feed supplies no verified stable sale identifier. Content-based
  deduplication retains the maximum observed multiplicity of identical records
  across snapshots, but cannot distinguish all coincident identical sales.
- Rankings use catalog name-based tags or manual overrides, case-insensitively.
  Unmapped singles are excluded. Multi-Pokemon singles contribute their units to
  each tag; these rankings are not additive.
- Exports contain **every matching saved transaction or daily SKU bucket**, not just the rows displayed.
  They honor the dashboard date/type filters. The daily CSV contains observed
  days only; omitted dates are unknown, not verified zero-sales days.
- Buyer/seller/account details are neither collected nor stored.

### Live-access verification, October 31, 2026

Bulk catalog sync processed all **681 published groups**, including six empty
groups, and persisted **63,765 products**: 33,024 Pokemon and 30,741 Pokemon Japan.
Per-category source row counts matched SQLite exactly. The local dashboard
passed browser checks for pagination, filtered/full catalog exports, per-Pokemon
daily exports and disabled sampling, without making any remote product-page requests.
A separate temporary database tested bulk transactions for every catalog product;
its synthetic records were never written to the production database.

TCGplayer product metadata was accessible. Headless browser tests encountered
sales-service failures, and a separate chart request returned **HTTP 403**.
An ordinary **visible Chromium window successfully loaded real transaction
responses**, including timezone-aware timestamps, quantities and purchase prices.
The per-product transaction collector remains an optional diagnostic, separate
from the one-context daily-volume API job.

A later plain browser-context API request successfully returned native
`range=month` history, including 30 one-day buckets per SKU. Singles and the
151 Poster Collection returned quantities; sampled Japanese and trainer
products returned empty histories, not verified zero sales. No signed-request
replay or product-by-product navigation was required.

The first **100-product** live batch saved **15,000 daily SKU buckets** for
October 2-31, 2026: **34,827 reported units** and **23,218 reported transactions**.
These are that batch's source-reported counts, **not marketplace totals**.
Its full SKU CSV contained every 15,000 bucket rows; the Pokemon daily CSV had
2,070 species/date rows. The local UI showed unavailable revenue correctly,
30 daily bars, no JavaScript errors and no remote requests. All original 15
sample transactions were preserved, and no synthetic records entered production.

An isolated scale test on November 1, 2026 used **4,953,600 synthetic buckets**
across 33,024 products, five SKUs and 30 days. Product/day rollups reduced the
dashboard metrics query from 10,150 ms to **1,571 ms**, preserving exact totals,
zero-day product coverage and complete raw buckets. The temporary database was
removed; these synthetic counts are not sales observations.

The anonymous page exposed only **five recent sales** and displayed
**Sign In to View More Sales**. These are useful observed records, not complete
daily product totals. The collector respects that limit and records a partial
coverage warning. It does not log in, store account credentials, or bypass
the sign-in requirement. A graphical desktop session is needed for visible mode.

Automated browser fixtures test pagination, preview replacement, and denied
access. Real collection is additionally tested separately; fixture data is not
seeded into the production database.

Optional diagnostics (not the bulk sales solution) require Chromium:

```sh
npx playwright install chromium
npm run seed
ENABLE_BROWSER_SAMPLING=1 npm run collect
```

Setting `ENABLE_BROWSER_SAMPLING=1` when starting the server also explicitly
reenables its diagnostic daily scheduler. Leave it unset for warehouse operation.

## Manual import fallback

When direct collection is unavailable, add a product and import a JSON file via
**Collection health → Import observed sales manually**. Use observed transaction
data you already have from TCGplayer. Maximum upload: 5 MB / 10,000 rows.

This example is **synthetic format documentation**, not a real sale:

```json
{
  "product_id": 42382,
  "sales": [
    {
      "orderDate": "2026-10-31T12:00:00Z",
      "quantity": 2,
      "purchasePrice": 10.25,
      "shippingPrice": 0.99,
      "condition": "Near Mint",
      "variant": "Holofoil",
      "language": "English"
    }
  ]
}
```

`purchasePrice` is a USD **unit price**. Imported records follow the same
deduplication rules and carry an unverified-coverage warning. Re-importing the
same full snapshot does not add duplicate records.

## Validation

```sh
npm run check
npm test
```

Tests cover UTC attribution, quantity/revenue aggregation, singles/sealed and
species ranking, duplicate multiplicity, persistence, atomic rejection of
invalid imports, stable-ID bulk imports, source isolation, resumable all-category
catalog sync, source-count reconciliation, species matching, paginated catalog
queries, complete CSV exports, gap warnings, daily scheduling across
the 2026/2027 boundary, browser pagination, and access-failure handling.
Tests also cover native one-day validation, count corrections, failed/empty
history separation, queue resume, source isolation, unavailable revenue, and
streamed exports beyond dashboard ranking limits, plus existing-database rollup
migration and subsequent corrections, complete compressed publishing, and
stale-publication rejection, public-only checkpoint isolation, and remote
bootstrap retry/denied-access handling, productive transient recovery within
the request budget, and the published volume figure's partial price coverage.

## Overview figure

`daily-trading.csv` joins the complete native daily quantity and sale-value
reports by source date. It preserves units, reported transactions, product/SKU
coverage, priced/unpriced units, priced-subset bounds and any established
all-unit bounds or exact dollars. Missing prices remain blank or explicitly
unavailable, never invented zero-dollar revenue. The figure displays the seven
most recent observed dates as a table, including an incomplete current day.
Bought and sold are opposite sides of the same matched trade, not additive
quantities. Sealed units count products, not their enclosed cards.

`npm run figures` regenerates `reports/latest/volume.svg` directly from the
committed daily unit/value CSVs and coverage JSON. The remote publisher runs
the same renderer for every exported snapshot and publishes the SVG alongside
the complete datasets. It does not fetch another source or estimate prices.

Unit bars sum source-reported quantities. The green band uses the daily
`priced_sales_lower_usd` and `priced_sales_upper_usd` subtotals, never a midpoint
or market-price proxy. Days without usable sale prices are gaps. Header totals
cover the entire retained date range, not a single day; the price-coverage
denominator is observed units, not catalog products. The figure also reports
the latest sweep's status and checked/expected product counts.

The server binds only to localhost. Keep `data/` private; it contains the SQLite
database. API and storefront changes may require updating the collector.