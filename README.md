# Pokemon TCGplayer sales warehouse

**The goal is all Pokemon products, not a watchlist.** This application now
downloads the published Pokemon and Pokemon Japan catalogs in set-level batches,
stores them in SQLite, supports streaming bulk transaction imports, and computes
daily volume and Pokemon rankings in SQL. No product pages are opened during
catalog sync, transaction import, or reporting.

**Complete marketplace sales ingestion is still blocked by data access.**
The bulk catalog contains metadata, not completed sales. Its product count
must not be mistaken for transaction coverage. The existing 15 real browser
sample records are retained separately; they do not establish daily market totals.
Automatic browser collection is disabled.

## Architecture and remaining data requirement

`bulk catalog -> product/species dimensions -> bulk transaction feed -> SQLite GROUP BY -> dashboard/CSV`

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
- Sales: a complete feed must provide product ID, a stable per-transaction ID,
  timezone-aware sale timestamp, units, unit price, and product type, with explicit
  coverage of conditions, languages, variants, history and delayed records.
  A source adapter/data agreement is needed before claiming marketplace totals.
  No such feed is connected, and no paid subscription has been purchased.
- TCGplayer public search and TCGCSV prices are not transaction counts. The
  provider TCGAPIs documents its "full" archive as overlapping three-day buckets,
  not exact daily transaction data. SQL cannot recover missing transactions or
  uniquely reconstruct daily totals from those buckets.

## Run

Requires Node.js 22.13+.

```sh
npm install
npm run catalog
npm start
```

Open `http://127.0.0.1:3000`. **Bulk product catalog** searches the local database
and displays 100 products per page. Its CSV includes every matching product,
not just that page. The dashboard separately reports catalog products,
products with saved sales, species-mapping gaps and the unconnected complete feed.

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
source with the latest newly inserted transaction, or you can explicitly choose
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
```

Useful tables: `catalog_products`, `catalog_downloads`, `catalog_runs`,
`pokemon_species`, `bulk_sales`; the older `products`, `sales` and `collections`
retain diagnostic sample history.

## Data accuracy and coverage

- **Not marketplace-wide totals.** Legacy browser records cover only sampled
  products; imported feeds remain unverified until their actual coverage is
  established. Initial snapshots cannot establish earlier historical volume.
- **Observed units** sum transaction quantities. **Observed sales dollars** sum
  quantity times the reported purchase price, interpreted as unit price in USD,
  excluding shipping and taxes. Sale records are not unique customer orders.
- Days are grouped by the transaction timestamp in **UTC**. A timestamp without
  a timezone is rejected rather than silently assigning it to a day.
- Website default filters can limit the returned conditions, variants, and
  languages. The collector clears filters when that control is available and
  records the scope. Completeness remains unverified even if every exposed page
  is collected.
- Three-day rolling sales-chart buckets are **not** imported as daily sales.
  They overlap and cannot be summed to infer exact daily transactions.
- The legacy browser feed supplies no verified stable sale identifier. Content-based
  deduplication retains the maximum observed multiplicity of identical records
  across snapshots, but cannot distinguish all coincident identical sales.
- Rankings use catalog name-based tags or manual overrides, case-insensitively.
  Unmapped singles are excluded. Multi-Pokemon singles contribute their units to
  each tag; these rankings are not additive.
- Exports contain **every matching saved sale**, not just the rows displayed.
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
That mode is retained only for optional diagnostics, not catalog-wide ingestion.

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

The server binds only to localhost. Keep `data/` private; it contains the SQLite
database. API and storefront changes may require updating the collector.