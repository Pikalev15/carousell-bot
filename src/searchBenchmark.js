import { analyzeListingRelevance, analyzeQueryMatch, normalizeRefinedRating } from "./relevanceClassifier.js";

const RELEVANT_RATINGS = new Set(["great_deal", "good_deal", "fair_deal", "bad_deal", "overpriced", "bought", "not_spam", "duplicate_listing", "bundle_mixed"]);
const IRRELEVANT_RATINGS = new Set(["accessory_only", "wrong_category", "irrelevant", "wtb_service", "spam", "bad_pricer"]);

export function buildSearchAccuracyBenchmark(listings = [], labels = [], options = {}) {
  const threshold = Number(options.threshold || 55);
  const byId = new Map(listings.map((listing) => [Number(listing.id), listing]));
  const samples = [];

  for (const label of labels) {
    const rating = normalizeRefinedRating(label.refined_rating || label.user_rating || label.rating);
    if (!RELEVANT_RATINGS.has(rating) && !IRRELEVANT_RATINGS.has(rating)) continue;
    const listing = byId.get(Number(label.listing_id));
    if (!listing) continue;
    const query = String(label.search_query || label.query || "").trim();
    const analysis = query ? analyzeQueryMatch(listing, query) : analyzeListingRelevance(listing, "");
    const score = Number(analysis.score || 0);
    samples.push({
      listing_id: Number(label.listing_id),
      title: listing.title || "Untitled listing",
      rating,
      query: query || null,
      expected_relevant: RELEVANT_RATINGS.has(rating),
      predicted_relevant: score >= threshold,
      score,
      summary: analysis.summary || (analysis.reasons || []).join(", ")
    });
  }

  const truePositive = samples.filter((sample) => sample.expected_relevant && sample.predicted_relevant).length;
  const trueNegative = samples.filter((sample) => !sample.expected_relevant && !sample.predicted_relevant).length;
  const falsePositive = samples.filter((sample) => !sample.expected_relevant && sample.predicted_relevant);
  const falseNegative = samples.filter((sample) => sample.expected_relevant && !sample.predicted_relevant);
  const predictedPositive = truePositive + falsePositive.length;
  const actualPositive = truePositive + falseNegative.length;
  const precision = predictedPositive ? truePositive / predictedPositive : null;
  const recall = actualPositive ? truePositive / actualPositive : null;
  const accuracy = samples.length ? (truePositive + trueNegative) / samples.length : null;
  const querySamples = samples.filter((sample) => sample.query);
  const queryCorrect = querySamples.filter((sample) => sample.expected_relevant === sample.predicted_relevant).length;

  return {
    threshold,
    sample_size: samples.length,
    query_sample_size: querySamples.length,
    needs_more_query_labels: Math.max(0, 20 - querySamples.length),
    precision: metricPercent(precision),
    recall: metricPercent(recall),
    accuracy: metricPercent(accuracy),
    query_accuracy: metricPercent(querySamples.length ? queryCorrect / querySamples.length : null),
    confusion: {
      true_positive: truePositive,
      true_negative: trueNegative,
      false_positive: falsePositive.length,
      false_negative: falseNegative.length
    },
    false_positives: falsePositive.slice(0, 8),
    false_negatives: falseNegative.slice(0, 8),
    evaluated_at: new Date().toISOString()
  };
}

function metricPercent(value) {
  return value === null ? null : Math.round(value * 1000) / 10;
}
