const TITLE_STOP_WORDS = new Set(["with", "and", "for", "the", "only", "brand", "new", "used", "set"]);

export function buildDuplicateIndex(listings = []) {
  const buckets = new Map();
  for (const listing of listings || []) {
    for (const key of duplicateKeys(listing)) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(listing);
    }
  }

  const byListingId = new Map();
  for (const [key, items] of buckets.entries()) {
    const unique = uniqueListings(items).sort((a, b) => listingTime(b) - listingTime(a));
    if (unique.length < 2) continue;
    unique.forEach((listing, index) => {
      const id = listingIdentity(listing);
      const current = byListingId.get(id);
      if (current && current.count >= unique.length) return;
      byListingId.set(id, {
        key,
        count: unique.length,
        role: index === 0 ? "primary" : "secondary",
        listingIds: unique.map((item) => item.id).filter(Boolean)
      });
    });
  }

  return { byListingId, buckets };
}

export function duplicateInfoForListing(listing, duplicateIndex = null) {
  const computed = duplicateIndex?.byListingId?.get(listingIdentity(listing));
  const explicitCount = Number(listing.duplicate_count || 1);
  if (computed || explicitCount > 1) {
    return {
      key: computed?.key || listing.duplicate_group_id || duplicateKeys(listing)[0] || listingIdentity(listing),
      count: Math.max(computed?.count || 1, explicitCount),
      role: listing.duplicate_role || computed?.role || "primary",
      listingIds: computed?.listingIds || []
    };
  }
  return {
    key: duplicateKeys(listing)[0] || listingIdentity(listing),
    count: 1,
    role: "primary",
    listingIds: []
  };
}

export function duplicateKeys(listing) {
  const title = normalizeTitle(listing.title);
  const seller = normalizeSeller(listing.seller_name || listing.seller_id);
  const price = normalizePrice(listing.current_price);
  const keys = [];

  if (listing.duplicate_group_id && !String(listing.duplicate_group_id).startsWith("single-")) keys.push(`group:${listing.duplicate_group_id}`);
  if (title && seller && price) keys.push(`title-seller-price:${title}:${seller}:${price}`);

  for (const hash of imageHashes(listing)) {
    if (hash && seller) keys.push(`image-seller:${hash}:${seller}`);
    if (hash && title) keys.push(`image-title:${hash}:${title}`);
  }

  return [...new Set(keys)];
}

export function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1 && !TITLE_STOP_WORDS.has(token))
    .slice(0, 8)
    .join("-");
}

function normalizeSeller(value) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function normalizePrice(value) {
  const price = Number(value || 0);
  if (!Number.isFinite(price) || price <= 0) return "";
  return String(Math.round(price));
}

function imageHashes(listing) {
  return [
    listing.image_hash,
    listing.imageHash,
    listing.perceptual_hash,
    listing.perceptualHash,
    ...(Array.isArray(listing.image_hashes) ? listing.image_hashes : []),
    ...(Array.isArray(listing.imageHashes) ? listing.imageHashes : [])
  ]
    .map((hash) => String(hash || "").trim().toLowerCase())
    .filter(Boolean);
}

function uniqueListings(items) {
  const seen = new Set();
  return items.filter((listing) => {
    const key = listingIdentity(listing);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function listingIdentity(listing) {
  return String(listing.id || listing.carousell_id || listing.carousell_url || listing.url || `${listing.title}-${listing.seller_name}-${listing.current_price}`);
}

function listingTime(listing) {
  return new Date(listing.scraped_at || listing.listed_at || listing.details_scraped_at || 0).getTime() || 0;
}
