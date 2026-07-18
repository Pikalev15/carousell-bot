import { analyzeListingRelevance, normalizeRefinedRating, REFINED_RATINGS } from "./relevanceClassifier.js";
import { trainModel } from "./trainingModel.js";
import { readJson, writeJson } from "./store.js";

export { REFINED_RATINGS };

export async function saveRefinedListingLabel(listingId, rating, body = {}) {
  const refinedRating = normalizeRefinedRating(rating);
  if (!Number(listingId) || !refinedRating || refinedRating === "unmarked") {
    if (refinedRating === "unmarked") return removeListingLabel(Number(listingId));
    throw new Error("listing_id and valid refined rating are required");
  }

  const [listings, labels] = await Promise.all([readJson("listings"), readJson("labels")]);
  const listing = listings.find((item) => Number(item.id) === Number(listingId));
  if (!listing) throw new Error("Listing not found");

  const relevance = analyzeListingRelevance(listing, body.query || body.search_query || "");
  const nextLabel = {
    listing_id: Number(listingId),
    user_rating: legacyRatingFor(refinedRating),
    refined_rating: refinedRating,
    asked_price: body.asked_price === undefined || body.asked_price === "" ? Number(listing.current_price || 0) : Number(body.asked_price || 0),
    negotiated_price: body.negotiated_price === undefined || body.negotiated_price === "" ? null : Number(body.negotiated_price || 0),
    target_category: String(body.target_category || relevance.category || listing.category || "").trim(),
    relevance_score: Number(body.relevance_score ?? relevance.score),
    relevance_type: body.relevance_type || relevance.type,
    relevance_flags: normalizeStringList(body.relevance_flags || body.issue_flags || relevance.flags),
    search_query: String(body.search_query || body.query || "").trim().slice(0, 200),
    search_intent: String(body.search_intent || "any").trim().slice(0, 40),
    notes: String(body.notes || "").slice(0, 500),
    timestamp: new Date().toISOString()
  };

  const index = labels.findIndex((label) => Number(label.listing_id) === Number(listingId));
  if (index >= 0) labels[index] = nextLabel;
  else labels.push(nextLabel);
  await writeJson("labels", labels);
  const model = await retrainRefinedModel();
  return { ...nextLabel, model_summary: summarizeModel(model) };
}

export async function retrainRefinedModel() {
  const [listings, labels] = await Promise.all([readJson("listings"), readJson("labels")]);
  const model = trainModel(listings, labels);
  await writeJson("trainingModel", model);
  return model;
}

function legacyRatingFor(refinedRating) {
  if (["great_deal", "good_deal", "fair_deal"].includes(refinedRating)) return "good";
  if (refinedRating === "bought") return "bought";
  if (refinedRating === "not_spam") return "not_spam";
  if (["bad_deal", "overpriced"].includes(refinedRating)) return "bad_deal";
  if (refinedRating === "spam") return "spam";
  if (refinedRating === "bad_pricer") return "bad_pricer";
  return "skip";
}

async function removeListingLabel(listingId) {
  const labels = await readJson("labels");
  const next = labels.filter((label) => Number(label.listing_id) !== Number(listingId));
  await writeJson("labels", next);
  const model = await retrainRefinedModel();
  return { listing_id: Number(listingId), user_rating: "unmarked", refined_rating: "unmarked", removed: labels.length - next.length, model_summary: summarizeModel(model) };
}

function summarizeModel(model = {}) {
  return {
    version: model.version || 0,
    example_count: model.example_count || 0,
    positive_count: model.positive_count || 0,
    negative_count: model.negative_count || 0,
    label_counts: model.label_counts || {}
  };
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  return [...new Set(String(value || "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}
