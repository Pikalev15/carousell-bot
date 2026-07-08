import test from "node:test";
import assert from "node:assert/strict";
import { applyDefaultCategoryMedians, computeVariantMarketInsights, DEFAULT_CATEGORY_MEDIANS, variantMarketKeys } from "../src/marketGrouping.js";

test("builds variant-aware keys for GPU listings", () => {
  const keys = variantMarketKeys({
    category: "graphics card",
    title: "RTX 3070 Ti 8GB",
    variations: [{ name: "gpu_model", value: "RTX 3070 TI" }]
  });
  assert.ok(keys.includes("graphics-card:gpu:rtx-3070-ti"));
  assert.ok(keys.includes("graphics-card"));
});

test("separates accessory panel listings from full cases", () => {
  const keys = variantMarketKeys({
    category: "pc case",
    title: "Lian Li Dan A3 wood panel only",
    description: "Front panel only, not full case",
    variations: [{ name: "case_size", value: "MATX" }]
  });
  assert.ok(keys.some((key) => key.includes(":accessory:")));
});

test("computes market insights using variant group medians", () => {
  const listings = [
    { id: 1, category: "graphics card", title: "RTX 3070", current_price: 280, variations: [{ name: "gpu_model", value: "RTX 3070" }] },
    { id: 2, category: "graphics card", title: "RTX 3070", current_price: 300, variations: [{ name: "gpu_model", value: "RTX 3070" }] },
    { id: 3, category: "graphics card", title: "RTX 3070", current_price: 320, variations: [{ name: "gpu_model", value: "RTX 3070" }] },
    { id: 4, category: "graphics card", title: "RTX 3080", current_price: 500, variations: [{ name: "gpu_model", value: "RTX 3080" }] }
  ];
  const insights = computeVariantMarketInsights(listings);
  assert.equal(insights.get(1).median_price, 300);
  assert.equal(insights.get(1).sample_size, 3);
  assert.equal(insights.get(4).rating, "unknown");
});

test("applies default category medians without overwriting custom values", () => {
  const config = applyDefaultCategoryMedians({ categoryMedians: { "graphics card": 999 } });
  assert.equal(config.categoryMedians["graphics card"], 999);
  assert.equal(config.categoryMedians["pc case"], DEFAULT_CATEGORY_MEDIANS["pc case"]);
});
