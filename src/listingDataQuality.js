const CAROUSELL_BASE_URL = "https://www.carousell.sg";

const BAD_IMAGE_PATTERN = /\b(?:profiles?|avatar|profile[-_]?(?:pic|photo|image)|user[-_]?icon|placeholder|sprite|favicon|logo|blank\.gif|1x1|spinner|badge|star-rating|verified-icon|seller|pfp)\b/i;
const PRODUCT_IMAGE_HINT = /\b(?:products?|listing|photos?|media|karousell|carousell)\b/i;

export function parseStartUrls(input) {
  const rawUrls = Array.isArray(input)
    ? input.flatMap((item) => typeof item === "string" ? item : [item?.url || ""])
    : String(input || "").split(/\n+/);
  const items = rawUrls.map((item) => parseCarousellUrl(item)).filter(Boolean);
  const kinds = new Set(items.map((item) => item.kind));
  return {
    items,
    primary: items[0] || null,
    mode: items.length === 0 ? "query" : kinds.size > 1 ? "mixed" : items[0].kind
  };
}

export function parseCarousellUrl(raw) {
  try {
    const url = new URL(String(raw || "").trim());
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (!/^carousell\.(sg|com|ph|my|tw|hk|co\.id)$/.test(host)) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    const searchIndex = segments.indexOf("search");
    const categoryIndex = segments.indexOf("categories");
    const listingIndex = segments.indexOf("p");
    let kind = "start_url";
    let query = "";

    if (searchIndex >= 0 && segments[searchIndex + 1]) {
      kind = "query";
      query = cleanSlug(segments[searchIndex + 1], { keepModelNumbers: true });
    } else if (categoryIndex >= 0) {
      kind = "category_url";
      query = bestCategoryQuery(segments.slice(categoryIndex + 1));
    } else if (listingIndex >= 0 || /\/p\//.test(url.pathname)) {
      kind = "listing_url";
      query = cleanSlug(segments[listingIndex + 1] || segments.at(-1), { keepModelNumbers: true });
    } else if (segments.length) {
      kind = "category_url";
      query = bestCategoryQuery(segments);
    }

    return {
      url: url.toString(),
      kind,
      query,
      filters: {
        min_price: url.searchParams.get("price_start") || "",
        max_price: url.searchParams.get("price_end") || "",
        location: url.searchParams.get("location_name") || "",
        range: url.searchParams.get("range") || "",
        condition: url.searchParams.get("condition_v2") || "",
        sort_by: url.searchParams.get("sort_by") || ""
      }
    };
  } catch {
    return null;
  }
}

export function searchBodyFromStartUrls(body = {}) {
  const parsed = parseStartUrls(body.startUrls || body.start_urls || body.start_url || body.url || "");
  if (!parsed.primary) return body;
  const primary = parsed.primary;
  const options = body.search_options || body.options || {};
  return {
    ...body,
    query: String(body.query || primary.query || "").trim(),
    startUrls: parsed.items,
    start_url_mode: parsed.mode,
    min_price: body.min_price ?? primary.filters.min_price ?? "",
    max_price: body.max_price ?? primary.filters.max_price ?? "",
    location: body.location || primary.filters.location || "",
    search_options: {
      ...options,
      condition: options.condition || primary.filters.condition || "",
      range: options.range || primary.filters.range || "",
      sort_by: options.sort_by || primary.filters.sort_by || ""
    }
  };
}

export function buildCarousellSearchUrl(query, options = {}) {
  const params = new URLSearchParams();
  params.set("addRecent", "true");
  params.set("canChangeKeyword", "true");
  params.set("includeSuggestions", "true");
  setParam(params, "condition_v2", options.condition || options.condition_v2);
  setParam(params, "price_start", options.min_price || options.price_start);
  setParam(params, "price_end", options.max_price || options.price_end);
  setParam(params, "location_name", options.location || options.location_name);
  setParam(params, "range", options.range);
  setParam(params, "sort_by", options.sort_by);
  return `${CAROUSELL_BASE_URL}/search/${encodeURIComponent(String(query || "").trim() || "search")}?${params.toString()}`;
}

export function enrichListingData(listing = {}) {
  const sourceText = `${listing.title || ""} ${listing.description || ""} ${listing.category || ""}`;
  const category = inferListingCategory(sourceText, listing.category);
  const imageUrls = cleanImageUrls(listing.image_urls || listing.original_image_urls || []);
  const variations = mergeVariations(listing.variations, extractVariations({ ...listing, category }));
  const completeness = dataCompleteness({ ...listing, category, image_urls: imageUrls, variations });
  const qualityFlags = listingQualityFlags({ ...listing, category, image_urls: imageUrls, variations, data_completeness: completeness });
  return {
    ...listing,
    category,
    categories: Array.isArray(listing.categories) && listing.categories.length ? listing.categories : categoryPath(category),
    image_urls: imageUrls,
    primary_image: imageUrls[0] || "",
    variations,
    data_completeness: completeness,
    quality_flags: qualityFlags
  };
}

export function cleanImageUrls(urls = []) {
  const normalized = [];
  for (const raw of urls) {
    const url = normalizeImageUrl(raw);
    if (!url || normalized.includes(url)) continue;
    if (isBadImageUrl(url)) continue;
    normalized.push(url);
  }
  return normalized.sort((a, b) => imageScore(b) - imageScore(a)).slice(0, 8);
}

export function isBadImageUrl(url) {
  const lower = String(url || "").toLowerCase();
  if (!lower) return true;
  if (BAD_IMAGE_PATTERN.test(lower)) return true;
  if (/\/u\/|\/user\//i.test(lower)) return true;
  if (/googleusercontent\.com\/.*=s(?:32|40|48|64|80|96|128)(?:-|$)/i.test(lower)) return true;
  return false;
}

export function imageScore(url) {
  const lower = String(url || "").toLowerCase();
  let score = 50;
  if (PRODUCT_IMAGE_HINT.test(lower)) score += 20;
  if (/media\.karousell|media\.carousell/.test(lower)) score += 12;
  if (/\/products?\//.test(lower)) score += 20;
  if (/\.webp|\.jpg|\.jpeg|\.png/.test(lower)) score += 4;
  if (BAD_IMAGE_PATTERN.test(lower)) score -= 120;
  return score;
}

export function normalizeImageUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${CAROUSELL_BASE_URL}${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  return "";
}

export function inferListingCategory(text, fallback = "") {
  const source = String(`${text || ""} ${fallback || ""}`).toLowerCase();
  if (/\b(?:rtx|gtx|radeon|rx\s?\d{3,4}|graphics card|gpu)\b/.test(source)) return "graphics card";
  if (/\b(?:ryzen|intel core|core i[3579]|processor|cpu)\b/.test(source)) return "processor";
  if (/\b(?:motherboard|mobo|b450|b550|x570|a620|b650|z690|z790|am4|am5|lga)\b/.test(source)) return "motherboard";
  if (/\b(?:ram|ddr3|ddr4|ddr5|sodimm|so-dimm|memory)\b/.test(source)) return "memory";
  if (/\b(?:ssd|nvme|m\.2|hdd|hard drive|storage)\b/.test(source)) return "storage";
  if (/\b(?:psu|power supply|\d{3,4}w\b|gold rated|bronze rated)\b/.test(source)) return "power supply";
  if (/\b(?:case|chassis|o11|dan a3|fractal|jonsbo|phanteks|lian li|matx case|atx case|itx case)\b/.test(source)) return "pc case";
  if (/\b(?:fan|fans|sl120|tl120|reverse blade|120mm|140mm)\b/.test(source)) return "pc cooling";
  if (/\b(?:aio|cooler|heatsink|radiator|water cooling)\b/.test(source)) return "pc cooling";
  if (/\b(?:keyboard|mouse|monitor|laptop|macbook|thinkpad|chromebook|phone|iphone|ipad)\b/.test(source)) return "computers & tech";
  return fallback || "general";
}

export function extractVariations(listing = {}) {
  const text = `${listing.title || ""} ${listing.description || ""}`;
  const lower = text.toLowerCase();
  const found = [];
  addMatch(found, "gpu_model", text.match(/\b(?:nvidia\s*)?(rtx|gtx)\s?([234]\d{3})(?:\s?(ti|super))?\b/i), (m) => `${m[1].toUpperCase()} ${m[2]}${m[3] ? ` ${m[3].toUpperCase()}` : ""}`);
  addMatch(found, "gpu_model", text.match(/\b(?:amd\s*)?(rx)\s?([567]\d{3})(?:\s?(xt|gre))?\b/i), (m) => `${m[1].toUpperCase()} ${m[2]}${m[3] ? ` ${m[3].toUpperCase()}` : ""}`);
  addMatch(found, "cpu_model", text.match(/\bryzen\s?([3579])\s?([0-9]{4})(x3d|x|g)?\b/i), (m) => `Ryzen ${m[1]} ${m[2]}${m[3] || ""}`.trim());
  addMatch(found, "cpu_model", text.match(/\b(?:intel\s*)?core\s*i([3579])[-\s]?([0-9]{4,5})([a-z]{0,2})\b/i), (m) => `Core i${m[1]}-${m[2]}${m[3] || ""}`.trim());
  addAll(found, "vram", text.matchAll(/\b(4|6|8|10|12|16|20|24)\s?gb\s*(?:vram|gddr6x?|graphics)\b/gi), (m) => `${m[1]}GB`);
  addAll(found, "ram", text.matchAll(/\b(4|8|16|24|32|48|64|96|128)\s?gb\s*(?:ram|ddr[345]|memory)\b/gi), (m) => `${m[1]}GB`);
  addAll(found, "storage", text.matchAll(/\b(128|256|512)\s?gb\s*(?:ssd|nvme|storage|hdd)?\b|\b([1248])\s?tb\s*(?:ssd|nvme|storage|hdd)?\b/gi), (m) => m[1] ? `${m[1]}GB` : `${m[2]}TB`);
  addMatch(found, "case_size", lower.match(/\b(e-?atx|atx|m-?atx|micro[-\s]?atx|itx|mini[-\s]?itx|sff)\b/i), (m) => m[1].replace("micro", "m").replace(/[\s-]+/g, "").toUpperCase());
  addAll(found, "fan_size", text.matchAll(/\b(120|140)\s?mm\b/gi), (m) => `${m[1]}mm`);
  if (/\breverse\b/i.test(text)) found.push(variation("fan_orientation", "reverse", 0.78, "text"));
  if (/\bnormal\b|\bforward\b/i.test(text)) found.push(variation("fan_orientation", "normal", 0.62, "text"));
  addMatch(found, "psu_wattage", text.match(/\b([4-9]\d{2}|1[0-5]\d{2})\s?w\b/i), (m) => `${m[1]}W`);
  addMatch(found, "phone_storage", text.match(/\b(64|128|256|512)\s?gb\b/i), (m) => `${m[1]}GB`);
  return dedupeVariations(found);
}

export function dataCompleteness(listing = {}) {
  const checks = [
    listing.title,
    Number(listing.current_price || 0) > 0,
    String(listing.description || "").length >= 25,
    listing.seller_name,
    listing.location,
    Array.isArray(listing.image_urls) && listing.image_urls.length > 0,
    listing.condition && listing.condition !== "unknown",
    listing.carousell_url,
    listing.category && listing.category !== "general",
    Array.isArray(listing.variations) && listing.variations.length > 0
  ];
  const passed = checks.filter(Boolean).length;
  return {
    passed,
    total: checks.length,
    percent: Math.round((passed / checks.length) * 100),
    label: `${passed}/${checks.length}`
  };
}

export function listingQualityFlags(listing = {}) {
  const flags = [];
  if (!Array.isArray(listing.image_urls) || listing.image_urls.length === 0) flags.push("missing_product_image");
  if (String(listing.description || "").length < 25) flags.push("thin_description");
  if (!listing.location) flags.push("missing_location");
  if (!listing.category || listing.category === "general") flags.push("unknown_category");
  if (!Array.isArray(listing.variations) || listing.variations.length === 0) flags.push("no_variations_detected");
  if (listing.data_completeness?.percent < 60) flags.push("low_data_completeness");
  return flags;
}

export function flattenListingForExport(listing = {}) {
  const enriched = enrichListingData(listing);
  return {
    id: enriched.id,
    title: enriched.title,
    current_price: enriched.current_price,
    seller_name: enriched.seller_name,
    seller_rating: enriched.seller_rating,
    location: enriched.location,
    condition: enriched.condition,
    category: enriched.category,
    carousell_url: enriched.carousell_url,
    classification: enriched.classification?.post_type || "",
    deal_score: enriched.score?.deal_score ?? "",
    confidence_score: enriched.score?.confidence_score ?? "",
    image_score: enriched.score?.image_score ?? "",
    price_score: enriched.score?.price_score ?? "",
    market_rating: enriched.market_insight?.rating || "",
    risk_flags: stringify(enriched.score?.risk_flags || enriched.quality_flags),
    primary_image: enriched.primary_image,
    categories: stringify(enriched.categories),
    variations: stringify(enriched.variations),
    data_completeness: enriched.data_completeness?.label || "",
    data_completeness_percent: enriched.data_completeness?.percent ?? "",
    scraped_at: enriched.scraped_at || "",
    listed_at: enriched.listed_at || ""
  };
}

export function toCsv(rows = [], columns = null) {
  const actualColumns = columns || Object.keys(rows[0] || {});
  return [actualColumns.join(","), ...rows.map((row) => actualColumns.map((column) => csvCell(row[column])).join(","))].join("\n");
}

export function csvCell(value) {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function setParam(params, key, value) {
  if (value !== undefined && value !== null && String(value).trim() !== "") params.set(key, String(value).trim());
}

function bestCategoryQuery(segments) {
  const cleaned = segments.map((segment) => cleanSlug(segment, { keepModelNumbers: false })).filter(Boolean);
  return cleaned.at(-1) || cleaned.at(0) || "";
}

function cleanSlug(value, options = {}) {
  let text = decodeURIComponent(String(value || ""));
  text = text.replace(/[?#].*$/, "");
  text = text.replace(/-PV?\d+.*$/i, "");
  text = text.replace(/-P\d+.*$/i, "");
  text = text.replace(/-r$/i, "");
  if (!options.keepModelNumbers) text = text.replace(/-\d{2,}$/g, "");
  text = text.replace(/-\d{5,}.*$/g, "");
  return text.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function categoryPath(category) {
  if (["graphics card", "processor", "motherboard", "memory", "storage", "power supply", "pc case", "pc cooling"].includes(category)) return ["Computers & Tech", "Computer Parts", category];
  if (category === "computers & tech") return ["Computers & Tech"];
  return category && category !== "general" ? [category] : [];
}

function variation(name, value, confidence, source) {
  return { name, value, confidence, source };
}

function addMatch(output, name, match, mapValue) {
  if (!match) return;
  output.push(variation(name, mapValue(match), 0.88, "regex"));
}

function addAll(output, name, matches, mapValue) {
  for (const match of matches) output.push(variation(name, mapValue(match), 0.78, "regex"));
}

function mergeVariations(existing, detected) {
  return dedupeVariations([...(Array.isArray(existing) ? existing : []), ...detected]);
}

function dedupeVariations(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.name}:${String(item.value).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return item.value;
  });
}

function stringify(value) {
  if (!value) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}
