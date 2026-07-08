import test from "node:test";
import assert from "node:assert/strict";
import { applyRollingCategoryMedians, computeRollingCategoryMedians } from "../src/categoryMedianAutoTune.js";

const now = new Date("2026-07-08T00:00:00.000Z").getTime();

function listing(id, category, price, daysAgo = 0) {
  return {
    id,
    category,
    current_price: price,
    scraped_at: new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    classification: { is_filtered: false },
    score: {}
  };
}

test("computes rolling category medians from recent listings", () => {
  const result = computeRollingCategoryMedians([
    listing(1, "graphics card", 200),
    listing(2, "graphics card", 300),
    listing(3, "graphics card", 400),
    listing(4, "graphics card", 999, 60)
  ], { categoryMedianAutoTune: { days: 30, minSampleSize: 3 } }, now);

  assert.equal(result.medians["graphics card"], 300);
  assert.equal(result.samples["graphics card"], 3);
});

test("falls back when sample size is below minimum", () => {
  const listings = applyRollingCategoryMedians([
    listing(1, "pc case", 80),
    listing(2, "pc case", 90)
  ], {
    categoryMedians: { "pc case": 120, electronics: 850 },
    categoryMedianAutoTune: { enabled: true, days: 30, minSampleSize: 3 }
  });

  assert.equal(listings[0].market_median, 120);
  assert.equal(listings[1].market_median, 120);
});
