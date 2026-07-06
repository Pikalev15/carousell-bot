import test from "node:test";
import assert from "node:assert/strict";
import { classifyListing, POST_TYPES, scoreDeal } from "../src/filterEngine.js";

const config = {
  badPricer: {
    enabled: true,
    overMedianMultiplier: 1.35,
    baitPrices: [0, 1, 8888, 9999, 12345, 99999]
  },
  categoryMedians: {
    electronics: 1000
  }
};

test("classifies WTB posts before deal scoring", () => {
  const classification = classifyListing(
    { title: "WTB iPhone 15 Pro", description: "looking to buy", current_price: 900, category: "electronics" },
    [],
    [],
    config
  );
  assert.equal(classification.post_type, POST_TYPES.WTB);
  assert.equal(classification.is_filtered, true);
});

test("flags bait prices and bad pricer phrases", () => {
  const classification = classifyListing(
    { title: "MacBook Pro", description: "offer me no lowball", current_price: 1, category: "electronics" },
    [{ type: "bad_pricer", phrase: "offer me", reason: "No price" }],
    [],
    config
  );
  assert.equal(classification.post_type, POST_TYPES.BAD_PRICER);
  assert.equal(classification.is_filtered, true);
});

test("blocks seller blacklist before other classification", () => {
  const classification = classifyListing(
    { title: "Clean listing", description: "", current_price: 800, category: "electronics", seller_id: "blocked" },
    [],
    [{ seller_id: "blocked", reason: "Spam" }],
    config
  );
  assert.equal(classification.post_type, POST_TYPES.SELLER_BLOCKED);
});

test("scores with market median, detail quality, and deal penalties", () => {
  const strong = scoreDeal(
    {
      title: "Lian Li case",
      description: "Clean case with original accessories and full description for inspection.",
      current_price: 80,
      category: "electronics",
      condition: "good",
      seller_rating: 4,
      market_median: 160,
      location: "Bishan",
      seller_url: "https://www.carousell.sg/u/seller",
      image_urls: ["https://example.com/a.jpg"],
      price_source: "card",
      listed_age_minutes: 30,
      training: { preference_score: 70 }
    },
    config
  );
  const weak = scoreDeal(
    {
      title: "Faulty case",
      description: "Not working, for parts, price fixed no nego.",
      current_price: 150,
      category: "electronics",
      condition: "fair",
      seller_rating: 0,
      market_median: 160,
      listed_age_minutes: 500,
      training: { preference_score: 30 }
    },
    config
  );

  assert.ok(strong.deal_score > weak.deal_score);
  assert.ok(weak.penalty > 0);
});
