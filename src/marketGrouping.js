export const DEFAULT_CATEGORY_MEDIANS = {
  "graphics card": 280,
  processor: 120,
  motherboard: 110,
  memory: 55,
  storage: 65,
  "power supply": 75,
  "pc case": 85,
  "pc cooling": 35,
  "computers & tech": 90,
  keyboard: 70,
  monitor: 130,
  laptop: 420,
  phone: 500,
  general: 100
};

export function variantMarketKeys(listing = {}) {
  const category = normalizeKey(listing.category || "general");
  const variations = variationMap(listing.variations);
  const keys = [];

  if (variations.gpu_model) keys.push(`${category}:gpu:${normalizeKey(variations.gpu_model)}`);
  if (variations.cpu_model) keys.push(`${category}:cpu:${normalizeKey(variations.cpu_model)}`);
  if (variations.phone_storage && /phone|iphone|mobile/i.test(`${listing.title || ""} ${listing.category || ""}`)) {
    keys.push(`${category}:phone-storage:${normalizeKey(variations.phone_storage)}`);
  }
  if (variations.case_size && category.includes("pc-case")) keys.push(`${category}:size:${normalizeKey(variations.case_size)}`);
  if (variations.ram && /memory|ram/i.test(`${listing.title || ""} ${listing.category || ""}`)) keys.push(`${category}:ram:${normalizeKey(variations.ram)}`);
  if (variations.storage && /storage|ssd|nvme|hdd/i.test(`${listing.title || ""} ${listing.category || ""}`)) keys.push(`${category}:storage:${normalizeKey(variations.storage)}`);
  if (variations.fan_size && /cooling|fan/i.test(`${listing.title || ""} ${listing.category || ""}`)) keys.push(`${category}:fan:${normalizeKey(variations.fan_size)}:${normalizeKey(variations.fan_orientation || "normal")}`);

  if (isAccessoryOrPanel(listing)) keys.push(`${category}:accessory:${firstStrongToken(listing.title)}`);
  if (!keys.length) keys.push(`${category}:title:${titleSignature(listing.title)}`);
  keys.push(category);
  return [...new Set(keys.filter(Boolean))];
}

export function computeVariantMarketInsights(listings = []) {
  const buckets = new Map();
  for (const listing of listings) {
    const price = Number(listing.current_price || 0);
    if (price <= 1 || price > 100000) continue;
    for (const key of variantMarketKeys(listing)) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(price);
    }
  }

  const insights = new Map();
  for (const listing of listings) {
    const prices = uniquePrices(variantMarketKeys(listing).flatMap((key) => buckets.get(key) || []));
    const median = medianPrice(prices);
    const price = Number(listing.current_price || 0);
    if (!median || prices.length < 3 || price <= 1) {
      insights.set(Number(listing.id), unknownMarketInsight(listing));
      continue;
    }
    const delta = Math.round(((price - median) / median) * 100);
    let rating = "fair";
    if (delta <= -55) rating = "suspicious_low";
    else if (delta <= -20) rating = "great";
    else if (delta >= 35) rating = "overpriced";
    insights.set(Number(listing.id), {
      rating,
      median_price: median,
      sample_size: prices.length,
      price_delta_percent: delta,
      market_keys: variantMarketKeys(listing)
    });
  }
  return insights;
}

export function applyDefaultCategoryMedians(config = {}) {
  return {
    ...config,
    categoryMedians: {
      ...DEFAULT_CATEGORY_MEDIANS,
      ...(config.categoryMedians || {})
    }
  };
}

function variationMap(variations = []) {
  const output = {};
  if (!Array.isArray(variations)) return output;
  for (const item of variations) {
    if (!item?.name || !item?.value) continue;
    output[item.name] = item.value;
  }
  return output;
}

function isAccessoryOrPanel(listing = {}) {
  return /\b(?:panel|riser|bracket|mount|cable|adapter|screws?|stand|tray|cover|dust filter|mesh kit|extension|upgrade kit|only)\b/i.test(`${listing.title || ""} ${listing.description || ""}`);
}

function titleSignature(title = "") {
  return normalizeKey(String(title || "").split(/\s+/).filter((token) => token.length > 2).slice(0, 4).join("-"));
}

function firstStrongToken(title = "") {
  return normalizeKey(String(title || "").split(/\s+/).find((token) => token.length > 3) || "item");
}

function normalizeKey(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function uniquePrices(prices) {
  return [...new Set(prices.map((price) => Number(price || 0)).filter((price) => price > 1 && price < 100000))];
}

function medianPrice(prices) {
  if (!prices.length) return 0;
  const sorted = [...prices].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function unknownMarketInsight(listing = {}) {
  return {
    rating: "unknown",
    median_price: DEFAULT_CATEGORY_MEDIANS[listing.category] || DEFAULT_CATEGORY_MEDIANS.general,
    sample_size: 0,
    price_delta_percent: null,
    market_keys: variantMarketKeys(listing)
  };
}
