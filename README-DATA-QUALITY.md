# Data Quality and Backend Export Notes

The data-quality layer sits between raw Carousell scrape results and deal scoring/export.

## Added modules

- `src/listingDataQuality.js`
  - parses Carousell search/category/listing start URLs
  - builds filtered Carousell search URLs
  - cleans product image URLs
  - removes profile/avatar/logo/placeholder images
  - infers PC-focused categories
  - extracts product variations such as GPU model, CPU model, RAM, storage, case size, fan size, fan orientation, PSU wattage, and phone storage
  - calculates data completeness
  - flattens enriched listings for CSV export

- `src/server-plus.js`
  - default backend runtime used by `npm start`, `npm run dev`, and `npm run start:plus`
  - wraps the core server with export endpoints and startUrl support
  - keeps the old core server available as `npm run start:core`

- `src/startUrlSearch.js`
  - handles Carousell search/category/listing start URLs before handing results back to the normal store/scoring flow

## Scripts

```bash
npm start
npm run dev
npm run start:plus
npm run start:core
npm run clean:images
npm run enrich:data
npm run medians:default
npm run export:data
npm test
```

`npm start`, `npm run dev`, and `npm run start:plus` all run the full default runtime: `src/server-plus.js`.

`npm run start:core` runs `src/server.js` directly and is mainly a debugging escape hatch.

## Backend routes

Run:

```bash
npm start
```

Then use:

```text
/api/export/listings.csv
/api/export/deals.csv
/api/export/alerts.json
/api/export/price-history.csv
/api/start-urls/parse?url=<encoded carousell url>
```

## Recommended local test flow

```bash
git fetch origin
git checkout main
git pull
npm install
npm test
npm run clean:images
npm run enrich:data
npm run medians:default
npm run export:data
npm start
```

Then search again and compare the generated files in:

```text
data/exports/
```

## Data notes

- `data/config.example.json` is the committed safe template.
- `data/config.json`, `data/search-history.json`, `data/labels.json`, exports, cache files, and database files are local runtime state and should not be committed.
- `data/listings.json` is intentional mock/demo seed data in this repo, not real scraped data.

## Important note

The export/startUrl wrapper is no longer optional. It is the normal default runtime. Use `npm run start:core` only when debugging the older core server path.
