import test from "node:test";
import assert from "node:assert/strict";
import { normalizeScrapeResult } from "../src/scrapeResult.js";
import { resultCountFromSearch, summarizeScrapeResults } from "../src/startUrlSearch.js";

test("resultCountFromSearch preserves explicit null result counts", () => {
  assert.equal(resultCountFromSearch({ result_count: null, results: [] }, 0), null);
  assert.equal(resultCountFromSearch({ scrape_result: { result_count: null }, results: [] }, 0), null);
  assert.equal(resultCountFromSearch({ results: [{ id: 1 }, { id: 2 }] }, 2), 2);
});

test("summarizeScrapeResults returns null aggregate count when any child count is invalid", () => {
  const listingUrl = normalizeScrapeResult({ status: "success", ok: true, result_count: 1 });
  const blockedSearch = normalizeScrapeResult({ status: "blocked", ok: false, result_count: null });

  const summary = summarizeScrapeResults([listingUrl, blockedSearch], 1);

  assert.equal(summary.status, "partial");
  assert.equal(summary.ok, false);
  assert.equal(summary.result_count, null);
});

test("summarizeScrapeResults sums genuine zero-result and successful child counts", () => {
  const emptySearch = normalizeScrapeResult({ status: "zero_results", ok: true, result_count: 0 });
  const listingUrl = normalizeScrapeResult({ status: "success", ok: true, result_count: 1 });

  const summary = summarizeScrapeResults([emptySearch, listingUrl], 1);

  assert.equal(summary.status, "success");
  assert.equal(summary.ok, true);
  assert.equal(summary.result_count, 1);
});
