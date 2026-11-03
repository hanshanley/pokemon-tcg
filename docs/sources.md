# Sales sources and access

[Overview](../README.md) · [Methodology](methodology.md)

Assessment updated **November 3, 2026**. A price history or market-cap series is
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
| [PriceCharting](https://www.pricecharting.com/game/pokemon-base-set/charizard-4) | Public eBay/TCGplayer completed sales with dates and prices. | Quantities/exact times are absent. Official API/CSV are current values, not transaction history. [Redistribution terms](https://www.pricecharting.com/page/terms-of-service) require review before building a public archive. |

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
