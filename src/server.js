import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyListing, scoreDeal } from "./filterEngine.js";
import { extractLocation, hydrateCarousellListings, refreshCarousellListingDetails, searchCarousell } from "./carousellSearch.js";
import { lookupMsrpFromGoogle } from "./msrpSearch.js";
import { getCachedImage, proxiedImageUrl } from "./imageCache.js";
import { maskTelegramConfig, notifyAlert, parseTelegramCommand, sendTelegramTestMessage, startTelegramCommandPolling, updateTelegramConfig } from "./notifier.js";
import { SearchScheduler } from "./scheduler.js";
import {
  addActivity,
  bulkUpsertListings,
  deleteWatchedSearch,
  getActivity,
  getAlerts,
  getPriceHistory,
  getState,
  getWatchedSearch,
  getWatchedSearches,
  markAlertsRead,
  readJson,
  updateWatchedSearchRun,
  upsertListing,
  upsertWatchedSearch,
  writeJson
} from "./store.js";
import { labelPolarity, predictPreference, trainModel } from "./trainingModel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");
const port = Number(process.env.PORT || 3000);
const scheduler = new SearchScheduler(runWatchedSearch);
const searchJobs = new Map();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    await serveStatic(url.pathname, response);
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  server.listen(port, () => {
    console.log(`Carousell Bot running at http://localhost:${port}`);
  });
  scheduler.start().catch((error) => console.warn(`Scheduler failed to start: ${error.message}`));
  startTelegramCommandPolling(handleTelegramCommand).catch((error) => console.warn(`Telegram command polling failed: ${error.message}`));
}

export { server, buildListings, buildDuplicateGroups, buildMarketInsights, handleTelegramCommand, runWatchedSearch, shouldSuppressAlert };

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/images") {
    const config = await readJson("config");
    const image = await getCachedImage(url.searchParams.get("url"), config.imageCache);
    response.writeHead(200, {
      "content-type": image.contentType,
      "cache-control": "public, max-age=86400",
      "x-image-source": image.source
    });
    response.end(image.body);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/listings") {
    const state = await getState();
    const listings = buildListings(state, url.searchParams.get("q"), {
      minPrice: url.searchParams.get("min_price"),
      maxPrice: url.searchParams.get("max_price"),
      maxAgeHours: url.searchParams.get("max_age_hours"),
      location: url.searchParams.get("location"),
      includeFiltered: url.searchParams.get("include_filtered") === "true"
    });
    sendJson(response, 200, listings);
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/listings/")) {
    if (url.pathname.endsWith("/price-history")) {
      const id = Number(url.pathname.split("/")[3]);
      sendJson(response, 200, getPriceHistory(id));
      return;
    }
    const id = Number(url.pathname.split("/").pop());
    const state = await getState();
    const listing = buildListings(state, "", { includeFiltered: true }).find((item) => item.id === id);
    if (!listing) {
      sendJson(response, 404, { error: "Listing not found" });
      return;
    }
    sendJson(response, 200, listing);
    return;
  }

  if (request.method === "POST" && url.pathname.match(/^\/api\/listings\/\d+\/refresh-details$/)) {
    const id = Number(url.pathname.split("/")[3]);
    const listings = await readJson("listings");
    const index = listings.findIndex((item) => Number(item.id) === id);
    if (index < 0) {
      sendJson(response, 404, { error: "Listing not found" });
      return;
    }

    const refreshed = await refreshCarousellListingDetails(listings[index]);
    listings[index] = {
      ...listings[index],
      ...refreshed
    };
    upsertListing(listings[index]);

    const state = await getState();
    const listing = buildListings(state, "", { includeFiltered: true }).find((item) => item.id === id);
    sendJson(response, 200, listing);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/deals") {
    const state = await getState();
    const deals = buildListings(state)
      .filter((listing) => !listing.classification.is_filtered)
      .filter((listing) => listing.score.is_deal);
    sendJson(response, 200, deals);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/search") {
    const body = await readBody(request);
    const query = String(body.query || "").trim();
    const mode = body.mode === "more" ? "more" : body.mode === "local" ? "local" : "web";
    if (!query) {
      sendJson(response, 400, { error: "query is required" });
      return;
    }

    await recordSearch(query, mode);
    const webSearch = mode !== "local" ? await searchAndStoreWebResults(query, mode, { alert: true }) : null;

    const state = await getState();
    sendJson(response, 200, {
      query,
      mode,
      source: webSearch?.source || "local",
      source_url: webSearch?.url || null,
      added: webSearch?.added || 0,
      updated: webSearch?.updated || 0,
      hydration_job: webSearch?.job || null,
      warning: webSearch?.warning || null,
      results: buildListings(state, query, {
        minPrice: body.min_price ?? 1,
        maxPrice: body.max_price,
        maxAgeHours: body.max_age_hours,
        location: body.location,
        includeFiltered: Boolean(body.include_filtered)
      }),
      history: await readJson("searches")
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/search/history") {
    sendJson(response, 200, await readJson("searches"));
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/search/jobs/")) {
    const id = url.pathname.split("/").pop();
    sendJson(response, searchJobs.has(id) ? 200 : 404, searchJobs.get(id) || { error: "Search job not found" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/activity") {
    sendJson(response, 200, getActivity(80));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/alerts") {
    sendJson(response, 200, {
      unread: getAlerts({ unreadOnly: true, limit: 200 }).length,
      alerts: getAlerts({ limit: 80 })
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/alerts/mark-read") {
    sendJson(response, 200, markAlertsRead());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/filters/blacklist") {
    sendJson(response, 200, await readJson("filters"));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/filters/blacklist") {
    const body = await readBody(request);
    const filters = await readJson("filters");
    const nextId = Math.max(0, ...filters.map((filter) => filter.id)) + 1;
    const next = {
      id: nextId,
      type: body.type || "blacklist",
      phrase: String(body.phrase || "").trim(),
      reason: String(body.reason || "User preference").trim()
    };
    if (!next.phrase) {
      sendJson(response, 400, { error: "phrase is required" });
      return;
    }
    filters.push(next);
    await writeJson("filters", filters);
    sendJson(response, 201, next);
    return;
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/api/filters/blacklist/")) {
    const id = Number(url.pathname.split("/").pop());
    const filters = await readJson("filters");
    const next = filters.filter((filter) => filter.id !== id);
    await writeJson("filters", next);
    sendJson(response, 200, { removed: filters.length - next.length });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/sellers/blacklist") {
    sendJson(response, 200, await readJson("sellers"));
    return;
  }

  if (request.method === "GET" && url.pathname.match(/^\/api\/sellers\/[^/]+\/reputation$/)) {
    const sellerId = decodeURIComponent(url.pathname.split("/")[3]);
    const state = await getState();
    sendJson(response, 200, sellerReputation(sellerId, state.trainingModel));
    return;
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/sellers/blacklist/")) {
    const sellerId = decodeURIComponent(url.pathname.split("/").pop());
    const body = await readBody(request);
    const sellers = await readJson("sellers");
    if (!sellers.some((seller) => seller.seller_id === sellerId)) {
      sellers.push({
        seller_id: sellerId,
        seller_name: body.seller_name || sellerId,
        reason: body.reason || "User preference",
        blocked_at: new Date().toISOString()
      });
      await writeJson("sellers", sellers);
    }
    sendJson(response, 201, { seller_id: sellerId });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/feedback/label") {
    const body = await readBody(request);
    const listingId = Number(body.listing_id);
    const rating = String(body.rating || "");
    if (!listingId || !["good", "skip", "bought", "spam", "not_spam", "bad_pricer", "bad_deal", "unmarked"].includes(rating)) {
      sendJson(response, 400, { error: "listing_id and valid rating are required" });
      return;
    }
    sendJson(response, 200, await saveListingLabel(listingId, rating, body));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/feedback/labels") {
    sendJson(response, 200, await readJson("labels"));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/training/model") {
    sendJson(response, 200, await readJson("trainingModel"));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/training/retrain") {
    sendJson(response, 200, await retrainPreferenceModel());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/msrp/lookup") {
    const body = await readBody(request);
    const title = String(body.title || "listing");
    const price = Number(body.price || 0);
    const estimate = await lookupMsrpFromGoogle(title).catch((error) => ({
      msrp: 0,
      source: "Google search unavailable",
      evidence: error.message,
      currency: "SGD"
    }));
    sendJson(response, 200, {
      title,
      msrp: estimate.msrp,
      discount_percent: estimate.msrp ? Math.round(((estimate.msrp - price) / estimate.msrp) * 100) : 0,
      source: estimate.source,
      evidence: estimate.evidence,
      currency: estimate.currency
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/watchlist") {
    sendJson(response, 200, await getWatchedSearches());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/watchlist") {
    const body = await readBody(request);
    const preset = await categoryPreset(body.query || body.category);
    sendJson(response, 201, upsertWatchedSearch(preset ? { ...body, query: preset.label, category: "category monitor", kind: "category", terms: preset.terms } : body));
    return;
  }

  if (request.method === "PATCH" && url.pathname.startsWith("/api/watchlist/")) {
    const id = Number(url.pathname.split("/").pop());
    const existing = getWatchedSearch(id);
    if (!existing) {
      sendJson(response, 404, { error: "Watched search not found" });
      return;
    }
    sendJson(response, 200, upsertWatchedSearch({ ...existing, ...(await readBody(request)), id }));
    return;
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/api/watchlist/")) {
    const id = Number(url.pathname.split("/").pop());
    sendJson(response, 200, { removed: deleteWatchedSearch(id) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/scheduler") {
    sendJson(response, 200, scheduler.status((await getState()).config));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/scheduler") {
    sendJson(response, 200, await scheduler.configure(await readBody(request)));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/scheduler/run") {
    sendJson(response, 200, await scheduler.runNow());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    const config = await readJson("config");
    sendJson(response, 200, {
      ...config,
      telegram: maskTelegramConfig(config.telegram)
    });
    return;
  }

  if (request.method === "PATCH" && url.pathname === "/api/config/category-presets") {
    const body = await readBody(request);
    const config = await readJson("config");
    const name = String(body.name || "Computers & Tech").trim();
    const terms = normalizeTermList(body.terms);
    if (!name || terms.length === 0) {
      sendJson(response, 400, { error: "Preset name and at least one term are required" });
      return;
    }
    const next = { ...config, categoryPresets: { ...(config.categoryPresets || {}), [name]: terms } };
    await writeJson("config", next);
    sendJson(response, 200, next.categoryPresets);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/config/telegram") {
    sendJson(response, 200, await updateTelegramConfig(await readBody(request)));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/telegram/test") {
    const result = await sendTelegramTestMessage();
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/api/sellers/blacklist/")) {
    const sellerId = decodeURIComponent(url.pathname.split("/").pop());
    const sellers = await readJson("sellers");
    const next = sellers.filter((seller) => seller.seller_id !== sellerId);
    await writeJson("sellers", next);
    sendJson(response, 200, { removed: sellers.length - next.length });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/filters/stats") {
    const state = await getState();
    const classifications = state.listings.map((listing) => classifyListing(listing, state.filters, state.sellers, state.config));
    sendJson(response, 200, {
      total_listings: state.listings.length,
      filtered: classifications.filter((item) => item.is_filtered).length,
      bad_pricers: classifications.filter((item) => item.post_type === "BAD_PRICER").length,
      spam_blocked: classifications.filter((item) => item.post_type === "SPAM").length,
      sellers_blocked: classifications.filter((item) => item.post_type === "SELLER_BLOCKED").length,
      phrase_rules: state.filters.length
    });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

function buildListings(state, query = "", options = {}) {
  const needle = String(query || "").trim().toLowerCase();
  const minPrice = options.minPrice === null || options.minPrice === undefined || options.minPrice === "" ? null : Number(options.minPrice);
  const maxPrice = options.maxPrice === null || options.maxPrice === undefined || options.maxPrice === "" ? null : Number(options.maxPrice);
  const maxAgeHours = options.maxAgeHours === null || options.maxAgeHours === undefined || options.maxAgeHours === "" ? null : Number(options.maxAgeHours);
  const locationNeedle = String(options.location || "").trim().toLowerCase();
  const labelsByListing = new Map((state.labels || []).map((label) => [Number(label.listing_id), label]));
  const marketMedians = calculateMarketMedians(state.listings || []);
  const marketInsights = buildMarketInsights(state.listings || []);
  const duplicateGroups = buildDuplicateGroups(state.listings || []);
  return state.listings
    .filter((listing) => {
      if (!needle) return true;
      return `${listing.title} ${listing.description} ${listing.category}`.toLowerCase().includes(needle);
    })
    .map((listing) => {
      const normalizedListing = {
        ...listing,
        location: resolveListingLocation(listing),
        market_median: marketMedians[listing.category] || null
      };
      const explicitLabel = labelsByListing.get(Number(listing.id));
      const prediction = predictPreference(normalizedListing, state.trainingModel);
      const classification = applyTrainingOverrides(classifyListing(normalizedListing, state.filters, state.sellers, state.config), explicitLabel, prediction, state.trainingModel);
      const scoreInput = { ...normalizedListing, training: prediction };
      const score = classification.is_filtered ? null : scoreDeal(scoreInput, state.config);
      const marketInsight = marketInsights.get(Number(normalizedListing.id)) || unknownMarketInsight();
      const duplicateInfo = duplicateGroups.get(Number(normalizedListing.id)) || singleDuplicateInfo(normalizedListing);
      if (score) {
        score.training_preference = prediction.preference_score;
        score.market_adjustment = marketScoreAdjustment(marketInsight);
        score.deal_score = clampScore(Number(score.deal_score || 0) + score.market_adjustment);
        score.is_deal = score.deal_score >= Number(state.config.dealThreshold || 70);
        score.explanation = buildScoreExplanation(score, classification, prediction, marketInsight);
      }
      return {
        ...normalizedListing,
        image_urls: proxiedListingImages(normalizedListing),
        original_image_urls: Array.isArray(normalizedListing.image_urls) ? normalizedListing.image_urls : [],
        market_insight: marketInsight,
        duplicate_group_id: duplicateInfo.duplicate_group_id,
        duplicate_count: duplicateInfo.duplicate_count,
        duplicate_role: duplicateInfo.duplicate_role,
        classification,
        training: prediction,
        seller_reputation: sellerReputation(normalizedListing.seller_id, state.trainingModel),
        price_history: getPriceHistory(normalizedListing.id),
        score
      };
    })
    .filter((listing) => {
      if (!options.includeFiltered && listing.classification.is_filtered) return false;
      if (minPrice !== null && Number(listing.current_price || 0) < minPrice) return false;
      if (maxPrice !== null && Number(listing.current_price || 0) > maxPrice) return false;
      if (maxAgeHours !== null && getListingAgeHours(listing) > maxAgeHours) return false;
      if (locationNeedle && !String(listing.location || "").toLowerCase().includes(locationNeedle)) return false;
      return true;
    });
}

function buildScoreExplanation(score, classification, prediction, marketInsight) {
  const components = {
    price: Number(score.price_score || 0),
    seller: Number(score.seller_score || 0),
    age: Number(score.age_score || 0),
    preference: Number(score.training_preference ?? score.preference_score ?? 0),
    detail: Number(score.detail_score || 0),
    penalty: Number(score.penalty || 0),
    market: Number(score.market_adjustment || 0)
  };
  const reasons = [
    ...(classification.reasons || []),
    ...(prediction.reasons || []),
    marketInsight.rating !== "unknown" ? `Market comps: ${marketInsight.rating.replaceAll("_", " ")}` : ""
  ].filter(Boolean);
  return {
    summary: explanationSummary(score, marketInsight),
    price_vs_median: score.price_vs_median ?? marketInsight.price_delta_percent,
    components,
    classification_reasons: classification.reasons || [],
    training_reasons: prediction.reasons || [],
    reasons,
    estimated_negotiation_price: score.estimated_negotiation_price || null
  };
}

function explanationSummary(score, marketInsight) {
  const parts = [`price ${score.price_score}/100`, `seller ${score.seller_score}/100`, `age ${score.age_score}/100`];
  if (Number(score.market_adjustment || 0) !== 0) parts.push(`market ${score.market_adjustment > 0 ? "+" : ""}${score.market_adjustment}`);
  if (marketInsight.rating !== "unknown") parts.push(`${marketInsight.rating.replaceAll("_", " ")} vs ${marketInsight.sample_size} comps`);
  return parts.join(", ");
}

function buildMarketInsights(listings = []) {
  const buckets = new Map();
  for (const listing of listings) {
    const price = Number(listing.current_price || 0);
    if (price <= 1 || price > 100000) continue;
    for (const key of marketKeys(listing)) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(price);
    }
  }

  const insights = new Map();
  for (const listing of listings) {
    const price = Number(listing.current_price || 0);
    const prices = uniquePrices(marketKeys(listing).flatMap((key) => buckets.get(key) || []));
    const median = medianPrice(prices);
    if (!median || prices.length < 3 || price <= 1) {
      insights.set(Number(listing.id), unknownMarketInsight());
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
      price_delta_percent: delta
    });
  }
  return insights;
}

function buildDuplicateGroups(listings = []) {
  const buckets = new Map();
  for (const listing of listings) {
    for (const key of duplicateKeys(listing)) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(listing);
    }
  }
  const groups = new Map();
  let groupIndex = 1;
  for (const items of buckets.values()) {
    const unique = dedupeListings(items).sort((a, b) => getListingAgeHours(a) - getListingAgeHours(b));
    if (unique.length < 2) continue;
    const groupId = `dup-${groupIndex}`;
    groupIndex += 1;
    unique.forEach((listing, index) => {
      const current = groups.get(Number(listing.id));
      if (current && current.duplicate_count >= unique.length) return;
      groups.set(Number(listing.id), {
        duplicate_group_id: groupId,
        duplicate_count: unique.length,
        duplicate_role: index === 0 ? "primary" : "secondary"
      });
    });
  }
  for (const listing of listings) {
    if (!groups.has(Number(listing.id))) groups.set(Number(listing.id), singleDuplicateInfo(listing));
  }
  return groups;
}

function marketScoreAdjustment(insight) {
  if (insight.rating === "great") return 5;
  if (insight.rating === "suspicious_low") return -4;
  if (insight.rating === "overpriced") return -8;
  return 0;
}

function marketKeys(listing) {
  const category = normalizeText(listing.category || "electronics");
  const tokens = titleTokens(listing.title).slice(0, 4);
  const keys = [category];
  if (tokens.length >= 2) keys.push(`${category}:${tokens.slice(0, 2).join("-")}`);
  if (tokens.length >= 3) keys.push(tokens.slice(0, 3).join("-"));
  return keys;
}

function duplicateKeys(listing) {
  const title = titleTokens(listing.title).slice(0, 5).join("-");
  const seller = normalizeText(listing.seller_id || listing.seller_name || "");
  const priceBand = Math.round(Number(listing.current_price || 0) / 25) * 25;
  const keys = [];
  if (listing.carousell_id) keys.push(`id:${listing.carousell_id}`);
  if (title && seller) keys.push(`seller:${seller}:${title}:${priceBand}`);
  for (const image of (listing.image_urls || []).slice(0, 2)) {
    if (image) keys.push(`img:${normalizeText(image).slice(-80)}`);
  }
  return keys;
}

function titleTokens(title) {
  return normalizeText(title)
    .split(" ")
    .filter((token) => token.length > 1 && !["with", "and", "for", "the", "only", "brand", "new"].includes(token));
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeTermList(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  return [...new Set(String(value || "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function uniquePrices(prices) {
  return [...new Set(prices.map((price) => Number(price || 0)).filter((price) => price > 1 && price < 100000))];
}

function medianPrice(prices) {
  if (!prices.length) return 0;
  const sorted = [...prices].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function unknownMarketInsight() {
  return { rating: "unknown", median_price: null, sample_size: 0, price_delta_percent: null };
}

function singleDuplicateInfo(listing) {
  return { duplicate_group_id: `single-${listing.id}`, duplicate_count: 1, duplicate_role: "primary" };
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function proxiedListingImages(listing) {
  return (Array.isArray(listing.image_urls) ? listing.image_urls : [])
    .filter(Boolean)
    .filter((url) => !/\/profiles?\//i.test(url))
    .map((url) => proxiedImageUrl(url));
}

function resolveListingLocation(listing) {
  const existing = String(listing.location || "").trim();
  if (existing && !/^carousell sg$/i.test(existing)) return existing;
  return extractLocation("", "", listing.description || "");
}

function getListingAgeHours(listing) {
  if (listing.listed_age_minutes !== null && listing.listed_age_minutes !== undefined) {
    return Number(listing.listed_age_minutes) / 60;
  }
  if (listing.listed_at) {
    return Math.max(0, (Date.now() - new Date(listing.listed_at).getTime()) / 3600000);
  }
  if (listing.days_listed !== null && listing.days_listed !== undefined) {
    return Number(listing.days_listed) * 24;
  }
  return 0;
}

async function retrainPreferenceModel() {
  const [listings, labels] = await Promise.all([readJson("listings"), readJson("labels")]);
  const model = trainModel(listings, labels);
  await writeJson("trainingModel", model);
  return model;
}

function applyTrainingOverrides(classification, label, prediction, model) {
  const rating = String(label?.user_rating || "");
  const polarity = labelPolarity(rating);

  if (polarity === "positive") {
    return {
      ...classification,
      post_type: "WTS",
      is_filtered: false,
      spam_score: 0,
      reasons: ["User trained as good", ...classification.reasons]
    };
  }

  if (rating === "spam" || rating === "bad_pricer") {
    return {
      ...classification,
      post_type: rating === "spam" ? "SPAM" : "BAD_PRICER",
      is_filtered: true,
      spam_score: 100,
      reasons: [`User trained as ${rating.replace("_", " ")}`, ...classification.reasons]
    };
  }

  if (rating === "bad_deal") {
    return {
      ...classification,
      post_type: "BAD_DEAL",
      is_filtered: false,
      spam_score: 0,
      reasons: ["User trained as bad deal", ...classification.reasons]
    };
  }

  if (rating === "skip") {
    return {
      ...classification,
      post_type: "LEARNED_SKIP",
      is_filtered: true,
      spam_score: Math.max(classification.spam_score, 75),
      reasons: ["User trained as skip", ...classification.reasons]
    };
  }

  if (!classification.is_filtered && model?.example_count >= 5 && prediction.preference_score <= 18 && prediction.confidence >= 0.25) {
    return {
      ...classification,
      post_type: "LEARNED_SKIP",
      is_filtered: true,
      spam_score: 70,
      reasons: [`Learned low preference (${prediction.preference_score}/100)`, ...prediction.reasons, ...classification.reasons]
    };
  }

  return classification;
}

async function recordSearch(query, mode) {
  const timestamp = new Date().toISOString();
  const searches = await readJson("searches");
  searches.unshift({
    id: Date.now(),
    query,
    mode,
    timestamp
  });
  await writeJson("searches", searches.slice(0, 50));
  addActivity({ type: "search", title: `Search: ${query}`, detail: mode, timestamp });
}

async function searchAndStoreWebResults(query, mode, options = {}) {
  try {
    const webSearch = await searchCarousell(query, { limit: "all", anchorLimit: mode === "more" ? 500 : 240, hydrateDetails: false });
    const listings = await readJson("listings");
    const existing = new Map(listings.map((listing, index) => [listing.carousell_id, { listing, index }]));
    const additions = [];
    const hydrationCandidates = [];
    const priceDrops = [];
    let updated = 0;
    let nextId = Math.max(0, ...listings.map((item) => item.id || 0)) + 1;

    for (const listing of webSearch.results) {
      const match = existing.get(listing.carousell_id);
      if (match) {
        const oldPrice = Number(match.listing.current_price || 0);
        listings[match.index] = mergeListingDetails(match.listing, listing);
        const newPrice = Number(listings[match.index].current_price || 0);
        if (oldPrice > 0 && newPrice > 0 && newPrice < oldPrice) {
          priceDrops.push({ listing: listings[match.index], oldPrice, newPrice });
        }
        hydrationCandidates.push({ listing: listings[match.index], isNew: false });
        updated += 1;
        continue;
      }
      const added = {
        id: nextId,
        ...listing
      };
      additions.push(added);
      hydrationCandidates.push({ listing: added, isNew: true });
      nextId += 1;
    }

    if (additions.length > 0) {
      listings.push(...additions);
    }

    if (additions.length > 0 || updated > 0) {
      bulkUpsertListings(listings);
    }

    let job = null;
    if (options.awaitHydration) {
      job = await hydrateCandidatesNow(hydrationCandidates, { query, mode, options, initialPriceDrops: priceDrops });
    } else {
      await handleSearchAlerts({ additions: [], priceDrops, query, options });
      job = startHydrationJob(hydrationCandidates, { query, mode, options });
    }

    return {
      source: "carousell-web",
      url: webSearch.url,
      added: additions.length,
      updated,
      price_drops: priceDrops.length,
      job
    };
  } catch (error) {
    error.message = `Web search failed: ${error.message}`;
    throw error;
  }
}

async function runWatchedSearch(watch) {
  const config = await readJson("config");
  const terms = watchTerms(watch, config);
  const seen = new Set();
  const results = [];
  for (const term of terms) {
    const result = await searchAndStoreWebResults(term, "web", { watch, alert: true, categoryQuery: watch.query, awaitHydration: true });
    results.push(result);
    for (const listing of await readJson("listings")) {
      if (seen.has(listing.carousell_id)) continue;
      seen.add(listing.carousell_id);
    }
  }
  updateWatchedSearchRun(watch.id);
  return {
    watch_id: watch.id,
    query: watch.query,
    terms,
    source: "carousell-web",
    added: results.reduce((total, item) => total + Number(item.added || 0), 0),
    updated: results.reduce((total, item) => total + Number(item.updated || 0), 0),
    price_drops: results.reduce((total, item) => total + Number(item.price_drops || 0), 0),
    jobs: results.map((item) => item.job).filter(Boolean)
  };
}

function startHydrationJob(candidates, context = {}) {
  const items = prioritizeHydration(candidates.map((item) => ({ ...item.listing, __hydrate_is_new: Boolean(item.isNew) })));
  if (items.length === 0) return null;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    query: context.query || "",
    mode: context.mode || "web",
    status: "queued",
    total: items.length,
    completed: 0,
    failed: 0,
    started_at: new Date().toISOString(),
    finished_at: null,
    error: "",
    listing_ids: items.map((listing) => listing.id)
  };
  searchJobs.set(id, job);
  addActivity({ type: "hydrate_start", title: `Hydrating ${items.length} listings`, detail: context.query || "search details", timestamp: job.started_at });
  runHydrationJob(job, items, context).catch((error) => {
    job.status = "error";
    job.error = error.message;
    job.finished_at = new Date().toISOString();
    addActivity({ type: "scrape_error", title: "Hydration failed", detail: error.message });
  });
  return { id: job.id, status: job.status, total: job.total, completed: job.completed };
}

async function hydrateCandidatesNow(candidates, context = {}) {
  const items = prioritizeHydration(candidates.map((item) => ({ ...item.listing, __hydrate_is_new: Boolean(item.isNew) })));
  if (items.length === 0) {
    await handleSearchAlerts({ additions: candidates.filter((item) => item.isNew).map((item) => item.listing), priceDrops: [], query: context.query || "", options: context.options || {} });
    return null;
  }
  const job = {
    id: `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: "running",
    total: items.length,
    completed: 0,
    failed: 0
  };
  await runHydrationJob(job, items, context);
  return { id: job.id, status: job.status, total: job.total, completed: job.completed, failed: job.failed };
}

async function runHydrationJob(job, items, context = {}) {
  job.status = "running";
  const hydrated = await hydrateCarousellListings(items, { concurrency: 4, jitterMs: 500 });
  const byId = new Map(hydrated.map((listing) => [Number(listing.id), listing]));
  const listings = await readJson("listings");
  const additions = [];
  const priceDrops = [...(context.initialPriceDrops || [])];
  let updated = 0;

  for (let index = 0; index < listings.length; index += 1) {
    const hydratedListing = byId.get(Number(listings[index].id));
    if (!hydratedListing) continue;
    const oldPrice = Number(listings[index].current_price || 0);
    listings[index] = mergeListingDetails(listings[index], hydratedListing);
    const newPrice = Number(listings[index].current_price || 0);
    if (oldPrice > 0 && newPrice > 0 && newPrice < oldPrice) {
      priceDrops.push({ listing: listings[index], oldPrice, newPrice });
    }
    if (hydratedListing.__hydrate_is_new) additions.push(listings[index]);
    updated += 1;
    job.completed = updated;
  }

  if (updated > 0) bulkUpsertListings(listings);
  await handleSearchAlerts({ additions, priceDrops, query: context.query || "", options: context.options || {} });
  job.status = "complete";
  job.completed = updated;
  job.failed = Math.max(0, job.total - updated);
  job.finished_at = new Date().toISOString();
  addActivity({ type: "hydrate_finish", title: "Hydration finished", detail: `${updated}/${job.total} listings enriched`, timestamp: job.finished_at });
}

function prioritizeHydration(listings) {
  const staleAfterMs = 6 * 60 * 60 * 1000;
  return [...dedupeListings(listings)]
    .map((listing) => ({ listing, priority: hydrationPriority(listing, staleAfterMs) }))
    .filter((item) => item.priority > 0)
    .sort((a, b) => b.priority - a.priority)
    .map((item) => item.listing);
}

function hydrationPriority(listing, staleAfterMs) {
  let priority = 0;
  if (!listing.details_scraped_at) priority += 60;
  if ([0, 1, 8, 88, 888, 8888, 9999, 12345].includes(Number(listing.current_price || 0))) priority += 45;
  if (!listing.description || String(listing.description).length < 50) priority += 25;
  if (!Array.isArray(listing.image_urls) || listing.image_urls.length === 0) priority += 20;
  if (!listing.location || /^carousell sg$/i.test(String(listing.location))) priority += 15;
  if (Number(listing.current_price || 0) > 1) priority += 5;
  if (listing.details_scraped_at && Date.now() - new Date(listing.details_scraped_at).getTime() > staleAfterMs) priority += 20;
  return priority;
}

function dedupeListings(listings) {
  const seen = new Set();
  return listings.filter((listing) => {
    const key = listing.carousell_id || listing.carousell_url || listing.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function watchTerms(watch, config = {}) {
  if (Array.isArray(watch.terms) && watch.terms.length > 0) return watch.terms;
  const key = String(watch.query || "").trim().toLowerCase();
  const preset = categoryPresetFromConfig(key, config);
  if (preset) return preset.terms;
  return [watch.query].filter(Boolean);
}

async function handleSearchAlerts({ additions, priceDrops, query, options }) {
  const state = await getState();
  const threshold = Number(state.config.dealThreshold || 70);
  const watch = options.watch || null;
  const addedBuilt = buildListings({ ...state, listings: additions }, "", { includeFiltered: false });

  for (const listing of addedBuilt) {
    if (Number(listing.score?.deal_score || 0) < threshold) continue;
    if (watch?.price_ceiling && Number(listing.current_price || 0) > Number(watch.price_ceiling)) continue;
    if (getListingAgeHours(listing) > 48) continue;
    await emitAlert(listingAlertPayload(listing, {
      type: watch ? "restock" : "new_deal",
      watch_id: watch?.id || null,
      alert_key: alertKey({ type: watch ? "restock" : "new_deal", listing_id: listing.id, watch_id: watch?.id || null }),
      reason: watch ? `New match from ${watch.query}` : `New deal from ${query}`
    }));
  }

  for (const drop of priceDrops) {
    await emitAlert(listingAlertPayload(drop.listing, {
      type: "price_drop",
      message: `${formatMoney(drop.oldPrice)} -> ${formatMoney(drop.newPrice)} from ${query}`,
      watch_id: watch?.id || null,
      alert_key: alertKey({ type: "price_drop", listing_id: drop.listing.id, watch_id: watch?.id || null, price: drop.newPrice }),
      reason: `Price dropped from ${formatMoney(drop.oldPrice)}`
    }));
  }
}

function listingAlertPayload(listing, extra = {}) {
  const score = listing.score || {};
  return {
    ...extra,
    title: listing.title,
    message: extra.message || `${formatMoney(listing.current_price)} | score ${score.deal_score || "n/a"} | ${listing.location || "location not listed"}`,
    listing_id: listing.id,
    listing_url: listing.carousell_url,
    price: listing.current_price,
    score: score.deal_score,
    score_breakdown: score.deal_score ? `price ${score.price_score}/100, preference ${score.training_preference ?? score.preference_score}/100` : "",
    location: listing.location || "location not listed",
    seller_name: listing.seller_name || "",
    seller_rating: listing.seller_rating || 0,
    condition: listing.condition || "",
    explanation: score.explanation?.summary || "",
    market_rating: listing.market_insight?.rating || "",
    description: listing.description || ""
  };
}

async function emitAlert(alert) {
  if (shouldSuppressAlert(alert)) {
    addActivity({ type: "alert_suppressed", title: "Duplicate alert skipped", detail: alert.title, listing_id: alert.listing_id, watch_id: alert.watch_id });
    return null;
  }
  const { alert: saved, result } = await notifyAlert(alert);
  addActivity({
    type: result.ok ? saved.type : "notification_error",
    title: result.ok ? saved.title : "Telegram notification failed",
    detail: result.ok ? saved.message : saved.error,
    listing_id: saved.listing_id,
    watch_id: saved.watch_id
  });
  return saved;
}

function shouldSuppressAlert(alert) {
  const key = alert.alert_key || alertKey(alert);
  const existing = getAlerts({ limit: 1000 });
  return existing.some((item) => {
    if (!item.sent_at || item.error) return false;
    if ((item.alert_key || alertKey(item)) === key) return true;
    if (alert.type === "price_drop") return false;
    return Number(item.listing_id || 0) === Number(alert.listing_id || -1)
      && String(item.type || "") === String(alert.type || "")
      && String(item.watch_id || "") === String(alert.watch_id || "");
  });
}

function alertKey(input = {}) {
  return [
    input.type || "deal",
    input.watch_id || "manual",
    input.listing_id || "listing",
    input.type === "price_drop" ? Number(input.price || input.price_to || 0) : "once"
  ].join(":");
}

async function handleTelegramCommand(text) {
  if (typeof text === "object" && text?.type === "callback") {
    return handleTelegramCallback(text);
  }
  const { command, args } = parseTelegramCommand(text);
  if (command === "/help" || !command) {
    return [
      "Carousell Bot commands:",
      "/search <query> - fast search and show top results",
      "/watch <category-or-query> - monitor every 30 minutes",
      "/unwatch <name> - pause a monitor",
      "/status - scheduler and monitor status",
      "/deals - current top deal candidates"
    ].join("\n");
  }

  if (command === "/search") {
    if (!args) return "Usage: /search gpu";
    await recordSearch(args, "telegram");
    const result = await searchAndStoreWebResults(args, "web", { alert: false });
    const state = await getState();
    const listings = buildListings(state, args, { includeFiltered: false, minPrice: 1 }).slice(0, 5);
    return [`Search: ${args}`, `Added ${result.added}, updated ${result.updated}. Hydration job ${result.job?.id || "none"}.`, formatListingLines(listings)].filter(Boolean).join("\n");
  }

  if (command === "/watch") {
    if (!args) return "Usage: /watch Computers & Tech";
    const preset = await categoryPreset(args);
    const watch = upsertWatchedSearch({
      query: preset?.label || args,
      category: preset ? "category monitor" : "telegram",
      kind: preset ? "category" : "query",
      terms: preset?.terms || [],
      active: true
    });
    const config = await readJson("config");
    await scheduler.configure({ enabled: true, intervalMinutes: config.scheduler?.intervalMinutes || 30, jitterSeconds: config.scheduler?.jitterSeconds || 45 });
    return `Watching ${watch.query}. Terms: ${watchTerms(watch, config).join(", ")}. Scheduler is active every ${config.scheduler?.intervalMinutes || 30} minutes.`;
  }

  if (command === "/unwatch") {
    if (!args) return "Usage: /unwatch Computers & Tech";
    const watches = await getWatchedSearches();
    const watch = watches.find((item) => String(item.query || "").toLowerCase() === args.toLowerCase() || String(item.category || "").toLowerCase() === args.toLowerCase());
    if (!watch) return `No monitor found for ${args}.`;
    upsertWatchedSearch({ ...watch, active: false });
    return `Paused monitor: ${watch.query}`;
  }

  if (command === "/status") {
    const config = (await getState()).config;
    const status = scheduler.status(config);
    const watches = (await getWatchedSearches()).filter((watch) => watch.active);
    return [
      `Scheduler: ${status.enabled ? "active" : "paused"}${status.running ? " (running)" : ""}`,
      `Last: ${status.lastRunAt || "never"}`,
      `Next: ${status.nextRunAt || "not scheduled"}`,
      `Active monitors: ${watches.length}`,
      watches.map((watch) => {
        const terms = watchTerms(watch, config);
        return `- ${watch.query} (${terms.length} term${terms.length === 1 ? "" : "s"})`;
      }).join("\n")
    ].filter(Boolean).join("\n");
  }

  if (command === "/deals") {
    const state = await getState();
    const deals = buildListings(state, "", { includeFiltered: false }).filter((listing) => listing.score?.is_deal).slice(0, 5);
    return deals.length ? `Top deals:\n${formatListingLines(deals)}` : "No deal candidates right now.";
  }

  return `Unknown command: ${command}. Try /help.`;
}

function formatListingLines(listings) {
  return listings
    .map((listing, index) => {
      const score = listing.score?.deal_score ?? "n/a";
      const why = listing.score?.explanation?.summary ? ` | ${listing.score.explanation.summary}` : "";
      return `${index + 1}. ${listing.title} - ${formatMoney(listing.current_price)} | Score ${score} | ${listing.location || "location not listed"}${why}\n${listing.carousell_url}`;
    })
    .join("\n");
}

async function categoryPreset(value) {
  return categoryPresetFromConfig(value, await readJson("config"));
}

function categoryPresetFromConfig(value, config = {}) {
  const key = String(value || "").trim().toLowerCase();
  const presets = config.categoryPresets || {};
  for (const [label, terms] of Object.entries(presets)) {
    const aliases = [label.toLowerCase(), label.toLowerCase().replace("&", "and"), ...String(label).toLowerCase().split(/[&/]/).map((item) => item.trim())];
    if (aliases.includes(key)) return { label, terms: normalizeTermList(terms) };
  }
  return null;
}

async function handleTelegramCallback(callback) {
  const listingId = Number(callback.listingId || 0);
  if (!listingId) return "Listing not found";
  const listings = await readJson("listings");
  const listing = listings.find((item) => Number(item.id) === listingId);
  if (!listing) return "Listing not found";

  if (["good", "bad_deal", "spam"].includes(callback.action)) {
    await saveListingLabel(listingId, callback.action, { asked_price: listing.current_price });
    return `Marked ${callback.action.replace("_", " ")}`;
  }

  if (callback.action === "block") {
    await blockSellerFromListing(listing);
    return `Blocked ${listing.seller_name || listing.seller_id || "seller"}`;
  }

  if (callback.action === "watch") {
    const query = watchSimilarQuery(listing);
    const watch = upsertWatchedSearch({ query, category: listing.category || "telegram", kind: "query", active: true });
    return `Watching similar: ${watch.query}`;
  }

  return "Unknown action";
}

async function saveListingLabel(listingId, rating, body = {}) {
  const labels = await readJson("labels");
  const next = labels.filter((label) => Number(label.listing_id) !== Number(listingId));
  next.push({
    listing_id: Number(listingId),
    user_rating: rating,
    asked_price: body.asked_price || null,
    negotiated_price: body.negotiated_price || null,
    timestamp: new Date().toISOString()
  });
  await writeJson("labels", next);
  await retrainPreferenceModel();
  return next.find((label) => Number(label.listing_id) === Number(listingId));
}

async function blockSellerFromListing(listing) {
  const sellerId = listing.seller_id || listing.seller_name;
  if (!sellerId) return null;
  const sellers = await readJson("sellers");
  if (!sellers.some((seller) => seller.seller_id === sellerId)) {
    sellers.push({
      seller_id: sellerId,
      seller_name: listing.seller_name || sellerId,
      reason: "Blocked from Telegram",
      blocked_at: new Date().toISOString()
    });
    await writeJson("sellers", sellers);
  }
  return sellerId;
}

function watchSimilarQuery(listing) {
  const tokens = titleTokens(listing.title).slice(0, 4);
  return tokens.length ? tokens.join(" ") : listing.category || listing.title || "Carousell deal";
}

function sellerReputation(sellerId, model) {
  const stats = model?.seller_stats?.[sellerId] || { good: 0, bad: 0 };
  const weight = Number(model?.seller_weights?.[sellerId] || 0);
  const total = Number(stats.good || 0) + Number(stats.bad || 0);
  const ratio = total ? Number(stats.good || 0) / total : 0.5;
  const tone = total === 0 ? "neutral" : ratio >= 0.67 ? "good" : ratio <= 0.34 ? "bad" : "mixed";
  return {
    seller_id: sellerId,
    good: Number(stats.good || 0),
    bad: Number(stats.bad || 0),
    total,
    ratio,
    weight,
    tone
  };
}


function mergeListingDetails(existing, incoming) {
  const { __hydrate_is_new, ...cleanIncoming } = incoming || {};
  return {
    ...existing,
    ...cleanIncoming,
    id: existing.id,
    description: cleanIncoming.description || existing.description || "",
    seller_name: cleanIncoming.seller_name && cleanIncoming.seller_name !== "Carousell seller" ? cleanIncoming.seller_name : existing.seller_name,
    seller_id: cleanIncoming.seller_id || existing.seller_id,
    seller_url: cleanIncoming.seller_url || existing.seller_url || "",
    location: cleanIncoming.location || resolveListingLocation(existing),
    current_price: cleanIncoming.current_price || existing.current_price,
    image_urls: cleanIncoming.image_urls?.length ? cleanIncoming.image_urls : existing.image_urls || []
  };
}

function calculateMarketMedians(listings) {
  const grouped = {};
  for (const listing of listings) {
    const category = listing.category || "electronics";
    const price = Number(listing.current_price || 0);
    if (price <= 1 || price >= 100000) continue;
    grouped[category] ||= [];
    grouped[category].push(price);
  }

  return Object.fromEntries(
    Object.entries(grouped).map(([category, prices]) => {
      const sorted = prices.sort((a, b) => a - b);
      return [category, sorted[Math.floor(sorted.length / 2)]];
    })
  );
}

function formatMoney(value) {
  return `S$${Number(value || 0).toLocaleString()}`;
}

async function serveStatic(urlPath, response) {
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    sendText(response, 403, "Forbidden");
    return;
  }
  const content = await readFile(filePath);
  response.writeHead(200, { "content-type": contentType(filePath) });
  response.end(content);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function sendText(response, status, value) {
  response.writeHead(status, { "content-type": "text/plain" });
  response.end(value);
}

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".js")) return "text/javascript";
  if (filePath.endsWith(".html")) return "text/html";
  return "application/octet-stream";
}
