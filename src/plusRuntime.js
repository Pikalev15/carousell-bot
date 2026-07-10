import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { authorizeDashboardRequest } from "./dashboardAuth.js";
import { applyRollingCategoryMedians } from "./categoryMedianAutoTune.js";
import { applyScopedDuplicateInfo } from "./duplicateGroups.js";
import { scoreDeal } from "./filterEngine.js";
import { hydrateCarousellListings } from "./plusHydration.js";
import { getAlerts, getPriceHistory, getState, readJson, writeJson } from "./store.js";
import { markAllAlertsRead } from "./storeReliability.js";
import { enrichListingData, flattenListingForExport, parseStartUrls, searchBodyFromStartUrls, toCsv } from "./listingDataQuality.js";
import { REFINED_RATINGS, saveRefinedListingLabel } from "./refinedFeedback.js";
import { searchAndStoreStartUrls } from "./startUrlSearch.js";
import {
  addDuplicateOverride,
  createExportBundle,
  getDuplicateOverrides,
  getMergedPriceHistory,
  getSellerReputationHistory,
  importBundle,
  setListingSnooze,
  setWatchMute
} from "./batchFeatures.js";

const TELEGRAM_RATING_ALIASES = new Map([
  ["good", "good_deal"],
  ["bad", "bad_deal"],
  ["spam", "spam"],
  ["wtb", "wtb_service"],
  ["service", "wtb_service"],
  ["accessory", "accessory_only"],
  ["wrongcat", "wrong_category"],
  ["dupe", "duplicate_listing"]
]);

export function installPlusRuntime({ server, originalHandler, buildListings, coreHandleTelegramCommand }) {
  if (!server || typeof originalHandler !== "function") throw new Error("server and originalHandler are required");
  if (typeof buildListings !== "function") throw new Error("buildListings is required");
  if (typeof coreHandleTelegramCommand !== "function") throw new Error("coreHandleTelegramCommand is required");

  const plusSearchJobs = new Map();
  const scopedListingsCache = new Map();
  const cacheMax = Math.max(5, Number(process.env.LISTINGS_CACHE_MAX || 40));
  const perfLogEnabled = /^(1|true|yes)$/i.test(String(process.env.PERF_LOG || ""));

  server.removeAllListeners("request");
  server.on("request", async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname.startsWith("/api/") && !authorizeDashboardRequest(request, response, url)) return;

      if (request.method === "GET" && url.pathname.match(/^\/api\/listings\/\d+\/price-history$/)) {
        const id = Number(url.pathname.split("/")[3]);
        const merged = url.searchParams.get("merged") !== "false";
        sendJson(response, 200, merged ? await getMergedPriceHistory(id) : getPriceHistory(id));
        return;
      }

      if (request.method === "POST" && url.pathname.match(/^\/api\/listings\/\d+\/link-duplicate$/)) {
        const id = Number(url.pathname.split("/")[3]);
        const body = await readRequestBody(request);
        const result = addDuplicateOverride(id, Number(body.other_listing_id), "merge");
        clearScopedListingsCache();
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname.match(/^\/api\/listings\/\d+\/unlink-duplicate$/)) {
        const id = Number(url.pathname.split("/")[3]);
        const body = await readRequestBody(request);
        const result = addDuplicateOverride(id, Number(body.other_listing_id), "split");
        clearScopedListingsCache();
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname.match(/^\/api\/listings\/\d+\/snooze$/)) {
        const id = Number(url.pathname.split("/")[3]);
        const body = await readRequestBody(request);
        const result = setListingSnooze(id, body.duration, await readJson("config"));
        clearScopedListingsCache();
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "GET" && url.pathname.match(/^\/api\/sellers\/[^/]+\/reputation$/)) {
        const sellerId = decodeURIComponent(url.pathname.split("/")[3]);
        sendJson(response, 200, await getSellerReputationHistory(sellerId));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/export") {
        sendJson(response, 200, await createExportBundle());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/import") {
        const result = await importBundle(await readRequestBody(request));
        clearScopedListingsCache();
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/listings") {
        const state = await timed("getState:/api/listings", () => getState());
        const listings = cachedScopedListings(state, url.searchParams.get("q"), filterOptions(url));
        sendJson(response, 200, listings);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/deals") {
        const state = await timed("getState:/api/deals", () => getState());
        const deals = cachedScopedListings(state)
          .filter((listing) => !listing.classification.is_filtered)
          .filter((listing) => listing.score.is_deal);
        sendJson(response, 200, deals);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/export/listings.csv") {
        const state = await timed("getState:/api/export/listings.csv", () => getState());
        const listings = cachedScopedListings(state, url.searchParams.get("q"), filterOptions(url)).map(flattenListingForExport);
        sendCsv(response, "carousell-listings.csv", toCsv(listings));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/export/deals.csv") {
        const state = await timed("getState:/api/export/deals.csv", () => getState());
        const deals = cachedScopedListings(state, url.searchParams.get("q"), { ...filterOptions(url), includeFiltered: false })
          .filter((listing) => !listing.classification?.is_filtered)
          .filter((listing) => listing.score?.is_deal)
          .map(flattenListingForExport);
        sendCsv(response, "carousell-deals.csv", toCsv(deals));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/export/alerts.json") {
        sendJson(response, 200, { alerts: getAlerts({ limit: 1000 }) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/alerts/mark-read") {
        sendJson(response, 200, await markAllAlertsRead());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/export/price-history.csv") {
        const state = await timed("getState:/api/export/price-history.csv", () => getState());
        const listings = cachedScopedListings(state, url.searchParams.get("q"), { ...filterOptions(url), includeFiltered: true });
        const rows = [];
        for (const listing of listings) {
          for (const item of await getMergedPriceHistory(listing.id)) {
            rows.push({
              listing_id: item.listing_id,
              source_listing_id: item.source_listing_id,
              title: listing.title,
              price: item.price,
              recorded_at: item.recorded_at,
              carousell_url: listing.carousell_url
            });
          }
        }
        sendCsv(response, "carousell-price-history.csv", toCsv(rows, ["listing_id", "source_listing_id", "title", "price", "recorded_at", "carousell_url"]));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/start-urls/parse") {
        sendJson(response, 200, parseStartUrls(url.searchParams.getAll("url").length ? url.searchParams.getAll("url") : url.searchParams.get("urls")));
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/search/jobs/")) {
        const id = url.pathname.split("/").pop();
        if (plusSearchJobs.has(id)) {
          sendJson(response, 200, plusSearchJobs.get(id));
          return;
        }
      }

      if (request.method === "POST" && url.pathname === "/api/feedback/label") {
        const body = await readRequestBody(request);
        try {
          sendJson(response, 200, await saveRefinedListingLabel(Number(body.listing_id), body.rating, body));
        } catch (error) {
          sendJson(response, 400, { error: error.message });
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/search") {
        const body = await readRequestBody(request);
        if (String(body.mode || "").toLowerCase() === "local" && !body.startUrl && !body.startUrls && !body.urls) {
          await originalHandler(cloneJsonRequest(request, body), response);
          return;
        }
        const nextBody = searchBodyFromStartUrls(body);
        const query = String(nextBody.query || body.query || "").trim();
        if (!query && !nextBody.startUrls?.length) {
          sendJson(response, 400, { error: "query or parseable startUrls are required" });
          return;
        }
        const search = await searchAndStoreStartUrls({ ...nextBody, query }, {
          limit: "all",
          anchorLimit: nextBody.mode === "more" || body.mode === "more" ? 500 : 240,
          hydrateDetails: false
        });
        const state = await timed("getState:/api/search", () => getState());
        const resultQuery = query || search.parsed?.primary?.query || "";
        const hydrationJob = createHydrationJob(search.results || [], resultQuery);
        sendJson(response, 200, {
          query: resultQuery,
          mode: nextBody.mode || body.mode || "web",
          source: search.source,
          source_url: search.url,
          start_url_mode: search.start_url_mode,
          ...searchDiagnosticsPayload(search),
          added: search.added,
          updated: search.updated,
          hydration_job: hydrationJob,
          warning: null,
          results: cachedScopedListings(state, resultQuery, {
            minPrice: nextBody.min_price ?? body.min_price ?? 1,
            maxPrice: nextBody.max_price ?? body.max_price,
            maxAgeHours: nextBody.max_age_hours ?? body.max_age_hours,
            location: nextBody.location ?? body.location,
            includeFiltered: Boolean(nextBody.include_filtered ?? body.include_filtered ?? true)
          }),
          history: state.searches || []
        });
        return;
      }

      await originalHandler(request, response);
    } catch (error) {
      if (!response.headersSent) sendJson(response, 500, { error: error.message });
    }
  });

  async function handleTelegramCommand(text) {
    if (typeof text === "object") {
      const handled = await handleTelegramTrainingCallback(text);
      if (handled) return handled;
      return coreHandleTelegramCommand(text);
    }
    const [command, ...parts] = String(text || "").trim().split(/\s+/);
    if (command === "/snooze") {
      const [listingId, duration] = parts;
      if (!listingId) return "Usage: /snooze <listing_id> [duration]";
      const result = setListingSnooze(Number(listingId), duration, await readJson("config"));
      return `Snoozed listing ${Number(listingId)} until ${result.muted_until}`;
    }
    if (command === "/mute") {
      const [target, duration] = parts;
      if (!target) return "Usage: /mute <query_or_watch_id> <duration>";
      const watch = await setWatchMute(target, duration, await readJson("config"));
      return `Muted watch ${watch.query} until ${watch.muted_until}`;
    }
    if (command === "/help") {
      return `${await coreHandleTelegramCommand(text)}\n/snooze <listing_id> [duration] - mute one listing\n/mute <query_or_watch_id> <duration> - temporarily mute a watched search`;
    }
    return coreHandleTelegramCommand(text);
  }

  async function handleTelegramTrainingCallback(callback) {
    const listingId = Number(callback.listingId || 0);
    if (!listingId) return null;

    if (callback.action === "train") {
      const listing = await findListingForTelegram(listingId);
      if (!listing) return { answer: "Listing not found" };
      return {
        answer: "Choose a training label",
        message: `Train listing #${listingId}: ${listing.title}\nPick the reason so future alerts get smarter.`,
        reply_markup: telegramTrainingMenu(listingId)
      };
    }

    const refinedRating = telegramRatingForAction(callback.action);
    if (!refinedRating) return null;
    const listing = await findListingForTelegram(listingId);
    if (!listing) return { answer: "Listing not found" };
    const label = await saveRefinedListingLabel(listingId, refinedRating, {
      asked_price: listing.current_price,
      notes: `Telegram training: ${refinedRating}`
    });
    clearScopedListingsCache();
    return `Trained as ${label.refined_rating.replaceAll("_", " ")}`;
  }

  function createHydrationJob(listings, query) {
    const candidates = (Array.isArray(listings) ? listings : []).filter((listing) => listing?.carousell_url);
    if (!candidates.length) return null;
    const id = `plus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job = { id, query, status: "queued", total: candidates.length, completed: 0, started_at: new Date().toISOString(), completed_at: null, error: null };
    plusSearchJobs.set(id, job);
    hydratePlusListings(id, candidates).catch((error) => {
      const current = plusSearchJobs.get(id) || job;
      plusSearchJobs.set(id, { ...current, status: "failed", error: error.message, completed_at: new Date().toISOString() });
    });
    return job;
  }

  async function hydratePlusListings(jobId, listings) {
    const job = plusSearchJobs.get(jobId);
    if (!job) return;
    plusSearchJobs.set(jobId, { ...job, status: "running" });
    const batchSize = 3;
    for (let index = 0; index < listings.length; index += batchSize) {
      const current = plusSearchJobs.get(jobId);
      if (!current || current.status === "failed") return;
      const batch = listings.slice(index, index + batchSize);
      const hydrated = await timed(`hydratePlusListings:${batch.length}`, () => hydrateCarousellListings(batch, { concurrency: 2, jitterMs: 400 }));
      await mergeHydratedListings(hydrated);
      plusSearchJobs.set(jobId, { ...current, status: "running", completed: Math.min(listings.length, index + batch.length), total: listings.length });
    }
    const current = plusSearchJobs.get(jobId) || job;
    plusSearchJobs.set(jobId, { ...current, status: "complete", completed: listings.length, completed_at: new Date().toISOString() });
  }

  async function mergeHydratedListings(hydratedListings) {
    if (!hydratedListings?.length) return;
    const current = await readJson("listings");
    const byCarousellId = new Map(current.map((listing, index) => [listing.carousell_id, { listing, index }]));
    let changed = false;
    for (const hydrated of hydratedListings) {
      const enriched = enrichListingData(hydrated);
      const existing = byCarousellId.get(enriched.carousell_id);
      if (!existing) continue;
      current[existing.index] = enrichListingData({
        ...existing.listing,
        ...enriched,
        id: existing.listing.id,
        like_count: Number(enriched.like_count ?? enriched.likes_count ?? existing.listing.like_count ?? existing.listing.likes_count ?? 0),
        likes_count: Number(enriched.likes_count ?? enriched.like_count ?? existing.listing.likes_count ?? existing.listing.like_count ?? 0),
        favourite_count: Number(enriched.favourite_count ?? enriched.favorite_count ?? enriched.like_count ?? existing.listing.favourite_count ?? 0),
        favorite_count: Number(enriched.favorite_count ?? enriched.favourite_count ?? enriched.like_count ?? existing.listing.favorite_count ?? 0),
        image_urls: preferHydratedImages(enriched.image_urls, existing.listing.image_urls),
        original_image_urls: preferHydratedImages(enriched.original_image_urls || enriched.image_urls, existing.listing.original_image_urls || existing.listing.image_urls)
      });
      changed = true;
    }
    if (changed) {
      await writeJson("listings", current);
      clearScopedListingsCache();
    }
  }

  function cachedScopedListings(state, query = "", options = {}) {
    const key = scopedListingsCacheKey(state, query, options);
    const cached = scopedListingsCache.get(key);
    if (cached) return cached;
    const started = performance.now();
    const listings = scopedListings(buildListings(state, query, options), state.config);
    if (scopedListingsCache.size >= cacheMax) {
      const oldestKey = scopedListingsCache.keys().next().value;
      if (oldestKey) scopedListingsCache.delete(oldestKey);
    }
    scopedListingsCache.set(key, listings);
    logPerf("build+scope listings", started, `${listings.length} returned, cache size ${scopedListingsCache.size}`);
    return listings;
  }

  function clearScopedListingsCache() {
    scopedListingsCache.clear();
  }

  function timed(label, fn) {
    const started = performance.now();
    return Promise.resolve(fn()).finally(() => logPerf(label, started));
  }

  function logPerf(label, started, detail = "") {
    if (!perfLogEnabled) return;
    const ms = (performance.now() - started).toFixed(1);
    console.log(`[perf] ${label}: ${ms}ms${detail ? ` (${detail})` : ""}`);
  }

  function scopedListings(listings, config = {}) {
    const grouped = applyScopedDuplicateInfo(listings || [], { overrides: getDuplicateOverrides() });
    return applyRollingCategoryMedians(grouped, config, scoreDeal);
  }

  function stateFingerprint(state = {}) {
    const derivedVersion = Number(state.derivedListingsVersion);
    if (Number.isFinite(derivedVersion)) return `derived:${derivedVersion}`;
    const storeVersion = Number(state.storeVersion);
    if (Number.isFinite(storeVersion)) return `store:${storeVersion}`;
    return `${Array.isArray(state.listings) ? state.listings.length : 0}:${Array.isArray(state.labels) ? state.labels.length : 0}:${hashValue(state.config || {})}:${hashValue(state.trainingModel || {})}`;
  }

  function scopedListingsCacheKey(state, query, options) {
    return `${stateFingerprint(state)}|${filterFingerprint(query, options)}`;
  }

  function filterFingerprint(query, options = {}) {
    return JSON.stringify({
      q: String(query || "").trim().toLowerCase(),
      minPrice: options.minPrice ?? "",
      maxPrice: options.maxPrice ?? "",
      maxAgeHours: options.maxAgeHours ?? "",
      location: String(options.location || "").trim().toLowerCase(),
      includeFiltered: Boolean(options.includeFiltered)
    });
  }

  function hashValue(value) {
    const text = JSON.stringify(value ?? null);
    let hash = 0;
    for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return hash.toString(36);
  }

  return { handleTelegramCommand, clearScopedListingsCache };
}

function searchDiagnosticsPayload(search = {}) {
  const scrapeResult = search.scrape_result || null;
  return {
    status: search.status ?? scrapeResult?.status ?? null,
    ok: search.ok ?? scrapeResult?.ok ?? null,
    result_count: search.result_count ?? scrapeResult?.result_count ?? null,
    parser: search.parser ?? scrapeResult?.parser ?? null,
    anchors_found: search.anchors_found ?? scrapeResult?.anchors_found ?? null,
    next_data_found: search.next_data_found ?? scrapeResult?.next_data_found ?? null,
    challenge_detected: search.challenge_detected ?? scrapeResult?.challenge_detected ?? false,
    consent_page_detected: search.consent_page_detected ?? scrapeResult?.consent_page_detected ?? false,
    diagnostic: search.diagnostic ?? scrapeResult?.diagnostic ?? null,
    scrape_result: scrapeResult,
    scrape_results: Array.isArray(search.scrape_results) ? search.scrape_results : []
  };
}

async function findListingForTelegram(listingId) {
  const listings = await readJson("listings");
  return listings.find((item) => Number(item.id) === Number(listingId)) || null;
}

function telegramRatingForAction(action) {
  const value = String(action || "").trim().toLowerCase();
  const normalized = TELEGRAM_RATING_ALIASES.get(value) || value;
  return REFINED_RATINGS.includes(normalized) && normalized !== "unmarked" ? normalized : "";
}

function telegramTrainingMenu(id) {
  return {
    inline_keyboard: [
      [
        { text: "Great", callback_data: `cb:great_deal:${id}` },
        { text: "Good", callback_data: `cb:good_deal:${id}` },
        { text: "Fair", callback_data: `cb:fair_deal:${id}` }
      ],
      [
        { text: "Bad deal", callback_data: `cb:bad_deal:${id}` },
        { text: "Overpriced", callback_data: `cb:overpriced:${id}` },
        { text: "Bad pricer", callback_data: `cb:bad_pricer:${id}` }
      ],
      [
        { text: "WTB/service", callback_data: `cb:wtb_service:${id}` },
        { text: "Accessory only", callback_data: `cb:accessory_only:${id}` },
        { text: "Wrong cat", callback_data: `cb:wrong_category:${id}` }
      ],
      [
        { text: "Duplicate", callback_data: `cb:duplicate_listing:${id}` },
        { text: "Irrelevant", callback_data: `cb:irrelevant:${id}` },
        { text: "Not spam", callback_data: `cb:not_spam:${id}` }
      ]
    ]
  };
}

function preferHydratedImages(detailImages = [], shallowImages = []) {
  const detail = (detailImages || []).filter(Boolean);
  const shallow = (shallowImages || []).filter(Boolean);
  return [...new Set([...detail, ...shallow])];
}

function filterOptions(url) {
  return {
    minPrice: url.searchParams.get("min_price"),
    maxPrice: url.searchParams.get("max_price"),
    maxAgeHours: url.searchParams.get("max_age_hours"),
    location: url.searchParams.get("location"),
    includeFiltered: url.searchParams.get("include_filtered") === "true"
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendCsv(response, filename, csv) {
  response.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`
  });
  response.end(csv);
}

function cloneJsonRequest(request, body = {}) {
  const payload = Buffer.from(JSON.stringify(body || {}));
  const cloned = Readable.from([payload]);
  cloned.method = request.method;
  cloned.url = request.url;
  cloned.headers = {
    ...request.headers,
    "content-type": "application/json",
    "content-length": String(payload.length)
  };
  return cloned;
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
