import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAlerts, getPriceHistory, getState } from "../src/store.js";
import { buildListings } from "../src/server.js";
import { flattenListingForExport, toCsv } from "../src/listingDataQuality.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(__dirname, "..", "data", "exports");
await mkdir(outputDir, { recursive: true });

const state = await getState();
const listings = buildListings(state, "", { includeFiltered: true }).map(flattenListingForExport);
const deals = buildListings(state, "", { includeFiltered: false })
  .filter((listing) => !listing.classification?.is_filtered)
  .filter((listing) => listing.score?.is_deal)
  .map(flattenListingForExport);
const alerts = getAlerts({ limit: 1000 });
const priceHistory = [];

for (const listing of buildListings(state, "", { includeFiltered: true })) {
  for (const item of getPriceHistory(listing.id)) {
    priceHistory.push({
      listing_id: listing.id,
      title: listing.title,
      price: item.price,
      recorded_at: item.recorded_at,
      carousell_url: listing.carousell_url
    });
  }
}

await writeFile(path.join(outputDir, "listings.csv"), `${toCsv(listings)}\n`);
await writeFile(path.join(outputDir, "deals.csv"), `${toCsv(deals)}\n`);
await writeFile(path.join(outputDir, "alerts.json"), `${JSON.stringify({ alerts }, null, 2)}\n`);
await writeFile(path.join(outputDir, "price-history.csv"), `${toCsv(priceHistory, ["listing_id", "title", "price", "recorded_at", "carousell_url"])}\n`);

console.log(`Exported ${listings.length} listings, ${deals.length} deals, ${alerts.length} alerts, ${priceHistory.length} price-history rows to ${outputDir}`);
