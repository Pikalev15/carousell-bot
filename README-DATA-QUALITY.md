# Data Quality and Backend Export Notes

This branch adds the data-quality layer that should sit between raw Carousell scrape results and deal scoring/export.

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
  - optional backend wrapper around the existing server
  - adds export endpoints without changing the default server path
  - adds startUrl parsing/proxy support for `/api/search`

## New scripts

```bash
npm run clean:images
npm run enrich:data
npm run export:data
npm run start:plus
```

## Optional backend routes

Run:

```bash
npm run start:plus
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
git checkout fix/listing-data-quality
git pull
npm install
npm test
npm run clean:images
npm run enrich:data
npm run export:data
npm run start:plus
```

Then search again and compare the generated files in:

```text
data/exports/
```

## Important note

`npm start` still runs the original app server so scheduler/Telegram behavior is not accidentally changed. Use `npm run start:plus` when you want the optional backend export/startUrl wrapper.
