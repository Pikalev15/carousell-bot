export const POST_TYPES = {
  WTS: "WTS",
  WTB: "WTB",
  WTF: "WTF",
  SPAM: "SPAM",
  BAD_PRICER: "BAD_PRICER",
  BAD_DEAL: "BAD_DEAL",
  LEARNED_SKIP: "LEARNED_SKIP",
  SELLER_BLOCKED: "SELLER_BLOCKED",
  UNKNOWN: "UNKNOWN"
};

const conditionScore = {
  new: 100,
  like_new: 85,
  good: 60,
  fair: 30,
  unknown: 50
};

const PLACEHOLDER_PRICES = new Set([0, 1, 8, 88, 888, 8888, 9999, 12345, 99999]);
const WTB_SERVICE_PATTERN = /\b(?:wtb|want(?:ing)? to buy|looking to buy|looking for|lf\b|anyone selling|anyone got|we buy|i buy|buying all|buyback|buy back|cashout|trade[\s-]?in|sell(?:ing)? your|send me what you have|pm me if selling|dm me if selling|quote only|repair service|servicing|diagnostic|data recovery|installation service|upgrade service|cleaning service|custom build service|pm for quote)\b/i;
const LOOKING_FOR_PATTERN = /\b(?:searching for|does anyone have|can anyone recommend|recommend me|where to buy|where can i find)\b/i;
const OFF_PLATFORM_SPAM_PATTERN = /\b(?:telegram only|whatsapp only|wa only|paynow first|deposit first|reservation fee|reserve fee|contact me on telegram|contact me on whatsapp)\b/i;
const ACCESSORY_PATTERN = /\b(?:panel|front panel|side panel|glass panel|riser|vertical gpu kit|bracket|mount|cable|adapter|screws?|stand|tray|cover|dust filter|mesh kit|extension|sleeved cable|wood panel|tempered glass only|panel only|upgrade kit)\b/i;
const ACCESSORY_ONLY_PATTERN = /\b(?:panel|front panel|side panel|glass panel|wood panel|riser|vertical gpu kit|bracket|mount|cable|adapter|screws?|stand|tray|cover|dust filter|mesh kit|extension|sleeved cable|tempered glass|upgrade kit)\b.{0,80}\bonly\b|\bonly\b.{0,80}\b(?:panel|riser|bracket|mount|cable|adapter|cover|tray|kit)\b|\bnot\s+(?:the\s+)?full\s+(?:case|pc|build|set)\b/i;
const FULL_PRODUCT_PATTERN = /\b(?:full case|complete case|whole case|case included|full build|complete build|working pc|whole set)\b/i;
const BUNDLE_PATTERN = /\b(?:bundle|full build|whole set|all for|combo|assorted|mixed parts|parts lot|pc parts)\b/i;
const CORE_PART_PATTERN = /\b(?:gpu|graphics card|rtx|gtx|radeon|rx\s?\d{3,4}|cpu|processor|ryzen|core i[3579]|motherboard|mobo|ram|ddr[345]|ssd|nvme|psu|power supply|case|chassis|cooler|aio|fan)\b/i;
const PROFILE_IMAGE_PATTERN = /\b(?:profiles?|avatar|user[-_]?icon|profile[-_]?pic|profile[-_]?photo|seller|pfp)\b/i;

export function classifyListing(listing, filters, sellerBlacklist, config) {
  const text = `${listing.title || ""} ${listing.description || ""}`.toLowerCase();
  const reasons = [];
  const blockedSeller = sellerBlacklist.find((seller) => seller.seller_id === listing.seller_id);

  if (blockedSeller) {
    reasons.push(`Blocked seller: ${blockedSeller.reason || blockedSeller.seller_name}`);
    return result(POST_TYPES.SELLER_BLOCKED, true, 100, reasons);
  }

  const phraseMatches = filters.filter((filter) => text.includes(filter.phrase.toLowerCase()));
  for (const match of phraseMatches) {
    reasons.push(`${match.phrase}: ${match.reason || match.type}`);
  }

  if (isWtbOrServiceListing(text, listing)) {
    reasons.push("WTB/buyback/service language");
    return result(POST_TYPES.WTB, true, 98, reasons);
  }

  if (LOOKING_FOR_PATTERN.test(text)) {
    reasons.push("Looking-for language");
    return result(POST_TYPES.WTF, true, 90, reasons);
  }

  if (OFF_PLATFORM_SPAM_PATTERN.test(text)) {
    reasons.push("Off-platform payment/contact spam pattern");
    return result(POST_TYPES.SPAM, true, 95, reasons);
  }

  const spamMatches = phraseMatches.filter((match) => match.type === "spam_keyword");
  if (spamMatches.length > 0 || hasSuspiciousShape(text, listing)) {
    if (hasSuspiciousShape(text, listing)) reasons.push("Suspicious text or seller pattern");
    return result(POST_TYPES.SPAM, true, Math.min(100, 70 + spamMatches.length * 10), reasons);
  }

  const badPricerReasons = getBadPricerReasons(listing, phraseMatches, config);
  if (badPricerReasons.length > 0) {
    return result(POST_TYPES.BAD_PRICER, true, Math.min(100, 65 + badPricerReasons.length * 10), [
      ...reasons,
      ...badPricerReasons
    ]);
  }

  if (!listing.current_price || listing.current_price <= 0) {
    return result(POST_TYPES.UNKNOWN, true, 50, ["Missing usable price"]);
  }

  return result(POST_TYPES.WTS, false, 0, reasons);
}

export function scoreDeal(listing, config) {
  const price = Number(listing.current_price || 0);
  const median = referenceMedian(listing, config);
  const priceRatio = median > 0 ? price / median : 1;
  const marketConfidence = marketConfidenceScore(listing, median);
  const accessory = isAccessoryListing(listing);
  const bundle = isBundleListing(listing);
  const productImageScore = imageQualityScore(listing);
  const priceScore = computePriceScore(priceRatio, marketConfidence, accessory, bundle, price);
  const sellerScore = computeSellerScore(listing);
  const ageHours = getListingAgeHours(listing);
  const ageScore = Math.max(0, Math.min(100, 100 - ageHours * 1.1));
  const preference = Number(listing.training?.preference_score ?? 50);
  const preferenceScore = Math.max(0, Math.min(100, preference));
  const detailScore = getDetailScore(listing, productImageScore);
  const condition = conditionScore[listing.condition] || 50;
  const confidence = computeConfidence(listing, { median, productImageScore, detailScore, marketConfidence });
  const riskPenalty = getDealPenalty(listing, { median, priceRatio, accessory, bundle, productImageScore, confidence });
  const badDealPenalty = preferenceScore < 35 ? (35 - preferenceScore) * 0.75 : 0;

  const baseScore =
    priceScore * 0.34 +
    condition * 0.1 +
    sellerScore * 0.08 +
    ageScore * 0.08 +
    preferenceScore * 0.18 +
    detailScore * 0.14 +
    productImageScore * 0.08;

  const confidenceAdjustment = confidence >= 75 ? 4 : confidence >= 58 ? 0 : confidence >= 42 ? -7 : -14;
  const score = Math.round(Math.max(0, Math.min(100, baseScore + confidenceAdjustment - badDealPenalty - riskPenalty)));
  const estimatedNegotiationPrice = Math.round(price * (ageHours > 336 ? 0.88 : 0.92));
  const isDeal = score >= (config.dealThreshold || 70) && confidence >= 50 && riskPenalty < 35;

  return {
    deal_score: score,
    is_deal: isDeal,
    price_score: Math.round(priceScore),
    seller_score: Math.round(sellerScore),
    age_score: Math.round(ageScore),
    preference_score: Math.round(preferenceScore),
    detail_score: Math.round(detailScore),
    image_score: Math.round(productImageScore),
    confidence_score: Math.round(confidence),
    penalty: Math.round(badDealPenalty + riskPenalty),
    estimated_negotiation_price: estimatedNegotiationPrice,
    price_vs_median: median > 0 ? Math.round(((price - median) / median) * 100) : null,
    trend_direction: median > 0 && price < median * 0.98 ? "down" : median > 0 && price > median * 1.02 ? "up" : "flat",
    risk_flags: scoreRiskFlags(listing, { accessory, bundle, productImageScore, confidence, median, priceRatio })
  };
}

function referenceMedian(listing, config) {
  const candidates = [listing.market_median, config.categoryMedians?.[listing.category], config.categoryMedians?.electronics];
  return Number(candidates.find((value) => Number(value) > 0) || 0);
}

function computePriceScore(priceRatio, marketConfidence, accessory, bundle, price) {
  if (!Number.isFinite(priceRatio) || priceRatio <= 0 || price <= 0) return 25;
  let score;
  if (priceRatio <= 0.35) score = 96;
  else if (priceRatio <= 0.5) score = 90;
  else if (priceRatio <= 0.65) score = 82;
  else if (priceRatio <= 0.8) score = 70;
  else if (priceRatio <= 1) score = 55;
  else if (priceRatio <= 1.18) score = 38;
  else score = 18;

  if (marketConfidence < 45) score = score * 0.72 + 12;
  if (accessory) score = Math.min(score, 62);
  if (bundle) score = Math.min(score, 72);
  if (price <= 15 && !bundle) score = Math.min(score, 55);
  return Math.max(0, Math.min(100, score));
}

function computeSellerScore(listing) {
  const rating = Number(listing.seller_rating || 0);
  if (rating <= 0) return listing.seller_url ? 42 : 30;
  return Math.min(100, rating * 20);
}

function marketConfidenceScore(listing, median) {
  if (!median) return 20;
  const sampleSize = Number(listing.market_insight?.sample_size || listing.market_sample_size || 0);
  if (sampleSize >= 12) return 95;
  if (sampleSize >= 7) return 82;
  if (sampleSize >= 4) return 66;
  return 45;
}

function getDetailScore(listing, productImageScore = imageQualityScore(listing)) {
  let score = 25;
  const descriptionLength = String(listing.description || "").length;
  if (descriptionLength >= 220) score += 25;
  else if (descriptionLength >= 80) score += 18;
  else if (descriptionLength >= 25) score += 8;
  if (listing.location) score += 12;
  if (listing.seller_url) score += 8;
  if (productImageScore >= 70) score += 15;
  else if (productImageScore >= 45) score += 6;
  if (listing.price_source === "description") score += 8;
  if (Array.isArray(listing.variations) && listing.variations.length > 0) score += 7;
  return Math.min(100, score);
}

function imageQualityScore(listing) {
  const images = Array.isArray(listing.image_urls) ? listing.image_urls : [];
  if (images.length === 0) return 20;
  const productImages = images.filter((url) => !PROFILE_IMAGE_PATTERN.test(String(url || "")));
  if (productImages.length === 0) return 28;
  if (productImages.length >= 3) return 100;
  if (productImages.length === 2) return 86;
  return 72;
}

function getDealPenalty(listing, context = {}) {
  const text = `${listing.title || ""} ${listing.description || ""}`.toLowerCase();
  let penalty = 0;
  if (/\b(no nego|no negotiation|fixed|firm|no lowball|lowballers ignored)\b/.test(text)) penalty += 8;
  if (/\b(repair|faulty|spoilt|not working|for parts|issue|defect|missing|cracked|broken)\b/.test(text)) penalty += 18;
  if (/\b(deposit|preorder|pre-order|top up|trade only|swap only)\b/.test(text)) penalty += 12;
  if (WTB_SERVICE_PATTERN.test(text)) penalty += 30;
  if (OFF_PLATFORM_SPAM_PATTERN.test(text)) penalty += 30;
  if (PLACEHOLDER_PRICES.has(Number(listing.current_price || 0))) penalty += 20;
  if (context.accessory) penalty += 15;
  if (context.bundle) penalty += 7;
  if (context.productImageScore < 45) penalty += 16;
  if (context.confidence < 45) penalty += 14;
  if (context.median && context.priceRatio < 0.35 && !context.bundle) penalty += 10;
  if (String(listing.description || "").length < 25) penalty += 8;
  return penalty;
}

function computeConfidence(listing, context = {}) {
  let score = 0;
  if (Number(listing.current_price || 0) > 0 && !PLACEHOLDER_PRICES.has(Number(listing.current_price || 0))) score += 15;
  if (context.median) score += Math.min(25, 8 + context.marketConfidence * 0.18);
  if (context.productImageScore >= 70) score += 18;
  else if (context.productImageScore >= 45) score += 9;
  if (String(listing.description || "").length >= 80) score += 16;
  else if (String(listing.description || "").length >= 25) score += 8;
  if (listing.location) score += 9;
  if (listing.seller_url || Number(listing.seller_rating || 0) > 0) score += 8;
  if (listing.condition && listing.condition !== "unknown") score += 5;
  if (Array.isArray(listing.variations) && listing.variations.length > 0) score += 4;
  return Math.max(0, Math.min(100, score));
}

function scoreRiskFlags(listing, context = {}) {
  const flags = [];
  if (context.accessory) flags.push("accessory_or_upgrade_part");
  if (context.bundle) flags.push("bundle_or_parts_lot");
  if (context.productImageScore < 45) flags.push("weak_or_profile_only_images");
  if (context.confidence < 50) flags.push("low_data_confidence");
  if (!context.median) flags.push("no_reference_median");
  if (context.median && context.priceRatio < 0.35) flags.push("too_far_below_market_verify");
  if (String(listing.description || "").length < 25) flags.push("thin_description");
  if (WTB_SERVICE_PATTERN.test(`${listing.title || ""} ${listing.description || ""}`)) flags.push("wtb_or_service_language");
  return flags;
}

function isAccessoryListing(listing) {
  const text = `${listing.title || ""} ${listing.description || ""}`;
  if (!ACCESSORY_PATTERN.test(text)) return false;
  if (ACCESSORY_ONLY_PATTERN.test(text)) return true;
  if (FULL_PRODUCT_PATTERN.test(text)) return false;
  return /\b(?:riser|vertical gpu kit|bracket|mount|cable|adapter|screws?|dust filter|mesh kit|extension|sleeved cable|upgrade kit|front panel|side panel|glass panel|wood panel|tempered glass)\b/i.test(text);
}

function isBundleListing(listing) {
  const text = `${listing.title || ""} ${listing.description || ""}`;
  return BUNDLE_PATTERN.test(text) && CORE_PART_PATTERN.test(text);
}

function getListingAgeHours(listing) {
  if (listing.listed_age_minutes !== null && listing.listed_age_minutes !== undefined) return Number(listing.listed_age_minutes) / 60;
  if (listing.listed_at) return Math.max(0, (Date.now() - new Date(listing.listed_at).getTime()) / 3600000);
  return Number(listing.days_listed || 0) * 24;
}

function getBadPricerReasons(listing, phraseMatches, config) {
  if (!config.badPricer?.enabled) return [];

  const reasons = [];
  const badPhrases = phraseMatches.filter((match) => match.type === "bad_pricer");
  for (const match of badPhrases) {
    reasons.push(`Bad pricer phrase: ${match.phrase}`);
  }

  if (config.badPricer.baitPrices.includes(Number(listing.current_price))) {
    reasons.push(`Bait or placeholder price: $${listing.current_price}`);
  }

  const median = config.categoryMedians[listing.category];
  if (median && listing.current_price > median * config.badPricer.overMedianMultiplier) {
    reasons.push(`Price is above ${config.badPricer.overMedianMultiplier}x category median`);
  }

  return reasons;
}

function isWtbOrServiceListing(text, listing = {}) {
  const title = String(listing.title || "").toLowerCase();
  if (/^(?:wtb|lf|looking for|buying|we buy|i buy)\b/i.test(title)) return true;
  return WTB_SERVICE_PATTERN.test(text);
}

function hasSuspiciousShape(text, listing) {
  const repeatedPunctuation = (text.match(/[!?]{2,}/g) || []).length > 3;
  const hasUrl = /https?:\/\/|www\.|bitly|bit\.ly/i.test(text);
  const letters = text.match(/[a-z]/gi) || [];
  const caps = text.match(/[A-Z]/g) || [];
  const excessiveCaps = letters.length > 20 && caps.length / letters.length > 0.6;
  const brandNewNoRating = Number(listing.seller_rating) === 0 && Number(listing.days_listed) <= 1;
  return hasUrl || repeatedPunctuation || excessiveCaps || (brandNewNoRating && (hasUrl || repeatedPunctuation || excessiveCaps));
}

function result(postType, isFiltered, spamScore, reasons) {
  return {
    post_type: postType,
    is_filtered: isFiltered,
    spam_score: spamScore,
    reasons: [...new Set(reasons)]
  };
}
