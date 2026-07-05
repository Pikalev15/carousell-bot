const POSITIVE_LABELS = new Set(["good", "bought", "not_spam"]);
const NEGATIVE_LABELS = new Set(["skip", "spam", "bad_pricer", "bad_deal"]);
const STRONG_NEGATIVE_LABELS = new Set(["spam", "bad_pricer", "bad_deal"]);
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "you",
  "your",
  "from",
  "sell",
  "selling",
  "carousell",
  "singapore"
]);

export function trainModel(listings, labels) {
  const listingById = new Map(listings.map((listing) => [Number(listing.id), listing]));
  const tokenStats = {};
  const sellerStats = {};
  const dealStats = {
    bad_deal_count: 0
  };
  let positive = 0;
  let negative = 0;

  for (const label of labels) {
    const listing = listingById.get(Number(label.listing_id));
    if (!listing) continue;

    const userRating = String(label.user_rating || "");
    const polarity = POSITIVE_LABELS.has(userRating) ? 1 : NEGATIVE_LABELS.has(userRating) ? -1 : 0;
    if (!polarity) continue;

    if (polarity > 0) positive += 1;
    if (polarity < 0) negative += 1;
    if (userRating === "bad_deal") dealStats.bad_deal_count += 1;

    for (const token of tokenizeListing(listing)) {
      tokenStats[token] ||= { good: 0, bad: 0 };
      if (polarity > 0) tokenStats[token].good += 1;
      if (polarity < 0) tokenStats[token].bad += STRONG_NEGATIVE_LABELS.has(userRating) ? 2 : 1;
    }

    sellerStats[listing.seller_id] ||= { good: 0, bad: 0 };
    if (polarity > 0) sellerStats[listing.seller_id].good += 1;
    if (polarity < 0) sellerStats[listing.seller_id].bad += 1;
  }

  return {
    version: 1,
    trained_at: new Date().toISOString(),
    example_count: positive + negative,
    positive_count: positive,
    negative_count: negative,
    bad_deal_count: dealStats.bad_deal_count,
    token_weights: calculateTokenWeights(tokenStats),
    seller_weights: calculateSellerWeights(sellerStats)
  };
}

export function predictPreference(listing, model) {
  if (!model || !model.example_count) {
    return {
      preference_score: 50,
      confidence: 0,
      reasons: ["No training data yet"]
    };
  }

  let score = 50;
  const reasons = [];
  const seen = tokenizeListing(listing);

  for (const token of seen) {
    const weight = model.token_weights?.[token];
    if (!weight) continue;
    score += weight;
    if (Math.abs(weight) >= 8) reasons.push(`${token} ${weight > 0 ? "+" : ""}${Math.round(weight)}`);
  }

  const sellerWeight = model.seller_weights?.[listing.seller_id];
  if (sellerWeight) {
    score += sellerWeight;
    reasons.push(`seller ${sellerWeight > 0 ? "+" : ""}${Math.round(sellerWeight)}`);
  }

  return {
    preference_score: Math.max(0, Math.min(100, Math.round(score))),
    confidence: Math.min(1, model.example_count / 20),
    reasons: reasons.slice(0, 5)
  };
}

export function labelPolarity(rating) {
  if (POSITIVE_LABELS.has(rating)) return "positive";
  if (NEGATIVE_LABELS.has(rating)) return "negative";
  return "neutral";
}

function tokenizeListing(listing) {
  const text = `${listing.title || ""} ${listing.description || ""} ${listing.category || ""}`.toLowerCase();
  const tokens = text.match(/[a-z0-9]{3,}/g) || [];
  return [...new Set(tokens.filter((token) => !STOP_WORDS.has(token)).slice(0, 80))];
}

function calculateTokenWeights(stats) {
  const weights = {};
  for (const [token, counts] of Object.entries(stats)) {
    const total = counts.good + counts.bad;
    if (total < 1) continue;
    const weight = ((counts.good + 0.5) / (total + 1) - 0.5) * 32;
    if (Math.abs(weight) >= 4) weights[token] = Math.round(weight);
  }
  return weights;
}

function calculateSellerWeights(stats) {
  const weights = {};
  for (const [sellerId, counts] of Object.entries(stats)) {
    const total = counts.good + counts.bad;
    if (total < 1) continue;
    weights[sellerId] = Math.round(((counts.good + 0.5) / (total + 1) - 0.5) * 24);
  }
  return weights;
}
