import { buildDuplicateGroups } from "../src/server.js";
import { applyScopedDuplicateInfo, duplicateGroupHistogram } from "../src/duplicateGroups.js";
import { getState, closeDatabase } from "../src/store.js";

const state = await getState();
const listings = state.listings || [];
const legacy = applyMapToListings(listings, buildDuplicateGroups(listings));
const scoped = applyScopedDuplicateInfo(listings);

printReport("LEGACY buildDuplicateGroups(state listings)", legacy);
printReport("SCOPED duplicate grouping", scoped);
closeDatabase();

function applyMapToListings(listings, groups) {
  return listings.map((listing) => ({
    ...listing,
    ...(groups.get(Number(listing.id)) || { duplicate_group_id: `single-${listing.id}`, duplicate_count: 1, duplicate_role: "primary" })
  }));
}

function printReport(title, listings) {
  const groups = groupBy(listings, (listing) => listing.duplicate_group_id || `single-${listing.id}`);
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log(`\n=== ${title} ===`);
  console.log(`total listings: ${listings.length}`);
  console.log(`distinct duplicate_group_id values: ${groups.size}`);
  console.log(`group size histogram: ${JSON.stringify(duplicateGroupHistogram(listings))}`);
  console.log("\nTop 3 largest groups:");
  for (const [groupId, items] of sorted.slice(0, 3)) {
    console.log(`\n${groupId} size=${items.length}`);
    for (const item of items) {
      console.log(`- #${item.id} ${item.title}`);
      const images = item.original_image_urls || item.image_urls || [];
      if (!images.length) console.log("  image_urls: []");
      for (const image of images) console.log(`  ${image}`);
    }
  }
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}
