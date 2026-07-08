import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { authorizeDashboardRequest, dashboardAuthHeaders, warnIfDashboardUnauthenticated } from "./dashboardAuth.js";
import { applyScopedDuplicateInfo } from "./duplicateGroups.js";
import { buildListings, handleTelegramCommand as coreHandleTelegramCommand, server } from "./server.js";
import { scoreDeal } from "./filterEngine.js";
import { getAlerts, getPriceHistory, getState, readJson } from "./store.js";
import { startTelegramCommandPolling } from "./notifier.js";
import { flattenListingForExport, parseStartUrls, searchBodyFromStartUrls, toCsv } from "./listingDataQuality.js";
import { saveRefinedListingLabel } from "./refinedFeedback.js";
import { searchAndStoreStartUrls } from "./startUrlSearch.js";
import {
  addDuplicateOverride,
  createExportBundle,
  getDuplicateOverrides,
  getMergedPriceHistory,
  getScopedListings,
  getSellerReputationHistory,
  importBundle,
  setListingSnooze,
  setWatchMute
} from "./batchFeatures.js";

const port = Number(process.env.PORT || 3000);
const [originalHandler] = server.listeners("request");

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
      sendJson(response, 200, addDuplicateOverride(id, Number(body.other_listing_id), "merge"));
      return;
    }

    if (request.method === "POST" && url.pathname.match(/^\/api\/listings\/\d+\/unlink-duplicate$/)) {
      const id = Number(url.pathname.split("/")[3]);
      const body = await readRequestBody(request);
      sendJson(response, 200, addDuplicateOverride(id, Number(body.other_listing_id), "split"));
      return;
    }

    if (request.method === "POST" && url.pathname.match(/^\/api\/listings\/\d+\/snooze$/)) {
      const id = Number(url.pathname.split("/")[3]);
      const body = await readRequestBody(request);
      sendJson(response, 200, setListingSnooze(id, body.duration, await readJson("config")));
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
      sendJson(response, 200, await importBundle(await readRequestBody(request)));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/listings") {
      const state = await getState();
      const listings = scopedListings(buildListings(state, url.searchParams.get("q"), filterOptions(url)), state.config);
      sendJson(response, 200, listings);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/deals") {
      const state = await getState();
      const deals = scopedListings(buildListings(state), state.config)
        .filter((listing) => !listing.classification.is_filtered)
        .filter((listing) => listing.score.is_deal);
      sendJson(response, 200, deals);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/export/listings.csv") {
      const state = await getState();
      const listings = scopedListings(buildListings(state, url.searchParams.get("q"), filterOptions(url)), state.config).map(flattenListingForExport);
      sendCsv(response, "carousell-listings.csv", toCsv(listings));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/export/deals.csv") {
      const state = await getState();
      const deals = scopedListings(buildListings(state, url.searchParams.get("q"), { ...filterOptions(url), includeFiltered: false }), state.config)
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

    if (request.method === "GET" && url.pathname === "/api/export/price-history.csv") {
      const state = await getState();
      const listings = scopedListings(buildListings(state, url.searchParams.get("q"), { ...filterOptions(url), includeFiltered: true }), state.config);
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
      if (body.startUrls || body.start_urls || body.start_url || body.url) {
        const nextBody = searchBodyFromStartUrls(body);
        if (!nextBody.query && !nextBody.startUrls?.length) {
          sendJson(response, 400, { error: "query or parseable startUrls are required" });
          return;
        }
        const search = await searchAndStoreStartUrls(nextBody, {
          limit: "all",
          anchorLimit: nextBody.mode === "more" ? 500 : 240,
          hydrateDetails: false
        });
        const state = await getState();
        const query = nextBody.query || search.parsed?.primary?.query || "";
        sendJson(response, 200, {
          query,
          mode: nextBody.mode || "web",
          source: search.source,
          source_url: search.url,
          start_url_mode: search.start_url_mode,
          added: search.added,
          updated: search.updated,
          hydration_job: null,
          warning: null,
          results: scopedListings(buildListings(state, query, {
            minPrice: nextBody.min_price ?? 1,
            maxPrice: nextBody.max_price,
            maxAgeHours: nextBody.max_age_hours,
            location: nextBody.location,
            includeFiltered: Boolean(nextBody.include_filtered ?? true)
          }), state.config),
          history: state.searches || []
        });
        return;
      }
      const payload = await callOriginalJson("POST", request.url, body);
      if (Array.isArray(payload?.results)) payload.results = scopedListings(payload.results, await readJson("config"));
      sendJson(response, 200, payload);
      return;
    }

    await originalHandler(request, response);
  } catch (error) {
    if (!response.headersSent) sendJson(response, 500, { error: error.message });
  }
});

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  warnIfDashboardUnauthenticated();
  server.listen(port, () => {
    console.log(`Carousell Bot running at http://localhost:${port}`);
    console.log("Plus routes enabled: /api/export/listings.csv, /api/export/deals.csv, /api/export/alerts.json, /api/export/price-history.csv, /api/start-urls/parse");
  });
  startOriginalScheduler().catch((error) => console.warn(`Scheduler failed to start: ${error.message}`));
  startTelegramCommandPolling(handleTelegramCommand).catch((error) => console.warn(`Telegram command polling failed: ${error.message}`));
}

async function handleTelegramCommand(text) {
  if (typeof text === "object") return coreHandleTelegramCommand(text);
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

function scopedListings(listings, config = {}) {
  const grouped = applyScopedDuplicateInfo(listings || [], { overrides: getDuplicateOverrides() });
  return applyRollingCategoryMedians(grouped, config, scoreDeal);
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

async function startOriginalScheduler() {
  const config = await readJson("config");
  if (!config.scheduler?.enabled) return;
  await callOriginalJson("POST", "/api/scheduler", {
    enabled: true,
    intervalMinutes: config.scheduler.intervalMinutes || 30,
    jitterSeconds: config.scheduler.jitterSeconds || 45
  });
}

async function callOriginalJson(method, url, body) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    const request = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
    request.method = method;
    request.url = url;
    request.headers = { host: `localhost:${port}`, "content-type": "application/json", ...dashboardAuthHeaders() };

    const response = {
      headersSent: false,
      statusCode: 200,
      writeHead(status) {
        this.headersSent = true;
        this.statusCode = status;
        return this;
      },
      write(chunk) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      },
      end(chunk) {
        try {
          if (chunk) this.write(chunk);
          const raw = Buffer.concat(chunks).toString("utf8");
          if (this.statusCode >= 400) return reject(new Error(raw || `Original handler failed (${this.statusCode})`));
          resolve(raw ? JSON.parse(raw) : {});
        } catch (error) {
          reject(error);
        }
      },
      on(event, handler) {
        if (event === "error") this._onError = handler;
        return this;
      }
    };

    Promise.resolve(originalHandler(request, response)).catch(reject);
  });
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

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
