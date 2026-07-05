import test from "node:test";
import assert from "node:assert/strict";
import { classifyListing, POST_TYPES } from "../src/filterEngine.js";

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
