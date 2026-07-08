import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { buildListings, server } from "./server.js";
import { getAlerts, getPriceHistory, getState } from "./store.js";
import { flattenListingForExport, parseStartUrls, searchBodyFromStartUrls, toCsv } from "./listingDataQuality.js";
import { searchAndStoreStartUrls } from "./startUrlSearch.js";

const port = Number(process.env.PORT || 3000);
const [originalHandler] = server.listeners("request");

server.removeAllListeners("request");
server.on("request", async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/api/export/listings.csv") {
      const state = await getState();
      const listings = buildListings(state, url.searchParams.get("q"), filterOptions(url)).map(flattenListingForExport);
      sendCsv(response, "carousell-listings.csv", toCsv(listings));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/export/deals.csv") {
      const state = await getState();
      const deals = buildListings(state, url.searchParams.get("q"), { ...filterOptions(url), includeFiltered: false })
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
      const listings = buildListings(state, url.searchParams.get("q"), { ...filterOptions(url), includeFiltered: true });
      const rows = [];
      for (const listing of listings) {
        for (const item of getPriceHistory(listing.id)) {
          rows.push({
            listing_id: listing.id,
            title: listing.title,
            price: item.price,
            recorded_at: item.recorded_at,
            carousell_url: listing.carousell_url
          });
        }
      }
      sendCsv(response, "carousell-price-history.csv", toCsv(rows, ["listing_id", "title", "price", "recorded_at", "carousell_url"]));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/start-urls/parse") {
      sendJson(response, 200, parseStartUrls(url.searchParams.getAll("url").length ? url.searchParams.getAll("url") : url.searchParams.get("urls")));
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
          results: buildListings(state, query, {
            minPrice: nextBody.min_price ?? 1,
            maxPrice: nextBody.max_price,
            maxAgeHours: nextBody.max_age_hours,
            location: nextBody.location,
            includeFiltered: Boolean(nextBody.include_filtered ?? true)
          }),
          history: state.searches || []
        });
        return;
      }
      await originalHandler(makeJsonRequest(request, body), response);
      return;
    }

    await originalHandler(request, response);
  } catch (error) {
    if (!response.headersSent) sendJson(response, 500, { error: error.message });
  }
});

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  server.listen(port, () => {
    console.log(`Carousell Bot Plus running at http://localhost:${port}`);
    console.log("Extra routes: /api/export/listings.csv, /api/export/deals.csv, /api/export/alerts.json, /api/export/price-history.csv, /api/start-urls/parse");
  });
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
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function makeJsonRequest(original, body) {
  const next = Readable.from([JSON.stringify(body)]);
  next.method = original.method;
  next.url = original.url;
  next.headers = { ...original.headers, "content-type": "application/json" };
  return next;
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
