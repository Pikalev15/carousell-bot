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

  if (/\b(wtb|want to buy|looking to buy|anyone selling)\b/i.test(text)) {
    reasons.push("Looking-to-buy language");
    return result(POST_TYPES.WTB, true, 95, reasons);
  }

  if (/\b(looking for|searching for|does anyone have|can anyone recommend)\b/i.test(text)) {
    reasons.push("Looking-for language");
    return result(POST_TYPES.WTF, true, 90, reasons);
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
  const median = listing.market_median || config.categoryMedians[listing.category] || listing.current_price;
  const priceRatio = median ? listing.current_price / median : 1;
  const priceScore = Math.max(0, Math.min(100, (1.32 - priceRatio) * 110));
  const sellerScore = Math.min(100, (listing.seller_rating || 0) * 20);
  const ageHours = getListingAgeHours(listing);
  const ageScore = Math.max(0, Math.min(100, 100 - ageHours * 1.2));
  const preference = Number(listing.training?.preference_score ?? 50);
  const preferenceScore = Math.max(0, Math.min(100, preference));
  const badDealPenalty = preferenceScore < 35 ? (35 - preferenceScore) * 0.7 : 0;
  const detailScore = getDetailScore(listing);
  const suspiciousPenalty = getDealPenalty(listing);
  const baseScore =
    priceScore * 0.44 +
    (conditionScore[listing.condition] || 50) * 0.12 +
    sellerScore * 0.08 +
    ageScore * 0.08 +
    preferenceScore * 0.2 +
    detailScore * 0.08;
  const score = Math.round(Math.max(0, Math.min(100, baseScore - badDealPenalty - suspiciousPenalty)));
  const estimatedNegotiationPrice = Math.round(listing.current_price * (ageHours > 336 ? 0.88 : 0.92));

  return {
    deal_score: score,
    is_deal: score >= (config.dealThreshold || 70),
    price_score: Math.round(priceScore),
    seller_score: Math.round(sellerScore),
    age_score: Math.round(ageScore),
    preference_score: Math.round(preferenceScore),
    detail_score: Math.round(detailScore),
    penalty: Math.round(badDealPenalty + suspiciousPenalty),
    estimated_negotiation_price: estimatedNegotiationPrice,
    price_vs_median: Math.round(((listing.current_price - median) / median) * 100),
    trend_direction: listing.current_price < median * 0.98 ? "down" : listing.current_price > median * 1.02 ? "up" : "flat"
  };
}

function getDetailScore(listing) {
  let score = 30;
  if (String(listing.description || "").length >= 80) score += 25;
  if (listing.location) score += 15;
  if (listing.seller_url) score += 10;
  if (Array.isArray(listing.image_urls) && listing.image_urls.length > 0) score += 10;
  if (listing.price_source === "description") score += 10;
  return Math.min(100, score);
}

function getDealPenalty(listing) {
  const text = `${listing.title || ""} ${listing.description || ""}`.toLowerCase();
  let penalty = 0;
  if (/\b(no nego|no negotiation|fixed|firm|no lowball|lowballers ignored)\b/.test(text)) penalty += 8;
  if (/\b(repair|faulty|spoilt|not working|for parts|issue|defect)\b/.test(text)) penalty += 15;
  if (/\b(deposit|preorder|pre-order)\b/.test(text)) penalty += 10;
  return penalty;
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
