import { hydrateCarousellListings, searchCarousell } from "./carousellSearch.js";
import { enrichListingData, parseStartUrls } from "./listingDataQuality.js";
import { bulkUpsertListings, readJson } from "./store.js";

export async function searchAndStoreStartUrls(body = {}, options = {}) {
  const parsed = parseStartUrls(body.startUrls || body.start_urls || body.start_url || body.url || "");
  const queryFallback = String(body.query || "").trim();
  if (!parsed.items.length && !queryFallback) throw new Error("query or startUrls are required");

  const existingListings = await readJson("listings");
  const existingByCarousellId = new Map(existingListings.map((listing, index) => [listing.carousell_id, { listing, index }]));
  const nextListings = [...existingListings];
  const results = [];
  let added = 0;
  let updated = 0;
  let nextId = Math.max(0, ...nextListings.map((item) => Number(item.id || 0))) + 1;
  const sources = [];

  const items = parsed.items.length ? parsed.items : [{ kind: "query", query: queryFallback, url: "" }];

  for (const item of items) {
    if (item.kind === "listing_url") {
      const listing = await listingFromUrl(item.url, item.query);
      const stored = upsertScrapedListing(listing);
      results.push(stored);
      continue;
    }

    const query = item.query || queryFallback;
    if (!query) continue;
    const search = await searchCarousell(query, {
      ...options,
      limit: options.limit || "all",
      anchorLimit: options.anchorLimit || 240,
      hydrateDetails: options.hydrateDetails ?? false
    });
    sources.push(search.url || item.url || query);
    for (const rawListing of search.results || []) {
      const stored = upsertScrapedListing(rawListing);
      results.push(stored);
    }
  }

  if (added || updated) bulkUpsertListings(nextListings);

  return {
    source: "carousell-starturls",
    url: sources[0] || parsed.primary?.url || null,
    start_url_mode: parsed.mode,
    parsed,
    added,
    updated,
    results
  };

  function upsertScrapedListing(rawListing) {
    const listing = enrichListingData(rawListing);
    const existing = existingByCarousellId.get(listing.carousell_id);
    if (existing) {
      const merged = enrichListingData(mergeListingDetails(existing.listing, listing));
      nextListings[existing.index] = merged;
      existingByCarousellId.set(merged.carousell_id, { listing: merged, index: existing.index });
      updated += 1;
      return merged;
    }
    const created = enrichListingData({ id: nextId, ...listing });
    nextListings.push(created);
    existingByCarousellId.set(created.carousell_id, { listing: created, index: nextListings.length - 1 });
    nextId += 1;
    added += 1;
    return created;
  }
}

async function listingFromUrl(url, fallbackTitle = "") {
  const id = String(url || "").match(/\/p\/[^/]+-(\d+)/)?.[1] || stableId(url);
  const title = cleanListingSlug(fallbackTitle || String(url || "").split("/p/")[1] || "Carousell listing");
  const [hydrated] = await hydrateCarousellListings([
    {
      carousell_id: `web-${id}`,
      title,
      description: "",
      category: "general",
      condition: "unknown",
      seller_id: `web-seller-${stableId(url)}`,
      seller_name: "Carousell seller",
      seller_rating: 0,
      location: "",
      current_price: 0,
      image_urls: [],
      carousell_url: url,
      scraped_at: new Date().toISOString()
    }
  ], { concurrency: 1 });
  return enrichListingData(hydrated || {
    carousell_id: `web-${id}`,
    title,
    current_price: 0,
    carousell_url: url,
    image_urls: [],
    scraped_at: new Date().toISOString()
  });
}

function mergeListingDetails(existing, incoming) {
  const imageUrls = [...new Set([...(incoming.image_urls || []), ...(existing.image_urls || [])])];
  return {
    ...existing,
    ...incoming,
    id: existing.id,
    seller_rating: Number(incoming.seller_rating || existing.seller_rating || 0),
    description: incoming.description || existing.description || "",
    location: incoming.location || existing.location || "",
    image_urls: imageUrls,
    scraped_at: incoming.scraped_at || new Date().toISOString()
  };
}

function cleanListingSlug(value) {
  return decodeURIComponent(String(value || ""))
    .replace(/-\d+.*$/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Carousell listing";
}

function stableId(value) {
  let hash = 0;
  for (const char of String(value || "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}
