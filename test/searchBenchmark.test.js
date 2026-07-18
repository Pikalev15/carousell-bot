import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchAccuracyBenchmark } from "../src/searchBenchmark.js";

test("reports precision, recall, accuracy, and query coverage", () => {
  const listings = [
    { id: 1, title: "RTX 3070 graphics card", category: "graphics card" },
    { id: 2, title: "RTX 3070 vertical riser kit", category: "pc case accessory" },
    { id: 3, title: "BUYBACK GPU WTB", category: "service/wtb" }
  ];
  const labels = [
    { listing_id: 1, refined_rating: "good_deal", search_query: "rtx 3070 -riser type:component" },
    { listing_id: 2, refined_rating: "accessory_only", search_query: "rtx 3070 -riser type:component" },
    { listing_id: 3, refined_rating: "wtb_service", search_query: "gpu" }
  ];
  const result = buildSearchAccuracyBenchmark(listings, labels);
  assert.equal(result.sample_size, 3);
  assert.equal(result.query_sample_size, 3);
  assert.equal(result.accuracy, 100);
  assert.equal(result.precision, 100);
  assert.equal(result.recall, 100);
  assert.equal(result.confusion.false_positive, 0);
});

test("returns null metrics without labeled examples", () => {
  const result = buildSearchAccuracyBenchmark([], []);
  assert.equal(result.sample_size, 0);
  assert.equal(result.accuracy, null);
  assert.equal(result.needs_more_query_labels, 20);
});
