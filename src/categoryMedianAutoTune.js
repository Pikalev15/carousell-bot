export function computeRollingCategoryMedians(listings = [], config = {}, now = Date.now()) {
  const settings = config.categoryMedianAutoTune || {};
  const days = Math.max(1, Number(settings.days || 30));
  const minSampleSize = Math.max(1, Number(settings.minSampleSize || 3));
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const buckets = new Map();

  for (const listing of listings || []) {
    const category = String(listing.category || "electronics").trim() || "electronics";
    const price = Number(listing.current_price || 0);
    if (price <= 1 || price >= 100000) continue;
    const timestamp = listingTimestamp(listing, now);
    if (timestamp && timestamp < cutoff) continue;
    if (!buckets.has(category)) buckets.set(category, []);
    buckets.get(category).push(price);
  }

  const medians = {};
  const samples = {};
  for (const [category, prices] of buckets.entries()) {
    prices.sort((a, b) => a - b);
    samples[category] = prices.length;
    if (prices.length >= minSampleSize) medians[category] = median(prices);
  }
  return { medians, samples, days, minSampleSize };
}

export function applyRollingCategoryMedians(listings = [], config = {}, scoreDeal = null) {
  const settings = config.categoryMedianAutoTune || {};
  if (settings.enabled === false) return listings || [];
  const { medians, samples } = computeRollingCategoryMedians(listings, config);
  return (listings || []).map((listing) => {
    const category = listing.category || "electronics";
    const fallback = Number(config.categoryMedians?.[category] || config.categoryMedians?.electronics || listing.market_median || 0);
    const tuned = Number(medians[category] || fallback || 0);
    const sampleSize = Number(samples[category] || 0);
    const price = Number(listing.current_price || 0);
    const marketInsight = tuned > 0 && price > 0
      ? {
          ...(listing.market_insight || {}),
          median_price: tuned,
          sample_size: sampleSize,
          price_delta_percent: Math.round(((price - tuned) / tuned) * 100),
          rating: price <= tuned * 0.8 ? "great" : price >= tuned * 1.35 ? "overpriced" : "fair"
        }
      : listing.market_insight;
    const next = { ...listing, market_median: tuned || listing.market_median, market_insight: marketInsight };
    if (typeof scoreDeal === "function" && !next.classification?.is_filtered) {
      const score = scoreDeal(next, config);
      next.score = {
        ...score,
        training_preference: next.training?.preference_score ?? score.preference_score,
        market_adjustment: listing.score?.market_adjustment || 0,
        explanation: listing.score?.explanation || score.explanation
      };
    }
    return next;
  });
}

function listingTimestamp(listing, now) {
  const value = listing.listed_at || listing.scraped_at || listing.updated_at || listing.created_at || "";
  const parsed = value ? new Date(value).getTime() : 0;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  if (listing.days_listed !== null && listing.days_listed !== undefined) return now - Number(listing.days_listed || 0) * 24 * 60 * 60 * 1000;
  return now;
}

function median(prices) {
  if (!prices.length) return 0;
  return prices[Math.floor(prices.length / 2)];
}
