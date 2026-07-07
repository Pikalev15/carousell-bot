import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyListing, scoreDeal } from "./filterEngine.js";
import { extractLocation, refreshCarousellListingDetails, searchCarousell } from "./carousellSearch.js";
import { lookupMsrpFromGoogle } from "./msrpSearch.js";
import { getState, readJson, writeJson } from "./store.js";
import { labelPolarity, predictPreference, trainModel } from "./trainingModel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");
const port = Number(process.env.PORT || 3000);

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
}

export { server };

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
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
    await writeJson("listings", listings);

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
    const webSearch = mode !== "local" ? await searchAndStoreWebResults(query, mode) : null;

    const state = await getState();
    sendJson(response, 200, {
      query,
      mode,
      source: webSearch?.source || "local",
      source_url: webSearch?.url || null,
      added: webSearch?.added || 0,
      updated: webSearch?.updated || 0,
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
    const labels = await readJson("labels");
    const next = labels.filter((label) => label.listing_id !== listingId);
    next.push({
      listing_id: listingId,
      user_rating: rating,
      asked_price: body.asked_price || null,
      negotiated_price: body.negotiated_price || null,
      timestamp: new Date().toISOString()
    });
    await writeJson("labels", next);
    await retrainPreferenceModel();
    sendJson(response, 200, next.find((label) => label.listing_id === listingId));
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
      if (score) score.training_preference = prediction.preference_score;
      return {
        ...normalizedListing,
        classification,
        training: prediction,
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
  const searches = await readJson("searches");
  searches.unshift({
    id: Date.now(),
    query,
    mode,
    timestamp: new Date().toISOString()
  });
  await writeJson("searches", searches.slice(0, 50));
}

async function searchAndStoreWebResults(query, mode) {
  try {
    const webSearch = await searchCarousell(query, { limit: mode === "more" ? 40 : 24 });
    const listings = await readJson("listings");
    const existing = new Map(listings.map((listing, index) => [listing.carousell_id, { listing, index }]));
    const additions = [];
    let updated = 0;
    let nextId = Math.max(0, ...listings.map((item) => item.id || 0)) + 1;

    for (const listing of webSearch.results) {
      const match = existing.get(listing.carousell_id);
      if (match) {
        listings[match.index] = mergeListingDetails(match.listing, listing);
        updated += 1;
        continue;
      }
      additions.push({
        id: nextId,
        ...listing
      });
      nextId += 1;
    }

    if (additions.length > 0) {
      listings.push(...additions);
    }

    if (additions.length > 0 || updated > 0) {
      await writeJson("listings", listings);
    }

    return {
      source: "carousell-web",
      url: webSearch.url,
      added: additions.length,
      updated
    };
  } catch (error) {
    throw new Error(`Web search failed: ${error.message}`, { cause: error });
  }
}


function mergeListingDetails(existing, incoming) {
  return {
    ...existing,
    ...incoming,
    id: existing.id,
    description: incoming.description || existing.description || "",
    seller_name: incoming.seller_name && incoming.seller_name !== "Carousell seller" ? incoming.seller_name : existing.seller_name,
    seller_id: incoming.seller_id || existing.seller_id,
    seller_url: incoming.seller_url || existing.seller_url || "",
    location: incoming.location || resolveListingLocation(existing),
    current_price: incoming.current_price || existing.current_price,
    image_urls: incoming.image_urls?.length ? incoming.image_urls : existing.image_urls || []
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
