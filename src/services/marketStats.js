const DEFAULT_CATEGORY = "electronics";

export function buildMarketStats(listings = [], config = {}) {
  const buckets = new Map();
  for (const listing of listings || []) {
    const price = Number(listing.current_price || 0);
    if (price <= 1 || price >= 100000) continue;
    const category = normalizeCategory(listing.category);
    if (!buckets.has(category)) buckets.set(category, []);
    buckets.get(category).push(price);
  }

  const medians = {};
  const samples = {};
  for (const [category, prices] of buckets.entries()) {
    const sorted = [...new Set(prices)].sort((a, b) => a - b);
    medians[category] = median(sorted);
    samples[category] = sorted.length;
  }

  return {
    medians: {
      ...(config.categoryMedians || {}),
      ...medians
    },
    samples
  };
}

export function marketContextForListing(listing, marketStats = {}, config = {}) {
  const category = normalizeCategory(listing.category);
  const median = Number(
    listing.market_median ||
      listing.market_insight?.median_price ||
      marketStats.medians?.[category] ||
      config.categoryMedians?.[category] ||
      config.categoryMedians?.[DEFAULT_CATEGORY] ||
      0
  );
  const price = Number(listing.current_price || 0);
  return {
    category,
    median,
    sampleSize: Number(listing.market_insight?.sample_size || marketStats.samples?.[category] || 0),
    priceDeltaPercent: median > 0 && price > 0 ? Math.round(((price - median) / median) * 100) : null,
    priceRatio: median > 0 && price > 0 ? price / median : null
  };
}

export function median(values = []) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function normalizeCategory(value) {
  return String(value || DEFAULT_CATEGORY).trim().toLowerCase() || DEFAULT_CATEGORY;
}
