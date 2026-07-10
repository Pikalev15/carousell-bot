import test from "node:test";
import assert from "node:assert/strict";
import {
  SCRAPE_STATUSES,
  clearScrapeResultCache,
  describeScrapeFailure,
  getCachedScrapeResults,
  isBaselineSafeScrape,
  isSuccessfulScrape,
  isSuspiciousScrape,
  normalizeScrapeResult,
  resultCountFromScrape
} from "../src/scrapeResult.js";

test("normalizes successful scrape results with safe defaults", () => {
  clearScrapeResultCache();
  const result = normalizeScrapeResult({ query: "ssd", result_count: 12, added: 2, updated: 3 });
  assert.equal(result.status, SCRAPE_STATUSES.SUCCESS);
  assert.equal(result.ok, true);
  assert.equal(result.result_count, 12);
  assert.equal(result.result_count_valid, true);
  assert.equal(result.added, 2);
  assert.equal(result.updated, 3);
  assert.equal(isSuccessfulScrape(result), true);
  assert.equal(resultCountFromScrape(result), 12);
});

test("does not invent a real zero count from added plus updated", () => {
  clearScrapeResultCache();
  const result = normalizeScrapeResult({ query: "gpu", added: 0, updated: 0 });
  assert.equal(result.status, SCRAPE_STATUSES.SUCCESS);
  assert.equal(result.result_count, null);
  assert.equal(result.result_count_valid, false);
  assert.equal(resultCountFromScrape(result), null);
  assert.equal(isBaselineSafeScrape(result), false);
});

test("classifies failed timeout and challenge results as suspicious", () => {
  clearScrapeResultCache();
  const timeout = normalizeScrapeResult({ error: "Navigation timeout after 25000ms" });
  assert.equal(timeout.status, SCRAPE_STATUSES.TIMEOUT);
  assert.equal(isSuspiciousScrape(timeout), true);
  assert.match(describeScrapeFailure(timeout), /timeout/i);

  const challenge = normalizeScrapeResult({ challenge_detected: true, result_count: 0 });
  assert.equal(challenge.status, SCRAPE_STATUSES.BLOCKED);
  assert.equal(isSuccessfulScrape(challenge), false);
  assert.equal(isBaselineSafeScrape(challenge), false);
});

test("keeps genuine zero-result pages distinct from scraper failure", () => {
  clearScrapeResultCache();
  const zero = normalizeScrapeResult({ status: "zero_results", ok: true, result_count: 0, anchors_found: 0, next_data_found: true });
  assert.equal(zero.status, SCRAPE_STATUSES.ZERO_RESULTS);
  assert.equal(isSuccessfulScrape(zero), true);
  assert.equal(isBaselineSafeScrape(zero), true);
  assert.equal(describeScrapeFailure(zero), "Valid search page returned zero listings");
});

test("recovers watched-search result count from cached per-term scrape results", () => {
  clearScrapeResultCache();
  normalizeScrapeResult({ query: "rtx 3070", status: "success", ok: true, result_count: 11, anchors_found: 20, next_data_found: true });
  normalizeScrapeResult({ query: "rtx 3080", status: "success", ok: true, result_count: 7, anchors_found: 15, next_data_found: true });

  const aggregate = normalizeScrapeResult({ query: "GPU monitor", terms: ["rtx 3070", "rtx 3080"], added: 0, updated: 0 });

  assert.equal(aggregate.status, SCRAPE_STATUSES.SUCCESS);
  assert.equal(aggregate.result_count, 18);
  assert.equal(aggregate.result_count_valid, true);
  assert.equal(aggregate.anchors_found, 35);
  assert.equal(aggregate.next_data_found, true);
  assert.equal(aggregate.scrape_results.length, 2);
  assert.equal(isBaselineSafeScrape(aggregate), true);
  assert.equal(getCachedScrapeResults(["rtx 3070", "rtx 3080"]).length, 2);
});

test("does not turn a cached blocked term into a zero-result baseline", () => {
  clearScrapeResultCache();
  normalizeScrapeResult({ query: "ssd", status: "blocked", ok: false, challenge_detected: true, result_count: null });

  const aggregate = normalizeScrapeResult({ query: "Storage monitor", terms: ["ssd"] });

  assert.equal(aggregate.status, SCRAPE_STATUSES.BLOCKED);
  assert.equal(aggregate.ok, false);
  assert.equal(aggregate.result_count, null);
  assert.equal(aggregate.result_count_valid, false);
  assert.equal(isBaselineSafeScrape(aggregate), false);
});
