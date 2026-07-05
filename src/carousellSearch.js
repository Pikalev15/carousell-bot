const CAROUSELL_BASE_URL = "https://www.carousell.sg";
const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];

export async function searchCarousell(query, options = {}) {
  const limit = Number(options.limit || 24);
  const searchUrl = `${CAROUSELL_BASE_URL}/search/${encodeURIComponent(query)}?addRecent=true&canChangeKeyword=true&includeSuggestions=true&searchId=${Date.now()}`;
  const pageData = await fetchWithBrowser(searchUrl, options);
  const found = new Map();

  for (const listing of pageData.domListings) {
    const normalized = normalizeListing({ ...listing, query });
    if (normalized) found.set(normalized.carousell_id, normalized);
  }

  for (const listing of extractListingsFromHtml(pageData.html, query)) {
    if (!found.has(listing.carousell_id)) found.set(listing.carousell_id, listing);
  }

  const listings = [...found.values()].slice(0, limit);
  return {
    source: "carousell",
    url: searchUrl,
    results: listings
  };
}

async function fetchWithBrowser(url, options = {}) {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error("playwright-core is not installed. Run npm.cmd install.");
  }

  const executablePath = options.executablePath || (await findChromePath());
  if (!executablePath) {
    throw new Error("Chrome or Edge was not found on this PC.");
  }

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"]
  });

  try {
    const page = await browser.newPage({
      locale: "en-SG",
      timezoneId: "Asia/Singapore",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await page.waitForSelector('a[href*="/p/"], script#__NEXT_DATA__', { timeout: 20000 }).catch(() => {});
    const domListings = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll('a[href*="/p/"]')];
      return anchors.slice(0, 80).map((anchor) => {
        let node = anchor;
        let cardText = anchor.innerText || "";
        for (let depth = 0; depth < 5 && node?.parentElement; depth += 1) {
          node = node.parentElement;
          const text = node.innerText || "";
          if (text.length > cardText.length && text.length < 1200) cardText = text;
        }
        const image = node?.querySelector?.("img")?.src || anchor.querySelector?.("img")?.src || "";
        return {
          title: anchor.innerText || cardText,
          cardText,
          price: cardText,
          url: anchor.href,
          imageUrls: image ? [image] : []
        };
      });
    });
    return {
      html: await page.content(),
      domListings
    };
  } finally {
    await browser.close();
  }
}

export function extractListingsFromHtml(html, query) {
  const nextData = extractNextData(html);
  const found = new Map();

  if (nextData) {
    collectListingObjects(nextData, found, query);
  }

  if (found.size === 0) {
    collectListingsFromAnchors(html, found, query);
  }

  return [...found.values()];
}

function extractNextData(html) {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;

  try {
    return JSON.parse(decodeHtml(match[1]));
  } catch {
    return null;
  }
}

function collectListingObjects(value, found, query) {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const item of value) collectListingObjects(item, found, query);
    return;
  }

  const title = firstString(value.title, value.name, value.heading, value.subject);
  const priceValue = value.price || value.priceAmount || value.price_value || value.value;
  const url = firstString(value.url, value.webUrl, value.shareUrl, value.canonicalUrl);
  const id = firstString(value.id, value.listingId, value.productId, value.itemId);

  if (title && looksLikeListing(value, url, priceValue)) {
    const normalized = normalizeListing({
      id,
      title,
      description: firstString(value.description, value.body, value.caption) || "",
      price: parsePrice(priceValue),
      sellerName: firstString(value.sellerName, value.seller_name, value.username, value.ownerName),
      sellerId: firstString(value.sellerId, value.seller_id, value.ownerId, value.userId),
      url,
      query,
      imageUrls: collectImageUrls(value)
    });
    if (normalized) found.set(normalized.carousell_id, normalized);
  }

  for (const child of Object.values(value)) {
    collectListingObjects(child, found, query);
  }
}

function collectListingsFromAnchors(html, found, query) {
  const anchorPattern = /<a\b[^>]*href=["']([^"']*\/p\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(html))) {
    const href = decodeHtml(match[1]);
    const text = stripTags(match[2]).replace(/\s+/g, " ").trim();
    const price = parsePrice(text);
    const title = text.replace(/S\$\s?[\d,]+.*/i, "").trim();
    const normalized = normalizeListing({ title, price, url: href, query });
    if (normalized) found.set(normalized.carousell_id, normalized);
  }
}

function normalizeListing(input) {
  const cardText = String(input.cardText || "");
  const title = cleanTitle(String(input.title || cardText).trim(), cardText);
  const url = normalizeUrl(input.url);
  if (!title || title.length < 3 || !url) return null;
  if (/^(buyer protection|instantbuy|chat|like|share)$/i.test(title)) return null;
  const price = parsePrice(input.price || cardText);

  const carousellId = input.id || url.match(/\/p\/[^/]+-(\d+)/)?.[1] || stableId(`${title}-${url}`);
  return {
    carousell_id: `web-${carousellId}`,
    title,
    description: input.description || cardText,
    category: inferCategory(input.query || title),
    condition: "unknown",
    seller_id: input.sellerId || `web-seller-${stableId(input.sellerName || url)}`,
    seller_name: input.sellerName || "Carousell seller",
    seller_rating: 0,
    location: "Carousell SG",
    days_listed: 0,
    current_price: price > 99999 ? 0 : price,
    image_urls: input.imageUrls || [],
    carousell_url: url,
    scraped_at: new Date().toISOString()
  };
}

function cleanTitle(value, cardText = "") {
  const source = /^(preferred|spotlight|bumped)$/i.test(String(value).trim()) || String(value).trim().length < 8 ? cardText : value || cardText;
  const lines = String(source)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(preferred|spotlight|bumped)$/i.test(line))
    .filter((line) => !/^(buyer protection|instantbuy|chat|like|share)$/i.test(line))
    .filter((line) => !/^S\$\s?[\d,]+/i.test(line))
    .filter((line) => !/^(like new|new|used|well used|brand new)$/i.test(line))
    .filter((line) => !/^\d+ (sec|min|hour|day|week|month)s? ago$/i.test(line));
  return (lines[0] || value).replace(/\s+/g, " ").trim();
}

function looksLikeListing(value, url, priceValue) {
  return Boolean(url?.includes("/p/") || value.listingId || value.itemId || value.sellerId || parsePrice(priceValue));
}

function collectImageUrls(value) {
  const urls = [];
  const visit = (item) => {
    if (!item || urls.length >= 4) return;
    if (typeof item === "string" && /^https?:\/\/.*\.(jpg|jpeg|png|webp)/i.test(item)) urls.push(item);
    if (Array.isArray(item)) item.forEach(visit);
    if (typeof item === "object") Object.values(item).forEach(visit);
  };
  visit(value.images || value.photos || value.media);
  return [...new Set(urls)];
}

function normalizeUrl(url) {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  if (url.startsWith("/")) return `${CAROUSELL_BASE_URL}${url}`;
  return "";
}

function parsePrice(value) {
  if (typeof value === "number") return Math.round(value);
  if (!value) return 0;
  const match = String(value).match(/(?:S\$|\$|SGD)\s?([\d,]+(?:\.\d+)?)/i);
  return match ? Math.round(Number(match[1].replaceAll(",", ""))) : 0;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim();
}

function stripTags(value) {
  return decodeHtml(value.replace(/<[^>]*>/g, " "));
}

function decodeHtml(value) {
  return String(value)
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&#x2F;", "/")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function stableId(value) {
  let hash = 0;
  for (const char of String(value)) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function inferCategory(query) {
  const text = query.toLowerCase();
  if (/camera|sony|canon|nikon|fuji|lens/.test(text)) return "camera";
  if (/switch|playstation|xbox|game|ps5/.test(text)) return "gaming";
  if (/airpod|speaker|headphone|audio/.test(text)) return "audio";
  return "electronics";
}

async function findChromePath() {
  const { access } = await import("node:fs/promises");
  for (const candidate of CHROME_PATHS) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known browser path.
    }
  }
  return "";
}
