import { extractModelFamilies, labelTrainingEffect, normalizeRefinedRating } from "./relevanceClassifier.js";

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
  const categoryStats = {};
  const modelStats = {};
  const issueStats = {};
  const labelCounts = {};
  const dealStats = {
    bad_deal_count: 0,
    duplicate_count: 0,
    accessory_count: 0,
    wrong_category_count: 0,
    irrelevant_count: 0,
    wtb_service_count: 0
  };
  let positive = 0;
  let negative = 0;
  let neutral = 0;
  let alertAccepted = 0;
  let alertDismissed = 0;

  for (const label of labels) {
    const listing = listingById.get(Number(label.listing_id));
    if (!listing) continue;

    const userRating = normalizeRefinedRating(label.refined_rating || label.user_rating || label.rating);
    const effect = labelTrainingEffect(userRating);
    labelCounts[userRating] = (labelCounts[userRating] || 0) + 1;
    if (!effect.polarity) {
      neutral += 1;
      continue;
    }

    if (effect.polarity > 0) positive += 1;
    if (effect.polarity < 0) negative += 1;
    if (["great_deal", "good_deal", "fair_deal", "bought", "not_spam"].includes(userRating)) alertAccepted += 1;
    if (["bad_deal", "overpriced", "accessory_only", "wrong_category", "irrelevant", "wtb_service", "spam", "bad_pricer"].includes(userRating)) alertDismissed += 1;
    if (userRating === "bad_deal" || userRating === "overpriced") dealStats.bad_deal_count += 1;
    if (userRating === "duplicate_listing") dealStats.duplicate_count += 1;
    if (userRating === "accessory_only") dealStats.accessory_count += 1;
    if (userRating === "wrong_category") dealStats.wrong_category_count += 1;
    if (userRating === "irrelevant") dealStats.irrelevant_count += 1;
    if (userRating === "wtb_service") dealStats.wtb_service_count += 1;

    const weight = Math.max(0.2, Number(effect.strength || 1));
    for (const token of tokenizeListing(listing)) {
      tokenStats[token] ||= { good: 0, bad: 0 };
      if (effect.polarity > 0) tokenStats[token].good += weight;
      if (effect.polarity < 0) tokenStats[token].bad += weight;
    }

    const category = listing.category || "general";
    categoryStats[category] ||= { good: 0, bad: 0 };
    if (effect.polarity > 0) categoryStats[category].good += weight;
    if (effect.polarity < 0) categoryStats[category].bad += weight;

    for (const family of extractModelFamilies(listing)) {
      modelStats[family] ||= { good: 0, bad: 0 };
      if (effect.polarity > 0) modelStats[family].good += weight;
      if (effect.polarity < 0) modelStats[family].bad += weight;
    }

    for (const flag of label.relevance_flags || label.issue_flags || []) {
      issueStats[flag] ||= { good: 0, bad: 0 };
      if (effect.polarity > 0) issueStats[flag].good += weight;
      if (effect.polarity < 0) issueStats[flag].bad += weight;
    }

    sellerStats[listing.seller_id] ||= { good: 0, bad: 0 };
    if (effect.polarity > 0) sellerStats[listing.seller_id].good += weight;
    if (effect.polarity < 0) sellerStats[listing.seller_id].bad += weight;
  }

  return {
    version: 3,
    trained_at: new Date().toISOString(),
    example_count: positive + negative,
    positive_count: positive,
    negative_count: negative,
    neutral_count: neutral,
    label_counts: labelCounts,
    ...dealStats,
    token_weights: calculateTokenWeights(tokenStats),
    seller_weights: calculateSellerWeights(sellerStats),
    category_weights: calculateTokenWeights(categoryStats),
    model_weights: calculateTokenWeights(modelStats),
    issue_weights: calculateTokenWeights(issueStats),
    seller_stats: sellerStats,
    category_stats: categoryStats,
    model_stats: modelStats,
    issue_stats: issueStats,
    alert_feedback: buildAlertFeedback(alertAccepted, alertDismissed)
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

  const categoryWeight = model.category_weights?.[listing.category];
  if (categoryWeight) {
    score += categoryWeight * 0.7;
    reasons.push(`category ${categoryWeight > 0 ? "+" : ""}${Math.round(categoryWeight)}`);
  }

  for (const family of extractModelFamilies(listing)) {
    const weight = model.model_weights?.[family];
    if (!weight) continue;
    score += weight * 1.1;
    reasons.push(`model ${family} ${weight > 0 ? "+" : ""}${Math.round(weight)}`);
  }

  const relevanceFlags = listing.relevance_flags || listing.relevance_analysis?.flags || listing.quality_flags || [];
  for (const flag of relevanceFlags) {
    const weight = model.issue_weights?.[flag];
    if (!weight) continue;
    score += weight * 0.8;
    if (Math.abs(weight) >= 6) reasons.push(`${flag} ${weight > 0 ? "+" : ""}${Math.round(weight)}`);
  }

  const sellerWeight = model.seller_weights?.[listing.seller_id];
  if (sellerWeight) {
    score += sellerWeight;
    reasons.push(`seller ${sellerWeight > 0 ? "+" : ""}${Math.round(sellerWeight)}`);
  }

  const relevanceScore = Number(listing.relevance_score ?? listing.relevance_analysis?.score ?? 70);
  if (relevanceScore < 45) {
    score -= 18;
    reasons.push(`relevance ${relevanceScore}/100`);
  } else if (relevanceScore >= 85) {
    score += 5;
  }

  return {
    preference_score: Math.max(0, Math.min(100, Math.round(score))),
    confidence: Math.min(1, model.example_count / 30),
    reasons: reasons.slice(0, 7)
  };
}

function buildAlertFeedback(accepted, dismissed) {
  const total = accepted + dismissed;
  const dismissedRatio = total ? dismissed / total : 0;
  const minPreference = total < 6 ? 30 : dismissedRatio >= 0.6 ? 52 : dismissedRatio >= 0.35 ? 42 : 32;
  return {
    total,
    accepted,
    dismissed,
    accepted_ratio: total ? Number((accepted / total).toFixed(3)) : null,
    min_preference: minPreference
  };
}

export function labelPolarity(rating) {
  const effect = labelTrainingEffect(normalizeRefinedRating(rating));
  if (effect.polarity > 0) return "positive";
  if (effect.polarity < 0) return "negative";
  return "neutral";
}

function tokenizeListing(listing) {
  const variationText = Array.isArray(listing.variations) ? listing.variations.map((item) => `${item.name} ${item.value}`).join(" ") : "";
  const flagText = Array.isArray(listing.relevance_flags) ? listing.relevance_flags.join(" ") : "";
  const text = `${listing.title || ""} ${listing.description || ""} ${listing.category || ""} ${variationText} ${flagText}`.toLowerCase();
  const tokens = text.match(/[a-z0-9]{3,}/g) || [];
  return [...new Set(tokens.filter((token) => !STOP_WORDS.has(token)).slice(0, 120))];
}

function calculateTokenWeights(stats) {
  const weights = {};
  for (const [token, counts] of Object.entries(stats)) {
    const total = counts.good + counts.bad;
    if (total < 0.5) continue;
    const weight = ((counts.good + 0.5) / (total + 1) - 0.5) * 36;
    if (Math.abs(weight) >= 4) weights[token] = Math.round(weight);
  }
  return weights;
}

function calculateSellerWeights(stats) {
  const weights = {};
  for (const [sellerId, counts] of Object.entries(stats)) {
    const total = counts.good + counts.bad;
    if (total < 0.5) continue;
    weights[sellerId] = Math.round(((counts.good + 0.5) / (total + 1) - 0.5) * 26);
  }
  return weights;
}
