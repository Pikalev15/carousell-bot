import test from "node:test";
import assert from "node:assert/strict";
import { classifyListing, POST_TYPES, scoreDeal } from "../src/filterEngine.js";

const config = {
  dealThreshold: 70,
  badPricer: {
    enabled: true,
    overMedianMultiplier: 1.35,
    baitPrices: [0, 1, 8888, 9999, 12345, 99999]
  },
  categoryMedians: {
    electronics: 1000,
    "pc case": 120,
    "computers & tech": 90
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
      image_urls: ["https://media.karousell.com/media/photos/products/2026/01/01/case.jpg"],
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

test("does not overrate profile-image-only listings", () => {
  const score = scoreDeal(
    {
      title: "ATX MATX pc case glass 3 fans",
      description: "Case with fans. Self collect.",
      current_price: 55,
      category: "pc case",
      condition: "good",
      seller_rating: 0,
      market_median: 120,
      location: "Yishun",
      image_urls: ["https://media.karousell.com/media/photos/profiles/2022/11/02/seller_1667380455.jpg"],
      listed_age_minutes: 120,
      training: { preference_score: 50 }
    },
    config
  );

  assert.ok(score.image_score < 45);
  assert.ok(score.penalty >= 16);
  assert.equal(score.is_deal, false);
  assert.ok(score.risk_flags.includes("weak_or_profile_only_images"));
});

test("caps accessory and upgrade-panel deal scores", () => {
  const score = scoreDeal(
    {
      title: "LIAN LI DAN A3 FRONT WOOD PANEL UPGRADE FRONT WOOD PANEL ONLY",
      description: "Front wood panel only. Not the full case.",
      current_price: 39,
      category: "pc case",
      condition: "new",
      seller_rating: 4.8,
      market_median: 120,
      location: "Serangoon",
      seller_url: "https://www.carousell.sg/u/shop",
      image_urls: ["https://media.karousell.com/media/photos/products/2026/01/01/panel.jpg"],
      listed_age_minutes: 45,
      training: { preference_score: 70 }
    },
    config
  );

  assert.ok(score.price_score <= 62);
  assert.ok(score.risk_flags.includes("accessory_or_upgrade_part"));
  assert.equal(score.is_deal, false);
});

test("requires confidence before marking suspiciously cheap listings as deals", () => {
  const score = scoreDeal(
    {
      title: "Phanteks XT M3 Matx Black White",
      description: "",
      current_price: 20,
      category: "pc case",
      condition: "unknown",
      seller_rating: 0,
      market_median: 120,
      image_urls: [],
      listed_age_minutes: 20,
      training: { preference_score: 50 }
    },
    config
  );

  assert.ok(score.confidence_score < 50);
  assert.equal(score.is_deal, false);
  assert.ok(score.risk_flags.includes("low_data_confidence"));
});
