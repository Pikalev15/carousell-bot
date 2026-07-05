export const POST_TYPES = {
  WTS: "WTS",
  WTB: "WTB",
  WTF: "WTF",
  SPAM: "SPAM",
  BAD_PRICER: "BAD_PRICER",
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
  const median = config.categoryMedians[listing.category] || listing.current_price;
  const priceScore = Math.max(0, Math.min(100, (1 - listing.current_price / (median * 1.15)) * 140));
  const sellerScore = Math.min(100, (listing.seller_rating || 0) * 20);
  const ageScore = Math.min(100, (listing.days_listed || 0) * 2);
  const score = Math.round(priceScore * 0.45 + (conditionScore[listing.condition] || 50) * 0.2 + sellerScore * 0.25 + ageScore * 0.1);
  const estimatedNegotiationPrice = Math.round(listing.current_price * (listing.days_listed > 14 ? 0.88 : 0.92));

  return {
    deal_score: score,
    is_deal: score >= (config.dealThreshold || 70),
    estimated_negotiation_price: estimatedNegotiationPrice,
    price_vs_median: Math.round(((listing.current_price - median) / median) * 100),
    trend_direction: listing.current_price < median * 0.98 ? "down" : listing.current_price > median * 1.02 ? "up" : "flat"
  };
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
