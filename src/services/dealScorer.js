const DEFAULT_MAX_PER_SEARCH = 5;
const DEFAULT_MIN_SCORE = 58;
const DEFAULT_RECENT_HOURS = 24;
const PLACEHOLDER_PRICES = new Set([0, 1, 8, 88, 888, 8888, 9999, 12345, 99999]);
const STOP_WORDS = new Set(["and", "for", "the", "with", "new", "used", "buy", "sell", "search"]);
const BUILT_IN_BAD_KEYWORDS = [
  "wtb",
  "want to buy",
  "looking for",
  "looking to buy",
  "deposit",
  "installment",
  "not selling",
  "rental"
];

export function buildTopDealsBySearch({ listings = [], searches = [], filters = [], config = {}, now = new Date(), options = {} } = {}) {
  const recentListings = listings.filter((listing) => isRecentListing(listing, now, options.recentHours || DEFAULT_RECENT_HOURS));
  const enabledSearches = searches.filter((search) => search?.active !== false);
  const maxPerSearch = Number(options.maxPerSearch || DEFAULT_MAX_PER_SEARCH);
  const minScore = Number(options.minScore || config.digest?.minScore || DEFAULT_MIN_SCORE);

  return enabledSearches
    .map((search) => {
      const scored = recentListings
        .filter((listing) => matchesSearch(listing, search))
        .map((listing) => scoreListingForSearch(listing, search, { filters, config, now }))
        .filter((deal) => deal.score >= minScore);
      return {
        search,
        deals: dedupeScoredDeals(scored)
          .sort((a, b) => b.score - a.score || listingTime(b.listing) - listingTime(a.listing))
          .slice(0, maxPerSearch)
      };
    })
    .filter((section) => section.deals.length > 0);
}

export function scoreListingForSearch(listing, search, { filters = [], config = {}, now = new Date() } = {}) {
  const price = Number(listing.current_price || 0);
  const ageHours = getScrapedAgeHours(listing, now);
  const keyword = keywordScore(listing, search);
  const priceResult = priceScore(listing, search, config);
  const freshness = freshnessScore(ageHours);
  const duplicatePenalty = duplicatePenaltyScore(listing);
  const badKeyword = badKeywordPenalty(listing, filters);
  const score = clampScore(Math.round(priceResult.score * 0.42 + keyword.score * 0.26 + freshness * 0.22 - duplicatePenalty - badKeyword.penalty));

  return {
    listing,
    search,
    score,
    components: {
      price: Math.round(priceResult.score),
      keyword: Math.round(keyword.score),
      freshness: Math.round(freshness),
      duplicate_penalty: Math.round(duplicatePenalty),
      bad_keyword_penalty: Math.round(badKeyword.penalty)
    },
    reasons: [
      ...priceResult.reasons,
      ...keyword.reasons,
      ageHours <= 24 ? `Fresh: ${formatAge(ageHours)}` : "",
      duplicatePenalty ? "Duplicate/secondary listing penalty" : "",
      ...badKeyword.reasons
    ].filter(Boolean),
    price
  };
}

export function isRecentListing(listing, now = new Date(), hours = DEFAULT_RECENT_HOURS) {
  return getScrapedAgeHours(listing, now) <= Number(hours || DEFAULT_RECENT_HOURS);
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

function keywordScore(listing, search) {
  const tokens = searchTokens(search);
  if (tokens.length === 0) return { score: 55, reasons: ["No search keywords configured"] };
  const text = listingText(listing);
  const hits = tokens.filter((token) => text.includes(token));
  const query = String(search?.query || "").trim().toLowerCase();
  const exactQuery = query && text.includes(query);
  const score = Math.min(100, (hits.length / tokens.length) * 70 + (exactQuery ? 30 : 0));
  return {
    score,
    reasons: hits.length ? [`Matched keywords: ${hits.slice(0, 4).join(", ")}`] : []
  };
}

function priceScore(listing, search, config) {
  const price = Number(listing.current_price || 0);
  if (PLACEHOLDER_PRICES.has(price) || price <= 0) return { score: 5, reasons: ["Placeholder or missing price"] };

  const ceiling = Number(search?.price_ceiling || 0);
  if (ceiling > 0) {
    if (price > ceiling) return { score: 18, reasons: [`Above watched-search ceiling S$${ceiling.toLocaleString()}`] };
    const ratio = price / ceiling;
    return {
      score: clampScore(100 - ratio * 35),
      reasons: [`Within ceiling: S$${price.toLocaleString()} of S$${ceiling.toLocaleString()}`]
    };
  }

  const median = Number(listing.market_median || config.categoryMedians?.[listing.category] || config.categoryMedians?.electronics || 0);
  if (median <= 0) return { score: 50, reasons: ["No category median available"] };
  const ratio = price / median;
  if (ratio <= 0.45) return { score: 96, reasons: [`Far below median (${Math.round(ratio * 100)}%)`] };
  if (ratio <= 0.65) return { score: 86, reasons: [`Below median (${Math.round(ratio * 100)}%)`] };
  if (ratio <= 0.85) return { score: 72, reasons: [`Slightly below median (${Math.round(ratio * 100)}%)`] };
  if (ratio <= 1) return { score: 58, reasons: [`Near median (${Math.round(ratio * 100)}%)`] };
  return { score: 30, reasons: [`Above median (${Math.round(ratio * 100)}%)`] };
}

function freshnessScore(ageHours) {
  if (ageHours <= 2) return 100;
  if (ageHours <= 6) return 88;
  if (ageHours <= 12) return 74;
  if (ageHours <= 24) return 56;
  return 0;
}

function duplicatePenaltyScore(listing) {
  if (listing.duplicate_role && listing.duplicate_role !== "primary") return 18;
  return Number(listing.duplicate_count || 1) > 1 ? 6 : 0;
}

function badKeywordPenalty(listing, filters) {
  const text = listingText(listing);
  const configured = filters
    .filter((filter) => ["blacklist", "spam_keyword", "bad_pricer"].includes(String(filter.type || "")))
    .map((filter) => String(filter.phrase || "").trim().toLowerCase())
    .filter(Boolean);
  const matches = [...BUILT_IN_BAD_KEYWORDS, ...configured].filter((phrase) => text.includes(phrase));
  return {
    penalty: Math.min(40, matches.length * 12),
    reasons: matches.map((phrase) => `Penalty keyword: ${phrase}`).slice(0, 3)
  };
}

function dedupeScoredDeals(deals) {
  const best = new Map();
  for (const deal of deals) {
    const key = duplicateKey(deal.listing);
    const current = best.get(key);
    if (!current || deal.score > current.score) best.set(key, deal);
  }
  return [...best.values()];
}

function duplicateKey(listing) {
  if (listing.duplicate_group_id && !String(listing.duplicate_group_id).startsWith("single-")) return `group:${listing.duplicate_group_id}`;
  if (listing.carousell_id) return `carousell:${listing.carousell_id}`;
  const title = normalizeText(listing.title).split(" ").slice(0, 7).join("-");
  const seller = normalizeText(listing.seller_id || listing.seller_name || "unknown");
  const priceBand = Math.round(Number(listing.current_price || 0) / 25) * 25;
  return `${seller}:${title}:${priceBand}`;
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

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function formatAge(hours) {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 24) return `${Math.round(hours)} hr`;
  return `${Math.round(hours / 24)} days`;
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}
