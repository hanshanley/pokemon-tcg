# Sales sources and access

[Overview](../README.md) · [Methodology](methodology.md)

General assessment updated **November 3, 2026**; the
[PriceCharting assessment](#pricecharting-targeted-assessment) was rechecked on
**November 18, 2026**. A price history or market-cap series is
not sales volume. Counts need an explicit unit (cards, sale records or lots);
dollars need actual paid prices, quantities, currency and fee treatment.
Different marketplaces and overlapping providers must remain separate.

## Connected sources

**TCGplayer native daily history** supplies quantities, transaction counts and
low/high actual sale prices per SKU/day. The job requests monthly one-day
buckets through ordinary storefront access. The catalog-wide queue remains
partial when collection fails; unpriced units cannot establish exact dollars.

**TCGplayer public individual sales** supplies real transaction rows for the
four retained products. The public window is five rows, not a complete feed.
The automatic archive preserves older observations but cannot recover unseen
intervening transactions.

**TCGCSV and PokeAPI** provide product/species metadata, not transaction volume.

## Alternative transaction feeds

| Source | Relevant data | Access and limitations |
| --- | --- | --- |
| [CompSniper](https://compsniper.com/docs/tcgplayer) | TCGplayer product IDs, transaction prices, quantities, shipping and timestamps. | Key required; at most 250 recent rows per product. Date filters apply after that cap. No authenticated response verified; retention/public-export rights must be established. |
| [The Card API](https://www.thecardapi.com/docs) | Cross-market individual records; cursor pagination and `indexed_after` for bulk incremental sync. Public TCGplayer search was verified on November 1. | Public results omit quantities and price-confirmation/currency fields. [Terms](https://www.thecardapi.com/terms) prohibit free-tier persistence and standalone raw redistribution without an agreement. No playground archive was created. |
| [TCG API](https://tcgapi.dev/use-cases/ebay-sold-prices/) | eBay sold listings with dates, prices, grade/condition and original listing links through `include=ebay_sales`. Bulk prices cover up to 500 cards per request. | API key required for transactions. Bulk summaries are rolling 30-day medians/counts, not daily dollars; do not multiply a median by the count. Quantities and exact timestamps need live validation. |
| [Hobby Card Index](https://hobbycardindex.com/developers) | Recent sold sales across eBay and other platforms; date, price, grade and listing links. | Paid authenticated API. Its bulk files are price files, not a demonstrated bulk transaction feed. Commercial display/public archives require appropriate rights; no key connected. |
| [TCGAPIs](https://tcgapis.com/tcgplayer-api) | Recent individual TCGplayer sales. | Business+ access; roughly 100 recent records. `/full` is a three-day SKU-bucket archive, not individual transactions or exact daily totals. |
| [SoldComps](https://sold-comps.com/docs) | TCGplayer individual sales by product and public filters. | Its own docs explicitly cap the endpoint at five recent rows on every plan. This does not solve the public-window problem. |
| [PriceCharting](https://www.pricecharting.com/game/pokemon-base-set/charizard-4) | Dated sold-listing comparisons by marketplace/grade, current valuations and yearly volume. | Displayed rows lack explicit quantities and intraday timestamps. The Prices API/CSV do not supply historical sales. See the [targeted assessment](#pricecharting-targeted-assessment) for mapping, coverage and publication limits. |

The documented no-key [TCG API coverage endpoint](https://api.tcgapi.dev/v1/ebay/coverage)
was live-verified on November 3: it reported eBay coverage for 25,005 English
and 23,734 Japanese Pokemon cards, with newest reads dated November 3. Those
are **covered-card counts, not sales counts**. Only coverage metadata was
retrieved; authenticated transaction access is not connected.

### Public auction dataset

[Chase Society's Fanatics payment tracker](https://chasesociety.com/data/fanatics-record-watch)
publishes a downloadable CSV of Pokemon auction lots of $40,000 and up, with
payment/erasure flags and observation history. The page identifies 1,385 lots
as of November 2, 2026; prices include a 20% buyer's premium.

This is a genuine alternative dataset, but it is a high-value auction subset,
not TCGplayer or all Pokemon sales. An auction close is not necessarily a
settled transaction: the page documents unpaid, erased and cancelled lots,
including conflicting payment/page states. Lot counts must not be relabeled
as quantities of individual cards.

The direct public Fanatics item endpoint returned HTTP 403 during this check;
the CSV download returned HTTP 429. Requests stopped, without retries or
bypasses. No auction rows were imported or mirrored. The download and source
page remain useful leads, not a connected live feed.

## PriceCharting targeted assessment

Reviewed **November 18, 2026**, using the
[requested Charizard page](https://www.pricecharting.com/game/pokemon-base-set/charizard-4)
and official documentation/changelogs. No PriceCharting collector, subscription
or public data mirror has been enabled.

### How their prices are produced

Their [methodology](https://www.pricecharting.com/page/methodology) describes
combining completed sales into valuations using recency, averages, medians and
outlier handling. They classify listings by their descriptions, remove unsuitable
records automatically, and accept user flags for manual review. This describes
filtered comparable sales; it does not establish coverage of every transaction.

They [added TCGplayer sales on December 8, 2025](https://blog.pricecharting.com/2025/12/tcgplayer-sales-data-has-been-added.html).
The eBay/TCGplayer display filter does not change the blended valuation.
Their [November 19, 2025 update](https://blog.pricecharting.com/2025/11/best-offer-prices-shown.html)
says accepted offers and crossed-out asking prices are displayed separately;
an adapter must distinguish them rather than extract an arbitrary dollar value.
The reviewed page also contains Fanatics-labelled records.
The exact upstream acquisition interfaces are not established by these sources.

### What the example actually establishes

The page maps **PriceCharting 630417** to **TCGplayer 42382**, giving a verified
starting join to our catalog. Its initial view labels 60 ungraded sold listings
and 30 in each of several graded tabs. Rows expose a sale date, title, source
and price, with eBay listing links where present. These counts describe the
displayed snapshot, not demonstrated complete historical pagination.
TCGplayer rows link to a product, not an individual order.

The displayed table does not supply explicit unit quantities or intraday sale
times. Raw and graded records must stay distinct; a broad displayed grade
bucket must not be treated as an exact grading-company/grade identity.
The page identifies its price chart as month-end valuations. Neither that
chart nor labels such as sales per week establish actual daily units or dollars.

### Supported downloads versus daily sales

The [Prices API documentation](https://www.pricecharting.com/api-documentation)
limits the price API/CSV to current valuations, not historical prices or sales.
`sales-volume` means yearly units, not daily transactions.
`tcg-id` can support additional catalog joins. The downloadable guide refreshes
daily; a daily file refresh does not turn its yearly counter into daily volume.
Counter differences and valuation multiplied by volume are not realized sales.

An [older retailer announcement](https://blog.pricecharting.com/2021/10/pricecharting-has-premium-features-for.html)
describes historical volume charts combining conditions. Their current daily
granularity, export availability and completeness were not verified.
The Marketplace API's own offers are also distinct from an external
eBay/TCGplayer sales-history feed.

The API documentation permits caching while subscribed but specifies internal
use, subscription-end deletion and written commercial permission for sharing.
Their [current terms](https://www.pricecharting.com/page/terms-of-service)
separately allow attributed price references, but require express permission
for third-party-accessible software. An attributed citation is not evidence
that our full CSV/SQLite redistribution is authorized.

### Integration path

Request a dated sales export/feed and explicit retention/publication terms,
including grade coverage, source identifiers, quantities, accepted-offer
semantics, corrections and pagination limits. Confirm whether the historical
volume feature can supply genuine daily counts rather than assuming it can.
Do not purchase the standard price subscription as a substitute for that feed.

If access is established, start with the verified Charizard mapping and store
comparables separately: provider, underlying marketplace, listing identity,
source sale date, capture time, grade, currency, reported amount and nullable
quantity. Deduplicate carefully: a listing ID is not necessarily a transaction
ID. Unknown quantities stay unknown, and listing counts stay separate from
units sold. Map validated products to existing set/Pokemon dimensions, then
expand only after testing backfill, corrections and full-source coverage.

The useful incremental target is eBay/graded-card coverage. PriceCharting's
TCGplayer observations must not be added to our overlapping native aggregates;
keep every marketplace/provider series separate until overlap can be resolved.
An authorized partial comp archive could still be useful, but would need its
own coverage flags rather than an all-sales claim.

## Aggregate-only alternatives

[TCGCharts](https://tcgcharts.com/developers) documents daily prices/counts and
30-day dollar volume, but explicitly excludes individual sales from its API.
It requires licensed access; it cannot replace the requested transaction archive.

[PkmnPrices](https://www.pkmnprices.com/docs/price-history) documents daily eBay
comp counts, priced-comp counts and medians. These exclude TCGplayer/Cardmarket;
accepted Best Offers are excluded from priced counts because the paid amount is
not disclosed. A median is not a realized daily dollar total.

[CardIndex's weekly market report](https://www.cardindex.co/blog/weekly-market-report)
publishes daily count/dollar aggregates, but not a verified complete individual
bulk feed. Its figures must not be merged into TCGplayer totals.

## Connection requirements

No subscription was purchased and no paid alternative is enabled. Before
connecting one, validate an authenticated live response, product identifiers,
price/quantity semantics, date precision, delayed updates, history limits,
stable-ID or multiplicity deduplication, and the request budget. Confirm
persistence and public CSV/SQLite redistribution rights separately from
permission to display derived charts.

Missing quantities, unknown accepted offers, unconfirmed payments and truncated
windows must stay explicit; they cannot be silently converted into exact revenue.
