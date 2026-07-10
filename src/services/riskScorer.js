const PLACEHOLDER_PRICES = new Set([0, 1, 8, 12, 88, 111, 123, 888, 8888, 9999, 12345, 99999]);
const RISK_KEYWORDS = [
  { pattern: /\bdeposit\b/i, reason: "Mentions deposit" },
  { pattern: /\btelegram\b|\btg\b/i, reason: "Pushes Telegram contact" },
  { pattern: /\bwhats?app\s+only\b|\bwa\s+only\b/i, reason: "WhatsApp-only contact" },
  { pattern: /\bpaynow\s+first\b|\bpay\s*now\s+first\b/i, reason: "Asks for PayNow first" },
  { pattern: /\bdelivery\s+only\b/i, reason: "Delivery only" },
  { pattern: /\bno\s+meetups?\b|\bno\s+meet\s*ups?\b/i, reason: "No meetups" },
  { pattern: /\bdm\s+for\s+price\b/i, reason: "DM for price" },
  { pattern: /\bpm\s+for\s+price\b/i, reason: "PM for price" },
  { pattern: /\bprice\s+on\s+request\b|\bpoa\b/i, reason: "Price hidden" }
];

export function scoreListingRisk(listing, { market = {}, duplicate = {}, filters = [] } = {}) {
  const reasons = [];
  let riskScore = 0;
  const price = Number(listing.current_price || 0);
  const text = listingText(listing);

  if (PLACEHOLDER_PRICES.has(price) || price <= 0) {
    riskScore += 28;
    reasons.push(`Placeholder price S$${Number(price || 0).toLocaleString("en-SG")}`);
  }

  if (market.priceRatio !== null && market.priceRatio !== undefined && market.median > 0 && price > 0) {
    if (market.priceRatio <= 0.3) {
      riskScore += 34;
      reasons.push(`${Math.abs(market.priceDeltaPercent)}% below market median`);
    } else if (market.priceRatio <= 0.45) {
      riskScore += 22;
      reasons.push(`${Math.abs(market.priceDeltaPercent)}% below market median`);
    } else if (market.priceRatio <= 0.6) {
      riskScore += 10;
      reasons.push("Unusually low vs market median");
    }
  }

  for (const keyword of RISK_KEYWORDS) {
    if (keyword.pattern.test(text)) {
      riskScore += 14;
      reasons.push(keyword.reason);
    }
  }

  for (const match of configuredRiskMatches(text, filters)) {
    riskScore += 8;
    reasons.push(`Configured risky keyword: ${match}`);
  }

  const descriptionLength = String(listing.description || "").replace(/\s+/g, " ").trim().length;
  if (descriptionLength === 0) {
    riskScore += 16;
    reasons.push("Missing description");
  } else if (descriptionLength < 35) {
    riskScore += 10;
    reasons.push("Very short description");
  }

  if (!hasListingImages(listing)) {
    riskScore += 12;
    reasons.push("Missing listing images");
  }

  const sellerRisk = sellerTrustRisk(listing);
  riskScore += sellerRisk.penalty;
  reasons.push(...sellerRisk.reasons);

  if (duplicate.count > 1) {
    const penalty = duplicate.role === "secondary" ? 16 : 8;
    riskScore += penalty;
    reasons.push(duplicate.role === "secondary" ? "Likely repost/duplicate secondary listing" : "Similar duplicate listings detected");
  }

  return {
    riskScore: clampScore(riskScore),
    riskReasons: [...new Set(reasons)].slice(0, 8),
    riskLevel: riskLevel(riskScore)
  };
}

export function riskLevel(score) {
  const value = Number(score || 0);
  if (value >= 55) return "high";
  if (value >= 25) return "medium";
  return "low";
}

function sellerTrustRisk(listing) {
  const reasons = [];
  let penalty = 0;
  const rating = Number(listing.seller_rating || 0);
  const reviewCount = firstNumber(listing.seller_review_count, listing.review_count, listing.seller_reviews, listing.reviews_count, listing.feedback_count);

  if (reviewCount !== null && reviewCount <= 2) {
    penalty += 12;
    reasons.push("Seller has few reviews");
  } else if (reviewCount === null && rating <= 0) {
    penalty += 8;
    reasons.push("Seller review history unavailable");
  }

  if (rating > 0 && rating < 4) {
    penalty += 10;
    reasons.push("Seller rating is low");
  }

  if (isNewSeller(listing)) {
    penalty += 12;
    reasons.push("Seller account appears new");
  }

  return { penalty, reasons };
}

function configuredRiskMatches(text, filters) {
  return (filters || [])
    .filter((filter) => ["blacklist", "spam_keyword", "bad_pricer"].includes(String(filter.type || "")))
    .map((filter) => String(filter.phrase || "").trim().toLowerCase())
    .filter((phrase) => phrase && text.includes(phrase));
}

function hasListingImages(listing) {
  return [
    ...(Array.isArray(listing.image_urls) ? listing.image_urls : []),
    ...(Array.isArray(listing.original_image_urls) ? listing.original_image_urls : []),
    listing.primary_image,
    listing.thumbnail_url
  ].some(Boolean);
}

function isNewSeller(listing) {
  const created = listing.seller_created_at || listing.seller_joined_at || listing.seller_since;
  if (!created) return false;
  const timestamp = new Date(created).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp < 30 * 24 * 60 * 60 * 1000;
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function listingText(listing) {
  return `${listing.title || ""} ${listing.description || ""} ${listing.category || ""}`.toLowerCase();
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}
