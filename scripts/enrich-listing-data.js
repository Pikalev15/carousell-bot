import { readJson, writeJson } from "../src/store.js";
import { enrichListingData } from "../src/listingDataQuality.js";

const listings = await readJson("listings");
let changed = 0;

const enriched = listings.map((listing) => {
  const next = enrichListingData(listing);
  if (JSON.stringify(next.image_urls) !== JSON.stringify(listing.image_urls || [])
    || next.category !== listing.category
    || JSON.stringify(next.variations || []) !== JSON.stringify(listing.variations || [])
    || next.data_completeness?.label !== listing.data_completeness?.label) {
    changed += 1;
  }
  return next;
});

await writeJson("listings", enriched);
console.log(`Enriched ${enriched.length} listings. Changed ${changed}.`);
