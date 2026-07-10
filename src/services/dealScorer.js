import { buildDuplicateIndex, duplicateInfoForListing } from "./duplicateDetector.js";
import { buildMarketStats, marketContextForListing } from "./marketStats.js";
import { scoreListingRisk } from "./riskScorer.js";

const DEFAULT_MAX_PER_SEARCH = 5;
const DEFAULT_MIN_FINAL_SCORE = 50;
const DEFAULT_RECENT_HOURS = 24;
const PLACEHOLDER_PRICES = new Set([0, 1, 8, 12, 88, 111, 123, 888, 8888, 9999, 12345, 99999]);
const STOP_WORDS = new Set(["and", "for", "the", "with", "new", "used", "buy", "sell", "search"]);

export function buildTopDealsBySearch({ listings = [], searches = [], filters = [], config = {}, now = new Date(), options = {} } = {}) {
  const recentListings = listings.filter((listing) => isRecentListing(listing, now, options.recentHours || DEFAULT_RECENT_HOURS));
  const enabledSearches = searches.filter((search) => search?.active !== false);
  const maxPerSearch = Number(options.maxPerSearch || DEFAULT_MAX_PER_SEARCH);
  const minScore = Number(options.minScore || config.digest?.minScore || DEFAULT_MIN_FINAL_SCORE);
  const marketStats = buildMarketStats(listings, config);
  const duplicateIndex = buildDuplicateIndex(listings);

  return enabledSearches
    .map((search) => {
      const scored = recentListings
        .filter((listing) => matchesSearch(listing, search))
        .map((listing) => scoreListingForSearch(listing, search, { filters, config, now, marketStats, duplicateIndex }))
        .filter((deal) => deal.finalScore >= minScore);
      return {
        search,
        deals: dedupeScoredDeals(scored)
          .sort((a, b) => b.finalScore - a.finalScore || b.dealScore - a.dealScore || listingTime(b.listing) - listingTime(a.listing))
          .slice(0, maxPerSearch)
      };
    })
    .filter((section) => section.deals.length > 0);
}

export function scoreListingForSearch(listing, search, { filters = [], config = {}, now = new Date(), marketStats = null, duplicateIndex = null } = {}) {
  const market = marketContextForListing(listing, marketStats || buildMarketStats([listing], config), config);
  const duplicate = duplicateInfoForListing(listing, duplicateIndex);
  const price = priceDealScore(listing, search, market);
  const keyword = keywordScore(listing, search);
  const freshness = freshnessScore(getScrapedAgeHours(listing, now));
  const seller = sellerTrustScore(listing);
  const duplicateDeal = duplicateDealScore(duplicate);
  const completeness = completenessScore(listing);

  const dealScore = clampScore(
    price.score * 0.42 +
      keyword.score * 0.22 +
      freshness.score * 0.12 +
      seller.score * 0.08 +
      duplicateDeal.score * 0.08 +
      completeness.score * 0.08
  );
  const risk = scoreListingRisk(listing, { market, duplicate, filters, now });
  const finalScore = clampScore(dealScore - risk.riskScore);
  const dealReasons = [
    ...price.reasons,
    ...keyword.reasons,
    ...freshness.reasons,
    ...seller.reasons,
    ...duplicateDeal.reasons,
    ...completeness.reasons
  ].filter(Boolean);

  return {
    listing,
    search,
    dealScore,
    riskScore: risk.riskScore,
    finalScore,
    score: finalScore,
    riskLevel: risk.riskLevel,
    dealReasons,
    riskReasons: risk.riskReasons,
    reasons: [...dealReasons.slice(0, 4), ...risk.riskReasons.slice(0, 3)],
    components: {
      price: Math.round(price.score),
      keyword: Math.round(keyword.score),
      freshness: Math.round(freshness.score),
      seller: Math.round(seller.score),
      duplicate: Math.round(duplicateDeal.score),
      completeness: Math.round(completeness.score),
      risk: risk.riskScore
    },
    market,
    duplicate,
    price: Number(listing.current_price || 0)
  };
}

export function isRecentListing(listing, now = new Date(), hours = DEFAULT_RECENT_HOURS) {
  return getScrapedAgeHours(listing, now) <= Number(hours || DEFAULT_RECENT_HOURS);
}

function priceDealScore(listing, search, market) {
  const price = Number(listing.current_price || 0);
  if (PLACEHOLDER_PRICES.has(price) || price <= 0) return { score: 0, reasons: ["Placeholder or missing price"] };

  const ceiling = Number(search?.price_ceiling || 0);
  if (ceiling > 0) {
    if (price > ceiling) return { score: 18, reasons: [`Above watched-search ceiling S$${ceiling.toLocaleString("en-SG")}`] };
    const ratio = price / ceiling;
    return {
      score: clampScore(96 - ratio * 26),
      reasons: [`Within watched-search ceiling: S$${price.toLocaleString("en-SG")} of S$${ceiling.toLocaleString("en-SG")}`]
    };
  }

  if (!market.median || !market.priceRatio) return { score: 52, reasons: ["No market median available"] };
  const below = market.priceDeltaPercent < 0 ? `${Math.abs(market.priceDeltaPercent)}% below market median` : "";
  if (market.priceRatio <= 0.45) return { score: 96, reasons: [below || "Far below market median"] };
  if (market.priceRatio <= 0.65) return { score: 88, reasons: [below || "Below market median"] };
  if (market.priceRatio <= 0.82) return { score: 76, reasons: [below || "Slightly below market median"] };
  if (market.priceRatio <= 1) return { score: 62, reasons: [below || "Near market median"] };
  if (market.priceRatio <= 1.2) return { score: 42, reasons: [`${market.priceDeltaPercent}% above market median`] };
  return { score: 20, reasons: [`${market.priceDeltaPercent}% above market median`] };
}

function keywordScore(listing, search) {
  const tokens = searchTokens(search);
  if (tokens.length === 0) return { score: 55, reasons: ["No search keywords configured"] };
  const text = listingText(listing);
  const query = String(search?.query || "").trim().toLowerCase();
  const exactQuery = query && text.includes(query);
  const hits = tokens.filter((token) => text.includes(token));
  const ratio = hits.length / tokens.length;

  if (exactQuery) return { score: 100, reasons: ["Exact keyword match"] };
  if (hits.length === tokens.length) return { score: 88, reasons: ["Matched all search keywords"] };
  if (hits.length > 0) return { score: clampScore(36 + ratio * 44), reasons: [`Matched keywords: ${hits.slice(0, 4).join(", ")}`] };
  return { score: 12, reasons: ["Weak keyword match"] };
}

function freshnessScore(ageHours) {
  if (ageHours <= 2) return { score: 100, reasons: ["Scraped in the last 2 hours"] };
  if (ageHours <= 6) return { score: 90, reasons: ["Scraped today"] };
  if (ageHours <= 12) return { score: 78, reasons: ["Scraped today"] };
  if (ageHours <= 24) return { score: 62, reasons: ["Scraped in the last 24 hours"] };
  return { score: 0, reasons: ["Older than digest window"] };
}

function sellerTrustScore(listing) {
  const rating = Number(listing.seller_rating || 0);
  const reviewCount = firstNumber(listing.seller_review_count, listing.review_count, listing.seller_reviews, listing.reviews_count, listing.feedback_count);
  const reasons = [];
  let score = 52;

  if (rating >= 4.8) {
    score = 95;
    reasons.push("Highly rated seller");
  } else if (rating >= 4.3) {
    score = 80;
    reasons.push("Good seller rating");
  } else if (rating > 0 && rating < 4) {
    score = 32;
    reasons.push("Seller rating is weak");
  } else {
    reasons.push("Seller trust unknown");
  }

  if (reviewCount !== null && reviewCount >= 10) {
    score = Math.min(100, score + 8);
    reasons.push("Seller has review history");
  } else if (reviewCount !== null && reviewCount <= 2) {
    score = Math.max(20, score - 12);
  }

  return { score, reasons };
}

function duplicateDealScore(duplicate) {
  if (duplicate.count <= 1) return { score: 100, reasons: [] };
  if (duplicate.role === "secondary") return { score: 34, reasons: ["Duplicate/repost penalty"] };
  return { score: 72, reasons: ["Similar listings detected"] };
}

function completenessScore(listing) {
  let score = 25;
  const reasons = [];
  const descriptionLength = String(listing.description || "").replace(/\s+/g, " ").trim().length;

  if (descriptionLength >= 160) {
    score += 28;
    reasons.push("Detailed description");
  } else if (descriptionLength >= 45) {
    score += 18;
    reasons.push("Usable description");
  }
  if (hasListingImages(listing)) {
    score += 24;
    reasons.push("Has listing images");
  }
  if (listing.location) score += 12;
  if (listing.seller_url || listing.seller_name) score += 11;
  return { score: clampScore(score), reasons };
}

function matchesSearch(listing, search) {
  const tokens = searchTokens(search);
  if (tokens.length === 0) return true;
  const text = listingText(listing);
  return tokens.some((token) => text.includes(token));
}

function searchTokens(search) {
  const values = Array.isArray(search?.terms) && search.terms.length ? search.terms : [search?.query, search?.category];
  return [
    ...new Set(
      values
        .flatMap((value) => String(value || "").toLowerCase().split(/[^a-z0-9]+/))
        .map((token) => token.trim())
        .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
    )
  ];
}

function dedupeScoredDeals(deals) {
  const best = new Map();
  for (const deal of deals) {
    const key = deal.duplicate?.key || deal.listing.carousell_id || deal.listing.id;
    const current = best.get(key);
    if (!current || deal.finalScore > current.finalScore) best.set(key, deal);
  }
  return [...best.values()];
}

function getScrapedAgeHours(listing, now) {
  const timestamp = listing.scraped_at || listing.details_scraped_at || listing.listed_at;
  if (!timestamp) return 9999;
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return 9999;
  return Math.max(0, (new Date(now).getTime() - time) / 3600000);
}

function listingTime(listing) {
  return new Date(listing.scraped_at || listing.listed_at || listing.details_scraped_at || 0).getTime() || 0;
}

function listingText(listing) {
  return `${listing.title || ""} ${listing.description || ""} ${listing.category || ""} ${listing.condition || ""}`.toLowerCase();
}

function hasListingImages(listing) {
  return [
    ...(Array.isArray(listing.image_urls) ? listing.image_urls : []),
    ...(Array.isArray(listing.original_image_urls) ? listing.original_image_urls : []),
    listing.primary_image,
    listing.thumbnail_url
  ].some(Boolean);
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}
