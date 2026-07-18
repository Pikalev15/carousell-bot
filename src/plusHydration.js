const CAROUSELL_BASE_URL = "https://www.carousell.sg";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const EXCLUDED_IMAGE_PATTERN = /(avatar|profile[-_]?(pic|photo|image)|user[-_]?icon|placeholder|sprite|favicon|\blogo\b|blank\.gif|1x1|loading[-_]?spinner|badge|star-rating|verified-icon)/i;

let sharedBrowser = null;
let sharedBrowserPromise = null;
let cleanupHooksInstalled = false;

export async function hydrateCarousellListings(listings, options = {}) {
  const candidates = Array.isArray(listings) ? listings.filter((listing) => normalizeUrl(listing.carousell_url || listing.url)) : [];
  if (!candidates.length) return [];

  const browser = await getSharedBrowser();
  const concurrency = Math.max(1, Math.min(4, Number(options.concurrency || 2)));
  const jitterMs = Math.max(0, Number(options.jitterMs || 0));
  const maxAttempts = Math.max(1, Math.min(3, Number(options.maxAttempts || 1)));
  const hydrated = new Array(candidates.length);
  let cursor = 0;

  async function worker() {
    while (cursor < candidates.length) {
      const index = cursor;
      cursor += 1;
      if (jitterMs) await delay(Math.round(Math.random() * jitterMs));
      let result;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        result = await hydrateOne(browser, candidates[index]);
        if (!result?.hydration_error_at || attempt === maxAttempts) break;
        await delay(250 * attempt);
      }
      hydrated[index] = result;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  return hydrated.filter(Boolean);
}

async function getSharedBrowser() {
  if (sharedBrowser?.isConnected?.()) return sharedBrowser;
  if (sharedBrowserPromise) return sharedBrowserPromise;

  sharedBrowserPromise = launchSharedBrowser();
  return sharedBrowserPromise;
}

async function launchSharedBrowser() {
  try {
    const { chromium } = await importPlaywright();
    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"]
    });
    sharedBrowser = browser;
    installCleanupHooks();
    browser.on?.("disconnected", () => {
      if (sharedBrowser === browser) sharedBrowser = null;
      if (sharedBrowserPromise) sharedBrowserPromise = null;
    });
    return browser;
  } catch (error) {
    sharedBrowser = null;
    sharedBrowserPromise = null;
    throw error;
  }
}

async function closeSharedBrowser() {
  const browserPromise = sharedBrowserPromise;
  const browser = sharedBrowser || await browserPromise?.catch(() => null);
  sharedBrowser = null;
  sharedBrowserPromise = null;
  if (browser?.isConnected?.()) await browser.close().catch(() => {});
}

function installCleanupHooks() {
  if (cleanupHooksInstalled) return;
  cleanupHooksInstalled = true;
  process.once("beforeExit", () => {
    closeSharedBrowser().catch(() => {});
  });
  process.once("SIGINT", () => {
    closeSharedBrowser().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    closeSharedBrowser().finally(() => process.exit(143));
  });
}

async function hydrateOne(browser, listing) {
  let page;
  try {
    page = await browser.newPage({ locale: "en-SG", timezoneId: "Asia/Singapore", userAgent: USER_AGENT });
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media" || type === "font") return route.abort();
      return route.continue();
    });
    await page.goto(normalizeUrl(listing.carousell_url || listing.url), { waitUntil: "domcontentloaded", timeout: 18000 });
    await page.waitForFunction(() => (document.body?.innerText || "").length > 400, { timeout: 3500 }).catch(() => {});
    await page.waitForTimeout(250);
    await expandDetailSections(page);
    const details = await readDetailPage(page);
    const seller = extractSellerFromDetails(details, listing.seller_name);
    const description = extractDescription(details.bodyText, details.metaDescription, listing.title);
    const likeCount = extractLikeCount(details);
    return {
      ...listing,
      description: description || listing.description || "",
      seller_name: seller.name || listing.seller_name,
      seller_id: seller.id || listing.seller_id,
      seller_url: seller.url || listing.seller_url || "",
      location: extractLocation(details.bodyText, details.jsonLd, description, details.locationLinks) || listing.location || "",
      current_price: listing.display_price || listing.current_price,
      price_source: "card",
      like_count: likeCount,
      likes_count: likeCount,
      favourite_count: likeCount,
      favorite_count: likeCount,
      image_urls: mergeImageUrls(details.imageUrls, listing.image_urls),
      details_scraped_at: new Date().toISOString(),
      scraped_at: new Date().toISOString()
    };
  } catch (error) {
    return {
      ...listing,
      hydration_error_at: new Date().toISOString(),
      hydration_error: String(error?.message || "Listing detail hydration failed").slice(0, 240)
    };
  } finally {
    await page?.close().catch(() => {});
  }
}

async function readDetailPage(page) {
  return page.evaluate(() => {
    const bodyText = document.body.innerText || "";
    const metaDescription = document.querySelector('meta[name="description"]')?.content || "";
    const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')].map((script) => script.textContent || "").join("\n");
    const jsonText = [...document.querySelectorAll("script")].map((script) => script.textContent || "").join("\n");
    const profileLinks = [...document.querySelectorAll('a[href^="/u/"], a[href*="/u/"]')].map((anchor) => ({ text: anchor.textContent?.trim() || "", href: anchor.href || "" }));
    const locationLinks = [...document.querySelectorAll('a[href*="google.com/maps"], a[href*="maps.google"], a[href*="/maps/place/"]')].map((anchor) => ({ text: anchor.textContent?.trim() || "", href: anchor.href || "" }));
    const likeTexts = collectLikeTexts();
    const imageUrls = collectPageImageUrls();
    return { bodyText, metaDescription, jsonLd, jsonText, profileLinks, locationLinks, likeTexts, imageUrls };

    function collectLikeTexts() {
      const values = [];
      const push = (value) => {
        const text = String(value || "").replace(/\s+/g, " ").trim();
        if (text && /like|favo[u]?rite|saved/i.test(text) && !values.includes(text)) values.push(text);
      };
      document.querySelectorAll("[aria-label], [title], button, span, div").forEach((element) => {
        push(element.getAttribute("aria-label"));
        push(element.getAttribute("title"));
        push(element.getAttribute("data-testid"));
        push(element.textContent);
      });
      return values.slice(0, 80);
    }

    function collectPageImageUrls() {
      const urls = [];
      const add = (value) => {
        if (!value) return;
        for (const candidate of String(value).split(",")) {
          const url = candidate.trim().split(/\s+/)[0].replace(/^["']|["']$/g, "");
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
        const match = String(element.getAttribute("style") || "").match(/url\((["']?)(.*?)\1\)/i);
        add(match?.[2]);
      });
      return urls;
    }
  });
}

function extractLikeCount(details = {}) {
  const sources = [
    ...(Array.isArray(details.likeTexts) ? details.likeTexts : []),
    details.jsonText || "",
    details.jsonLd || "",
    details.bodyText || "",
    details.metaDescription || ""
  ];
  const joined = sources.join("\n");
  const jsonMatch = joined.match(/"(?:likeCount|likesCount|like_count|likes_count|favoriteCount|favouriteCount|favorite_count|favourite_count|favoritesCount|favouritesCount)"\s*:\s*"?(\d+(?:\.\d+)?\s*[kKmM]?)"?/);
  if (jsonMatch) return parseCompactCount(jsonMatch[1]);

  const patterns = [
    /(\d+(?:[,.]\d+)?\s*[kKmM]?)\s*(?:likes?|liked|favorites?|favourites?|saved)\b/i,
    /\b(?:likes?|liked|favorites?|favourites?|saved)\s*(\d+(?:[,.]\d+)?\s*[kKmM]?)/i
  ];
  for (const source of sources) {
    const text = String(source || "");
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return parseCompactCount(match[1]);
    }
  }
  return 0;
}

function parseCompactCount(value) {
  const text = String(value || "").replace(/,/g, "").trim().toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!match) return 0;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return 0;
  const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  return Math.round(number * multiplier);
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

function extractSellerFromDetails(details, fallbackName = "") {
  const links = details.profileLinks || [];
  const candidate = links.find((link) => {
    const name = cleanSellerName(link.text);
    return name && !/carousell|help|support|login|signup/i.test(name);
  });
  if (candidate) {
    const name = cleanSellerName(candidate.text);
    return { name, id: name ? `carousell-${stableId(name)}` : "", url: candidate.href || "" };
  }
  const text = `${details.jsonLd || ""}\n${details.bodyText || ""}`;
  const usernameMatch = text.match(/"username"\s*:\s*"([^"]+)"/i) || text.match(/"name"\s*:\s*"([^"]+)"/i);
  const name = cleanSellerName(usernameMatch?.[1] || fallbackName);
  return { name, id: name ? `carousell-${stableId(name)}` : "", url: "" };
}

function cleanSellerName(value) {
  return (
    String(value || "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !/^\d/.test(line) && !/followers?|following|reviews?|verified/i.test(line)) || ""
  );
}

function extractDescription(bodyText, metaDescription, title) {
  const lines = String(bodyText || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const descriptionIndex = lines.findIndex((line) => /^description$/i.test(line));
  if (descriptionIndex >= 0) {
    const sectionLines = lines.slice(descriptionIndex + 1);
    const stopIndex = sectionLines.findIndex((line) => /^(meet-up|delivery|payment|seller information|report listing|similar listings|deal method|posted in|description)$/i.test(line));
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

function extractLocation(bodyText = "", jsonText = "", description = "", locationLinks = []) {
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
  return extractLocationFromFreeText(description || bodyText);
}

function extractLocationAfterHeading(lines, headingIndex) {
  const stop = /^(delivery|payment|seller information|buyer protection|description|deal method|report listing|similar listings)$/i;
  const locationLines = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (stop.test(line)) break;
    if (/^(meet[-\s]?up|pickup|pick up|self collection)$/i.test(line)) continue;
    const cleaned = cleanLocation(line);
    if (cleaned) locationLines.push(cleaned);
    if (locationLines.length >= 2) break;
  }
  return cleanLocation(locationLines.join(" "));
}

function extractLocationFromLinks(locationLinks = []) {
  for (const link of locationLinks) {
    if (!/maps|google/i.test(link.href || "")) continue;
    const location = cleanLocation(link.text);
    if (location) return location;
  }
  return "";
}

function extractLocationFromJson(jsonText = "") {
  const text = String(jsonText || "");
  const match = text.match(/"(?:address|location|name)"\s*:\s*"([^"]{3,90})"/i);
  return cleanLocation(match?.[1] || "");
}

function extractLocationFromFreeText(value = "") {
  const source = String(value || "");
  const patterns = [
    /\b(?:self collect|collection|pickup|pick up)\s*(?:at|near|around|from|in)?\s*([^.,\n;]{3,90})/i,
    /\b(?:meetup|meet-up|meet up)\s+(?:at|near|around|from|in)?\s*([^.,\n;]{3,90})/i,
    /\b(?:deal|dealing)\s+(?:at|near|around|from|in)\s+([^.,\n;]{3,90})/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    const location = cleanLocation(match?.[1] || "");
    if (location) return location;
  }
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

function normalizeImageUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${CAROUSELL_BASE_URL}${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  return "";
}

function normalizeUrl(url) {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  if (url.startsWith("/")) return `${CAROUSELL_BASE_URL}${url}`;
  return "";
}

function cleanDescriptionText(value, title) {
  const escapedTitle = escapeRegExp(title || "");
  return String(value || "")
    .replace(new RegExp(`^Buy\\s+${escapedTitle}\\s+in\\s+Singapore,?\\s*Singapore\\.\\s*`, "i"), "")
    .replace(/^Buy\s+.+?\s+in\s+Singapore,?\s*Singapore\.\s*/i, "")
    .trim();
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

async function importPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("playwright is not installed. Run npm install.");
  }
}

function stableId(value) {
  let hash = 0;
  for (const char of String(value || "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
