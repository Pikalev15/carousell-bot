import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyListing, scoreDeal } from "./filterEngine.js";
import { searchCarousell } from "./carousellSearch.js";
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
    if (mode === "more" && (!webSearch || webSearch.added === 0)) await addDemoSearchResults(query);

    const state = await getState();
    sendJson(response, 200, {
      query,
      mode,
      source: webSearch?.source || (mode === "more" ? "local-demo" : "local"),
      source_url: webSearch?.url || null,
      added: webSearch?.added || 0,
      warning: webSearch?.warning || null,
      results: buildListings(state, query, {
        minPrice: body.min_price ?? 1,
        maxPrice: body.max_price,
        maxAgeHours: body.max_age_hours,
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
    const estimate = Math.max(price + 20, Math.round(price * deterministicMultiplier(title)));
    sendJson(response, 200, {
      title,
      msrp: estimate,
      discount_percent: estimate ? Math.round(((estimate - price) / estimate) * 100) : 0,
      source: "Local test estimator"
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
  const labelsByListing = new Map((state.labels || []).map((label) => [Number(label.listing_id), label]));
  return state.listings
    .filter((listing) => {
      if (!needle) return true;
      return `${listing.title} ${listing.description} ${listing.category}`.toLowerCase().includes(needle);
    })
    .map((listing) => {
      const explicitLabel = labelsByListing.get(Number(listing.id));
      const prediction = predictPreference(listing, state.trainingModel);
      const classification = applyTrainingOverrides(classifyListing(listing, state.filters, state.sellers, state.config), explicitLabel, prediction, state.trainingModel);
      const scoreInput = { ...listing, training: prediction };
      const score = classification.is_filtered ? null : scoreDeal(scoreInput, state.config);
      if (score) score.training_preference = prediction.preference_score;
      return {
        ...listing,
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
      return true;
    });
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
    const existing = new Set(listings.map((listing) => listing.carousell_id));
    const additions = webSearch.results
      .filter((listing) => !existing.has(listing.carousell_id))
      .map((listing, index) => ({
        id: Math.max(0, ...listings.map((item) => item.id || 0)) + index + 1,
        ...listing
      }));

    if (additions.length > 0) {
      listings.push(...additions);
      await writeJson("listings", listings);
    }

    return {
      source: "carousell-web",
      url: webSearch.url,
      added: additions.length
    };
  } catch (error) {
    return {
      source: "local-fallback",
      url: null,
      added: 0,
      warning: `Web search failed: ${error.message}`
    };
  }
}

async function addDemoSearchResults(query) {
  const listings = await readJson("listings");
  const existingForQuery = listings.filter((listing) => listing.carousell_id.startsWith(`demo-${slug(query)}-`)).length;
  const additions = makeDemoListings(query, listings.length + 1, existingForQuery);
  listings.push(...additions);
  await writeJson("listings", listings);
}

function makeDemoListings(query, startId, offset) {
  const cleanQuery = titleCase(query);
  const category = inferCategory(query);
  const sellers = ["Nate", "Clara", "Wei", "Rina", "Harish", "Jo"];
  const conditions = ["like_new", "good", "fair", "new"];
  return Array.from({ length: 6 }, (_, index) => {
    const n = offset + index + 1;
    const bait = n % 5 === 0;
    const hostile = n % 4 === 0;
    const price = bait ? 1 : Math.max(45, Math.round((520 + n * 73) * (category === "camera" ? 1.8 : 1)));
    return {
      id: startId + index,
      carousell_id: `demo-${slug(query)}-${Date.now()}-${index}`,
      title: `${cleanQuery} ${n % 2 ? "bundle" : "set"} ${n}`,
      description: bait ? "Offer me, testing water." : hostile ? "No lowball. Price firm." : "Personal sale, meet-up preferred.",
      category,
      condition: conditions[n % conditions.length],
      seller_id: `demo-seller-${slug(query)}-${n}`,
      seller_name: sellers[n % sellers.length],
      seller_rating: Number((3.7 + (n % 14) / 10).toFixed(1)),
      location: ["Bishan", "Tampines", "Jurong", "Orchard", "Serangoon"][n % 5],
      days_listed: (n * 3) % 45,
      current_price: price,
      image_urls: [],
      carousell_url: "https://www.carousell.sg/",
      scraped_at: new Date().toISOString()
    };
  });
}

function deterministicMultiplier(value) {
  const sum = [...value].reduce((total, char) => total + char.charCodeAt(0), 0);
  return 1.18 + (sum % 45) / 100;
}

function inferCategory(query) {
  const text = query.toLowerCase();
  if (/camera|sony|canon|nikon|fuji|lens/.test(text)) return "camera";
  if (/switch|playstation|xbox|game|ps5/.test(text)) return "gaming";
  if (/airpod|speaker|headphone|audio/.test(text)) return "audio";
  return "electronics";
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "search";
}

function titleCase(value) {
  return value
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
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
