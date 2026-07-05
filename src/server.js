import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyListing, scoreDeal } from "./filterEngine.js";
import { getState, readJson, writeJson } from "./store.js";

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
    const listings = state.listings.map((listing) => {
      const classification = classifyListing(listing, state.filters, state.sellers, state.config);
      return {
        ...listing,
        classification,
        score: classification.is_filtered ? null : scoreDeal(listing, state.config)
      };
    });
    sendJson(response, 200, listings);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/deals") {
    const state = await getState();
    const deals = state.listings
      .map((listing) => ({
        ...listing,
        classification: classifyListing(listing, state.filters, state.sellers, state.config)
      }))
      .filter((listing) => !listing.classification.is_filtered)
      .map((listing) => ({ ...listing, score: scoreDeal(listing, state.config) }))
      .filter((listing) => listing.score.is_deal);
    sendJson(response, 200, deals);
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
