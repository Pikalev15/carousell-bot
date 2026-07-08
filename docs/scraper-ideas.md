# Scraper Ideas Feature Branch

Branch: `feature/scraper-ideas`

This branch is for testing useful ideas from two reference Carousell scraping repos without touching `main`.

## Reference repos

### `albertleng/CarousellWebScraper`

Ideas worth borrowing:

- Carousell URL-level filters: condition, location, range, min price, max price, sort order
- CSV export mindset
- raw scrape/debug artifacts
- seller profile/rating hydration idea

Ideas not worth copying directly:

- hardcoded `chromedriver.exe`
- old notebook-only workflow
- fragile BeautifulSoup div-chain parsing
- hardcoded baby-chair assumptions

### `lexis-solutions-data-services/carousell-scraper`

Ideas worth borrowing:

- `startUrls` input style
- clean product schema
- dataset/export formats
- categories, certified status, free-shipping status
- primary image and images fields
- product variations
- API-client style workflow

Ideas not worth copying directly:

- cloud dependency for the local app
- proxy / fingerprinting direction
- generic marketing-focused structure

## Phase 1 currently implemented

This branch currently adds a browser-side **Scraper Ideas Lab** to the Search page through `public/notification-detail.js`.

It supports:

- Pasting a Carousell search/category/listing URL
- Parsing a search query from the pasted URL
- Importing URL filters into the existing search UI
- Building/copying a Carousell URL with:
  - condition
  - price range
  - location
  - distance/range
  - sort order
- Exporting:
  - all listings as CSV
  - deals as CSV
  - alerts as JSON
  - price history as CSV
- CSV columns include planned richer schema placeholders:
  - categories
  - primary image
  - certified/free-shipping fields
  - variations
  - data completeness score

## Important limitation

The current implementation is intentionally low-risk. It uses existing API routes and existing search behavior.

That means pasted category/listing URLs are converted into a query-based search instead of being sent to a new backend `startUrls` scraper pipeline. This is enough for testing UX, exports, and schema direction before deeper backend changes.

## Phase 2 backend work

Next backend changes should add:

- true `startUrls` support in `/api/search`
- URL-aware scraper input in `searchCarousell`
- URL-level filters applied before scraping, not only after scraping
- `/api/export/listings.csv`
- `/api/export/deals.csv`
- `/api/export/alerts.json`
- `/api/export/price-history.csv`
- optional debug artifacts under `data/debug/`
- seller profile hydration
- seller rating/review count extraction
- product variation extraction
- product-variant-aware scoring

## Test steps

```bash
git fetch origin
git checkout feature/scraper-ideas
npm install
npm start
```

Open:

```text
http://localhost:3000
```

Then:

1. Go to the Search page.
2. Find the **Scraper Ideas Lab** panel above the normal search form.
3. Paste a Carousell URL.
4. Check that the normal search fields fill in.
5. Click **Run parsed URL**.
6. Try the export buttons.

## Merge rule

Do not merge this branch until:

- exports download correctly
- URL parsing works for search/category/listing URLs
- no existing notification/detail modal behavior breaks
- backend `startUrls` support is either implemented or clearly deferred
