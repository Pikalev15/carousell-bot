import { parseMoney } from "./currency.js";

const CAROUSELL_BASE_URL = "https://www.carousell.sg";
const CHROME_PATHS = [
  process.env.CHROME_PATH,
  process.env.GOOGLE_CHROME_BIN,
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);

export async function searchCarousell(query, options = {}) {
  const limit = Number(options.limit || 24);
  const searchUrl = `${CAROUSELL_BASE_URL}/search/${encodeURIComponent(query)}?addRecent=true&canChangeKeyword=true&includeSuggestions=true&searchId=${Date.now()}`;
  const pageData = await fetchWithBrowser(searchUrl, { ...options, limit });
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

export async function refreshCarousellListingDetails(listing) {
  const url = normalizeUrl(listing.carousell_url || listing.url);
  if (!url) throw new Error("listing has no Carousell URL");

  const { page, browser } = await newBrowserPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    await expandDetailSections(page);
    const details = await readDetailPage(page);
    const seller = extractSellerFromDetails(details, listing.seller_name);
    const description = extractDescription(details.bodyText, details.metaDescription, listing.title);
    const location = extractLocation(details.bodyText, details.jsonLd, description, details.locationLinks);
    const detailPrice = extractRealPriceFromDescription(`${description}\n${details.bodyText}\n${details.metaDescription}\n${details.jsonLd}`);
    return {
      description,
      seller_name: seller.name || listing.seller_name,
      seller_id: seller.id || listing.seller_id,
      seller_url: seller.url || listing.seller_url || "",
      location: location || cleanLocation(listing.location) || "",
      current_price: detailPrice || listing.current_price,
      price_source: detailPrice && detailPrice !== listing.current_price ? "description" : listing.price_source || "card",
      image_urls: mergeImageUrls(details.imageUrls, listing.image_urls),
      scraped_at: new Date().toISOString()
    };
  } finally {
    await browser.close();
  }
}

async function fetchWithBrowser(url, options = {}) {
  const { page, browser } = await newBrowserPage(options);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await page.waitForSelector('a[href*="/p/"], script#__NEXT_DATA__', { timeout: 20000 }).catch(() => {});
    let domListings = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll('a[href*="/p/"]')];
      return anchors.slice(0, 80).map((anchor) => {
        let node = anchor;
        let cardText = anchor.innerText || "";
        for (let depth = 0; depth < 5 && node?.parentElement; depth += 1) {
          node = node.parentElement;
          const text = node.innerText || "";
          if (text.length > cardText.length && text.length < 1200) cardText = text;
        }
        const imageUrls = collectDomImageUrls(node || anchor, anchor);
        return {
          title: anchor.innerText || cardText,
          cardText,
          price: cardText,
          url: anchor.href,
          imageUrls
        };
      });

      function collectDomImageUrls(...roots) {
        const urls = [];
        const add = (value) => {
          if (!value) return;
          for (const candidate of String(value).split(",")) {
            const url = candidate.trim().split(/\s+/)[0].replace(/^['"]|['"]$/g, "");
            if (url && !urls.includes(url)) urls.push(url);
          }
        };
        for (const root of roots) {
          if (!root) continue;
          root.querySelectorAll?.("img, source").forEach((image) => {
            add(image.currentSrc);
            add(image.src);
            add(image.srcset);
            add(image.getAttribute("data-src"));
            add(image.getAttribute("data-original"));
            add(image.getAttribute("data-lazy-src"));
          });
          root.querySelectorAll?.("[style*='background']").forEach((element) => {
            const match = String(element.getAttribute("style") || "").match(/url\((['"]?)(.*?)\1\)/i);
            add(match?.[2]);
          });
        }
        return urls;
      }
    });
    domListings = await enrichListingDetails(browser, domListings, options.limit || 24, options);
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
      location: extractStructuredLocation(value),
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
    const normalized = normalizeListing({ title, price, url: href, query, imageUrls: extractImageUrlsFromHtml(match[2]) });
    if (normalized) found.set(normalized.carousell_id, normalized);
  }
}

const EXCLUDED_IMAGE_PATTERN = /(avatar|profile[-_]?(pic|photo|image)|user[-_]?icon|placeholder|sprite|favicon|\blogo\b|blank\.gif|1x1|loading[-_]?spinner|badge|star-rating|verified-icon)/i;

function normalizeImageUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${CAROUSELL_BASE_URL}${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  return "";
}

function mergeImageUrls(...sources) {
  const urls = [];
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const raw of source) {
      const url = normalizeImageUrl(raw);
      if (!url || urls.includes(url)) continue;
      if (EXCLUDED_IMAGE_PATTERN.test(url)) continue;
      urls.push(url);
    }
  }
  return urls.slice(0, 6);
}

function extractImageUrlsFromHtml(html) {
  const source = String(html || "");
  const urls = [];
  const attrPattern = /(?:src|data-src|data-original|data-lazy-src|srcset)=["']([^"']+)["']/gi;
  let match;
  while ((match = attrPattern.exec(source))) {
    const value = decodeHtml(match[1]);
    for (const candidate of value.split(",")) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url) urls.push(url);
    }
  }
  return urls;
}

function normalizeListing(input) {
  const cardText = String(input.cardText || "");
  const parsedCard = parseCardText(cardText);
  const title = cleanTitle(String(parsedCard.title || input.title || cardText).trim(), cardText);
  const url = normalizeUrl(input.url);
  if (!title || title.length < 3 || !url) return null;
  if (/^(buyer protection|instantbuy|chat|like|share)$/i.test(title)) return null;
  const cardPrice = parsePrice(input.price || cardText);
  const detailPrice = isPlaceholderPrice(cardPrice) ? extractRealPriceFromDescription(input.description || "") : 0;
  const price = detailPrice || cardPrice;
  const listedAgeMinutes = input.listedAgeMinutes ?? parsedCard.listedAgeMinutes ?? null;
  const location = cleanLocation(input.location || extractLocation(input.description || cardText, "", input.description || ""));

  const carousellId = input.id || url.match(/\/p\/[^/]+-(\d+)/)?.[1] || stableId(`${title}-${url}`);
  return {
    carousell_id: `web-${carousellId}`,
    title: title === "Buyer Protection" && parsedCard.title ? parsedCard.title : title,
    description: input.description || "",
    category: inferCategory(input.query || title),
    condition: normalizeCondition(input.condition || parsedCard.condition),
    seller_id: input.sellerId || `web-seller-${stableId(input.sellerName || parsedCard.sellerName || url)}`,
    seller_name: input.sellerName || parsedCard.sellerName || "Carousell seller",
    seller_url: input.sellerUrl || "",
    seller_rating: 0,
    location,
    days_listed: listedAgeMinutes === null ? 0 : Math.max(0, Math.floor(listedAgeMinutes / 1440)),
    listed_age_minutes: listedAgeMinutes,
    listed_at: listedAgeMinutes === null ? null : new Date(Date.now() - listedAgeMinutes * 60 * 1000).toISOString(),
    current_price: price > 99999 ? 0 : price,
    display_price: cardPrice,
    price_source: detailPrice ? "description" : "card",
    image_urls: mergeImageUrls(input.imageUrls),
    carousell_url: url,
    scraped_at: new Date().toISOString()
  };
}

async function enrichListingDetails(browser, listings, limit, options = {}) {
  const seen = new Set();
  const candidates = listings
    .slice(0, limit)
    .filter((listing) => {
      if (!listing.url || seen.has(listing.url)) return false;
      seen.add(listing.url);
      return true;
    });
  const concurrency = Math.max(1, Math.min(3, Number(options.detailConcurrency || 2)));
  const jitterMs = Math.max(0, Number(options.detailJitterMs || 0));
  const enriched = new Array(candidates.length);
  let cursor = 0;

  async function worker() {
    while (cursor < candidates.length) {
      const index = cursor;
      cursor += 1;
      if (jitterMs) await delay(Math.round(Math.random() * jitterMs));
      enriched[index] = await hydrateListingDetail(browser, candidates[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  return enriched.filter(Boolean);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hydrateListingDetail(browser, listing) {
  const parsed = parseCardText(listing.cardText || "");
  let page;
  try {
    page = await browser.newPage({
      locale: "en-SG",
      timezoneId: "Asia/Singapore",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
    });
    await page.goto(listing.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 9000 }).catch(() => {});
    await expandDetailSections(page);
    const details = await readDetailPage(page);
    const seller = extractSellerFromDetails(details, parsed.sellerName);
    const description = extractDescription(details.bodyText, details.metaDescription, parsed.title);
    return {
      ...listing,
      ...parsed,
      sellerName: seller.name || parsed.sellerName,
      sellerId: seller.id || listing.sellerId,
      sellerUrl: seller.url,
      description,
      location: extractLocation(details.bodyText, details.jsonLd, description, details.locationLinks),
      imageUrls: mergeImageUrls(details.imageUrls, listing.imageUrls),
      price: extractRealPriceFromDescription(`${details.bodyText}\n${details.metaDescription}\n${details.jsonLd}`) || listing.price
    };
  } catch {
    return { ...listing, ...parsed };
  } finally {
    await page?.close().catch(() => {});
  }
}

function extractSellerFromDetails(details, fallbackName = "") {
  const links = details.profileLinks || [];
  const candidate = links.find((link) => {
    const name = cleanSellerName(link.text);
    return name && !/carousell|help|support|login|signup/i.test(name);
  });
  if (candidate) {
    const name = cleanSellerName(candidate.text);
    return {
      name,
      id: name ? `carousell-${stableId(name)}` : "",
      url: candidate.href || ""
    };
  }

  const text = `${details.jsonLd || ""}\n${details.bodyText || ""}`;
  const usernameMatch = text.match(/"username"\s*:\s*"([^"]+)"/i) || text.match(/"name"\s*:\s*"([^"]+)"/i);
  const name = cleanSellerName(usernameMatch?.[1] || fallbackName);
  return {
    name,
    id: name ? `carousell-${stableId(name)}` : "",
    url: ""
  };
}

function cleanSellerName(value) {
  return (
    String(value || "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !/^\d/.test(line) && !/followers?|following|reviews?|verified/i.test(line)) || ""
  );
}

export function parseCardText(cardText) {
  const lines = String(cardText)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(buyer protection|instantbuy|chat|like|share|preferred|spotlight|bumped)$/i.test(line));

  const priceIndex = lines.findIndex((line) => /(?:S\$|\$|SGD)\s?[\d,]+/i.test(line));
  const timeIndex = lines.findIndex((line) => parseListedAgeMinutes(line) !== null);
  const sellerName = timeIndex > 0 ? lines[0] : lines[0] && priceIndex > 2 ? lines[0] : "";
  const title = priceIndex > 0 ? lines[priceIndex - 1] : cleanTitle(lines.slice(timeIndex + 1).join("\n"), cardText);
  const condition = priceIndex >= 0 ? lines.slice(priceIndex + 1).find((line) => /new|used|condition|well used|lightly used/i.test(line)) : "";

  return {
    sellerName,
    title,
    condition,
    listedAgeMinutes: timeIndex >= 0 ? parseListedAgeMinutes(lines[timeIndex]) : null
  };
}

function parseListedAgeMinutes(value) {
  const text = String(value || "").toLowerCase();
  if (/just now|seconds? ago|sec ago/.test(text)) return 0;
  const match = text.match(/(\d+)\s*(minute|min|hour|day|week|month|year)s?\s*ago/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit.startsWith("min")) return amount;
  if (unit.startsWith("hour")) return amount * 60;
  if (unit.startsWith("day")) return amount * 1440;
  if (unit.startsWith("week")) return amount * 10080;
  if (unit.startsWith("month")) return amount * 43200;
  if (unit.startsWith("year")) return amount * 525600;
  return null;
}

export function extractDescription(bodyText, metaDescription, title) {
  const lines = String(bodyText || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const descriptionIndex = lines.findIndex((line) => /^description$/i.test(line));
  if (descriptionIndex >= 0) {
    const sectionLines = lines.slice(descriptionIndex + 1);
    const stopIndex = sectionLines.findIndex((line) =>
      /^(meet-up|delivery|payment|seller information|report listing|similar listings|deal method|posted in|description)$/i.test(line)
    );
    const description = cleanDescriptionText((stopIndex >= 0 ? sectionLines.slice(0, stopIndex) : sectionLines).join("\n"), title);
    if (description) return description;
  }

  const titleIndex = lines.findIndex((line) => title && line.toLowerCase() === title.toLowerCase());
  const afterTitle = titleIndex >= 0 ? lines.slice(titleIndex + 1) : lines;
  const stopIndex = afterTitle.findIndex((line) => /^(meet-up|delivery|payment|seller information|report listing|similar listings)$/i.test(line));
  const descriptionLines = (stopIndex >= 0 ? afterTitle.slice(0, stopIndex) : afterTitle)
    .filter((line) => !/^(S\$|\$|SGD)\s?[\d,]+/i.test(line))
    .filter((line) => !/^(brand new|like new|lightly used|well used|heavily used|new)$/i.test(line))
    .filter((line) => !/^\d+ (minute|min|hour|day|week|month|year)s? ago$/i.test(line));
  const fullDescription = cleanDescriptionText(descriptionLines.join("\n"), title);
  if (fullDescription) return fullDescription;

  const meta = String(metaDescription || "").trim();
  return meta && !meta.toLowerCase().includes("carousell") ? cleanDescriptionText(meta, title) : "";
}

export function extractLocation(bodyText = "", jsonText = "", description = "", locationLinks = []) {
  const linkedLocation = extractLocationFromLinks(locationLinks);
  if (linkedLocation) return linkedLocation;

  const jsonLocation = extractLocationFromJson(jsonText);
  if (jsonLocation) return jsonLocation;

  const lines = String(bodyText || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const meetUpIndex = lines.findIndex((line) => /^(meet[-\s]?up|pickup|pick up|self collection)$/i.test(line));
  if (meetUpIndex >= 0) {
    const location = extractLocationAfterHeading(lines, meetUpIndex);
    if (location) return location;
  }

  const dealMethodIndex = lines.findIndex((line) => /^deal method$/i.test(line));
  if (dealMethodIndex >= 0) {
    const meetUpAfterDeal = lines.slice(dealMethodIndex + 1).findIndex((line) => /^meet[-\s]?up$/i.test(line));
    if (meetUpAfterDeal >= 0) {
      const location = extractLocationAfterHeading(lines, dealMethodIndex + 1 + meetUpAfterDeal);
      if (location) return location;
    }
  }

  return extractLocationFromText(`${description}\n${bodyText}`);
}

function extractLocationAfterHeading(lines, headingIndex) {
  const sectionLines = lines.slice(headingIndex + 1);
  const stopIndex = sectionLines.findIndex((line) =>
    /^(delivery|payment|faq|description|seller information|meet the seller|report listing|similar listings|deal method|returns and refunds|buyer protection|safety policy|make offer|chat)$/i.test(line)
  );
  return cleanLocation((stopIndex >= 0 ? sectionLines.slice(0, stopIndex) : sectionLines).join(" "));
}

function extractLocationFromLinks(locationLinks) {
  for (const link of locationLinks || []) {
    const textLocation = cleanLocation(link.text);
    if (textLocation) return textLocation;
    const hrefLocation = decodeURIComponent(String(link.href || "")).match(/\/maps\/place\/([^/?]+)/i)?.[1]?.replace(/\+/g, " ");
    const location = cleanLocation(hrefLocation || "");
    if (location) return location;
  }
  return "";
}

function extractLocationFromJson(jsonText) {
  const text = String(jsonText || "");
  const matches = [
    text.match(/"addressLocality"\s*:\s*"([^"]+)"/i),
    text.match(/"addressRegion"\s*:\s*"([^"]+)"/i),
    text.match(/"location"\s*:\s*"([^"]+)"/i)
  ];
  return cleanLocation(matches.find(Boolean)?.[1] || "");
}

function extractLocationFromText(text) {
  const source = String(text || "");
  const patterns = [
    /\b(?:self\s+collect|collect|collection|pickup|pick\s+up)\s+(?:at|near|around|from|in)?\s*([^.\n;]{3,90})/i,
    /\b(?:meetup|meet-up|meet up)\s+(?:at|near|around|from|in)?\s*([^.\n;]{3,90})/i,
    /\b(?:deal|dealing)\s+(?:at|near|around|from|in)\s+([^.\n;]{3,90})/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    const location = cleanLocation(match?.[1] || "");
    if (location) return location;
  }
  return "";
}

function cleanLocation(value) {
  const text = String(value || "")
    .replace(/\b(?:can deliver|delivery|deliver to|can negotiate|negotiable|chat|dm|pm|read more)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:,-]+|[\s:,-]+$/g, "")
    .trim();
  if (!text || text.length < 3 || text.length > 90) return "";
  if (/^(singapore|carousell sg|meet-up|delivery|payment|read more)$/i.test(text)) return "";
  if (/^(my place|my convenience|my preferred station)$/i.test(text)) return "";
  return text;
}

async function readDetailPage(page) {
  return page.evaluate(() => {
    const bodyText = document.body.innerText || "";
    const metaDescription = document.querySelector('meta[name="description"]')?.content || "";
    const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map((script) => script.textContent || "")
      .join("\n");
    const profileLinks = [...document.querySelectorAll('a[href^="/u/"], a[href*="/u/"]')].map((anchor) => ({
      text: anchor.textContent?.trim() || "",
      href: anchor.href || ""
    }));
    const locationLinks = [...document.querySelectorAll('a[href*="google.com/maps"], a[href*="maps.google"], a[href*="/maps/place/"]')].map((anchor) => ({
      text: anchor.textContent?.trim() || "",
      href: anchor.href || ""
    }));
    const imageUrls = collectPageImageUrls();
    return { bodyText, metaDescription, jsonLd, profileLinks, locationLinks, imageUrls };

    function collectPageImageUrls() {
      const urls = [];
      const add = (value) => {
        if (!value) return;
        for (const candidate of String(value).split(",")) {
          const url = candidate.trim().split(/\s+/)[0].replace(/^['"]|['"]$/g, "");
          if (url && !urls.includes(url)) urls.push(url);
        }
      };
      document.querySelectorAll("img, source").forEach((image) => {
        add(image.currentSrc);
        add(image.src);
        add(image.srcset);
        add(image.getAttribute("data-src"));
        add(image.getAttribute("data-original"));
        add(image.getAttribute("data-lazy-src"));
      });
      document.querySelectorAll("meta[property='og:image'], meta[name='twitter:image']").forEach((meta) => add(meta.getAttribute("content")));
      document.querySelectorAll("[style*='background']").forEach((element) => {
        const match = String(element.getAttribute("style") || "").match(/url\((['"]?)(.*?)\1\)/i);
        add(match?.[2]);
      });
      try {
        const json = JSON.parse((document.querySelector("#__NEXT_DATA__")?.textContent || "{}").trim());
        visit(json);
      } catch {}
      return urls;

      function visit(value) {
        if (!value || urls.length >= 12) return;
        if (typeof value === "string") {
          add(value);
          return;
        }
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
        if (typeof value === "object") Object.values(value).forEach(visit);
      }
    }
  });
}

async function expandDetailSections(page) {
  const readMore = page.getByText(/^Read more$/i);
  const count = await readMore.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 6); index += 1) {
    const target = readMore.nth(index);
    if (!(await target.isVisible().catch(() => false))) continue;
    await target.click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(250);
  }
}

async function newBrowserPage(options = {}) {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error("playwright-core is not installed. Run npm.cmd install.");
  }

  const executablePath = options.executablePath || (await findChromePath());
  if (!executablePath) {
    throw new Error("Chrome or Chromium was not found. Install Google Chrome in the Linux environment or set CHROME_PATH to your Chrome executable.");
  }

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"]
  });
  const page = await browser.newPage({
    locale: "en-SG",
    timezoneId: "Asia/Singapore",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
  });
  return { browser, page };
}

export function extractRealPriceFromDescription(description) {
  const text = String(description || "");
  const patterns = [
    /(?:real|actual|selling|letting go|take|deal|price|asking|each|all for)\s*(?:price)?\s*(?:is|at|:|-)?\s*(?:S\$|SGD|US\$|USD|\$)\s?([\d,]+(?:\.\d+)?)/i,
    /(?:S\$|SGD|US\$|USD|\$)\s?([\d,]+(?:\.\d+)?)\s*(?:firm|fixed|nett|each|for all|only)?/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const context = text.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40);
    if (/\b(?:deliver|delivery|shipping|courier|postage|additional|deposit|top up|top-up)\b/i.test(context)) continue;
    const money = parseMoney(match[0], { defaultCurrency: /\b(?:usd|us\$)\b/i.test(context) ? "USD" : "SGD" });
    const price = money.sgd || Math.round(Number(match[1].replaceAll(",", "")));
    if (price > 1 && price < 100000) return price;
  }
  return 0;
}

function isPlaceholderPrice(price) {
  return [0, 1, 8, 88, 888, 8888, 9999, 12345].includes(Number(price));
}

function normalizeCondition(value) {
  const text = String(value || "").toLowerCase();
  if (/like new|lightly used/.test(text)) return "like_new";
  if (/brand new|new/.test(text)) return "new";
  if (/well used|used/.test(text)) return "good";
  if (/heavily used|fair/.test(text)) return "fair";
  return "unknown";
}

function cleanDescriptionText(value, title) {
  const escapedTitle = escapeRegExp(title || "");
  return String(value || "")
    .replace(new RegExp(`^Buy\\s+${escapedTitle}\\s+in\\s+Singapore,?\\s*Singapore\\.\\s*`, "i"), "")
    .replace(/^Buy\s+.+?\s+in\s+Singapore,?\s*Singapore\.\s*/i, "")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function extractStructuredLocation(value) {
  const candidates = [
    value.location,
    value.locationName,
    value.location_name,
    value.meetupLocation,
    value.meetup_location,
    value.areaName,
    value.area_name,
    value.address
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const location = cleanLocation(candidate);
      if (location) return location;
    }
    if (candidate && typeof candidate === "object") {
      const location = cleanLocation(
        firstString(candidate.name, candidate.address, candidate.formattedAddress, candidate.formatted_address, candidate.locationName, candidate.areaName)
      );
      if (location) return location;
    }
  }
  return "";
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
  return parseMoney(value).sgd;
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
