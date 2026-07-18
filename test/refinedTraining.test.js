import test from "node:test";
import assert from "node:assert/strict";
import { predictPreference, trainModel, labelPolarity } from "../src/trainingModel.js";

const listings = [
  {
    id: 1,
    title: "Lian Li Dan A3 mATX Case full case",
    description: "Complete case with all panels and screws.",
    category: "pc case",
    seller_id: "seller-good",
    relevance_flags: [],
    relevance_score: 90
  },
  {
    id: 2,
    title: "BUY BACK PC PARTS",
    description: "Looking to buy GPUs CPUs RAM SSD. Fast offer.",
    category: "service/wtb",
    seller_id: "seller-wtb",
    relevance_flags: ["wtb_or_service"],
    relevance_score: 12
  },
  {
    id: 3,
    title: "Lian Li A3 vertical GPU riser kit only",
    description: "Riser kit only, not the full case.",
    category: "pc case accessory",
    seller_id: "seller-accessory",
    relevance_flags: ["accessory_only"],
    relevance_score: 45
  }
];

test("trains with refined good, wtb, and accessory labels", () => {
  const model = trainModel(listings, [
    { listing_id: 1, user_rating: "great_deal" },
    { listing_id: 2, user_rating: "wtb_service", relevance_flags: ["wtb_or_service"] },
    { listing_id: 3, user_rating: "accessory_only", relevance_flags: ["accessory_only"] }
  ]);

  assert.equal(model.version, 3);
  assert.equal(model.example_count, 3);
  assert.equal(model.positive_count, 1);
  assert.equal(model.negative_count, 2);
  assert.equal(model.wtb_service_count, 1);
  assert.equal(model.accessory_count, 1);
  assert.equal(model.label_counts.great_deal, 1);
  assert.equal(model.label_counts.wtb_service, 1);
  assert.ok(model.issue_weights.wtb_or_service < 0);
  assert.ok(model.issue_weights.accessory_only < 0);
  assert.ok(model.model_weights["lian li"] === undefined || typeof model.model_weights["lian li"] === "number");
  assert.equal(model.alert_feedback.total, 3);
});

test("learns model-family preferences separately from generic text", () => {
  const model = trainModel([
    { id: 10, title: "ASUS RTX 4070 Ti Super", category: "graphics card", seller_id: "a" },
    { id: 11, title: "MSI RTX 4070 Ti Super", category: "graphics card", seller_id: "b" },
    { id: 12, title: "RTX 3060 vertical riser", category: "pc case accessory", seller_id: "c" }
  ], [
    { listing_id: 10, refined_rating: "great_deal" },
    { listing_id: 11, refined_rating: "good_deal" },
    { listing_id: 12, refined_rating: "accessory_only" }
  ]);
  assert.ok(model.model_weights["rtx 4070 ti super"] > 0);
  const prediction = predictPreference({ title: "Gigabyte RTX 4070 Ti Super", category: "graphics card", seller_id: "new" }, model);
  assert.ok(prediction.reasons.some((reason) => reason.includes("model rtx 4070 ti super")));
});

test("refined model predicts low preference for learned bad relevance flags", () => {
  const model = trainModel(listings, [
    { listing_id: 1, user_rating: "great_deal" },
    { listing_id: 2, user_rating: "wtb_service", relevance_flags: ["wtb_or_service"] },
    { listing_id: 3, user_rating: "accessory_only", relevance_flags: ["accessory_only"] }
  ]);
  const prediction = predictPreference({
    title: "BEST RATES BUYBACK WTB WTS PC PARTS",
    description: "We purchase all devices, payment on the spot.",
    category: "service/wtb",
    seller_id: "unknown",
    relevance_flags: ["wtb_or_service"],
    relevance_score: 10
  }, model);

  assert.ok(prediction.preference_score < 35);
  assert.ok(prediction.reasons.some((reason) => reason.includes("relevance")));
});

test("labelPolarity supports refined labels", () => {
  assert.equal(labelPolarity("great_deal"), "positive");
  assert.equal(labelPolarity("overpriced"), "negative");
  assert.equal(labelPolarity("unmarked"), "neutral");
});
