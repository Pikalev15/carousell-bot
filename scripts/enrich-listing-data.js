import { readJson, writeJson } from "../src/store.js";
import { enrichListingData } from "../src/listingDataQuality.js";
import { analyzeListingRelevance, inferPreciseCategory } from "../src/relevanceClassifier.js";

const listings = await readJson("listings");
let changed = 0;

const enriched = listings.map((listing) => {
  const base = enrichListingData(listing);
  const category = inferPreciseCategory(base, base.category);
  const relevance = analyzeListingRelevance({ ...base, category }, base.query || "");
  const next = {
    ...base,
    category,
    relevance_score: relevance.score,
    relevance_type: relevance.type,
    relevance_flags: relevance.flags,
    relevance_reasons: relevance.reasons,
    relevance_analysis: relevance,
    quality_flags: [...new Set([...(base.quality_flags || []), ...relevance.flags])]
  };
  if (JSON.stringify(next.image_urls) !== JSON.stringify(listing.image_urls || [])
    || next.category !== listing.category
    || JSON.stringify(next.variations || []) !== JSON.stringify(listing.variations || [])
    || next.data_completeness?.label !== listing.data_completeness?.label
    || next.relevance_score !== listing.relevance_score
    || JSON.stringify(next.relevance_flags || []) !== JSON.stringify(listing.relevance_flags || [])) {
    changed += 1;
  }
  return next;
});

await writeJson("listings", enriched);
console.log(`Enriched ${enriched.length} listings. Changed ${changed}.`);
