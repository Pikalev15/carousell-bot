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

## Currently implemented

This branch adds an **Advanced / Category Search** lab to the Search page via `public/scraper-lab.js`.

It supports:

- Pasting one or more Carousell URLs, one per line
- Detecting search URLs, category URLs, listing URLs, and mixed URL batches
- Category URL parsing that strips Carousell numeric category IDs, for example:
  - `/categories/mobile-phones-gadgets-215/mobile-phones-5707` -> `mobile phones`
  - `/categories/computers-tech-213/computer-parts-1821` -> `computer parts`
- Importing parsed filters into the normal search UI
- Building/copying/opening a Carousell search URL with:
  - condition
  - price range
  - location
  - distance/range
  - sort order
- Running the current backend search with the cleaned category/query term
- Sending `startUrls` and `search_options` in the request body so the backend can support true URL scraping later without changing the UI again
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

The current implementation is intentionally low-risk. It uses existing API routes and existing query-search behavior.

That means category/listing URLs are parsed into clean search terms instead of being scraped as first-class backend `startUrls` yet. The UI already sends `startUrls` and `search_options`, so the backend can be upgraded later without changing the front-end flow.

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
2. Find the **Advanced / Category Search** panel above the normal search form.
3. Paste a category URL such as `https://www.carousell.sg/categories/mobile-phones-gadgets-215/mobile-phones-5707`.
4. Confirm the query becomes `mobile phones`.
5. Click **Run advanced search**.
6. Try the export buttons.

## Merge rule

Do not merge this branch until:

- exports download correctly
- category/search/listing URL parsing works for your test URLs
- no existing notification/detail modal behavior breaks
- backend `startUrls` support is either implemented or clearly deferred
