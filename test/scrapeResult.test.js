import test from "node:test";
import assert from "node:assert/strict";
import {
  SCRAPE_STATUSES,
  clearScrapeResultCache,
  describeScrapeFailure,
  isBaselineSafeScrape,
  isSuccessfulScrape,
  isSuspiciousScrape,
  normalizeScrapeResult,
  resultCountFromScrape
} from "../src/scrapeResult.js";

test("normalizes successful scrape results with safe defaults", () => {
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
  const result = normalizeScrapeResult({ query: "gpu", added: 0, updated: 0 });
  assert.equal(result.status, SCRAPE_STATUSES.SUCCESS);
  assert.equal(result.result_count, null);
  assert.equal(result.result_count_valid, false);
  assert.equal(resultCountFromScrape(result), null);
  assert.equal(isBaselineSafeScrape(result), false);
});

test("classifies failed timeout and challenge results as suspicious", () => {
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
  const zero = normalizeScrapeResult({ status: "zero_results", ok: true, result_count: 0, anchors_found: 0, next_data_found: true });
  assert.equal(zero.status, SCRAPE_STATUSES.ZERO_RESULTS);
  assert.equal(isSuccessfulScrape(zero), true);
  assert.equal(isBaselineSafeScrape(zero), true);
  assert.equal(describeScrapeFailure(zero), "Valid search page returned zero listings");
});

test("aggregates cached per-term scrape counts for watched search summaries", () => {
  clearScrapeResultCache();
  normalizeScrapeResult({ query: "rtx 3070", status: "success", ok: true, result_count: 8, anchors_found: 8, next_data_found: true });
  normalizeScrapeResult({ query: "rtx 3080", status: "success", ok: true, result_count: 2, anchors_found: 2, next_data_found: true });

  const watched = normalizeScrapeResult({ query: "GPU watch", terms: ["rtx 3070", "rtx 3080"], added: 0, updated: 0 });
  assert.equal(watched.status, SCRAPE_STATUSES.SUCCESS);
  assert.equal(watched.ok, true);
  assert.equal(watched.result_count, 10);
  assert.equal(watched.result_count_valid, true);
  assert.equal(watched.anchors_found, 10);
  assert.equal(watched.scrape_results.length, 2);
  assert.equal(isBaselineSafeScrape(watched), true);
});

test("blocked cached watched terms do not become fake zero-result baselines", () => {
  clearScrapeResultCache();
  normalizeScrapeResult({ query: "lian li a3", status: "success", ok: true, result_count: 12, anchors_found: 12, next_data_found: true });
  normalizeScrapeResult({ query: "dan a3 wood", status: "blocked", ok: false, result_count: null, challenge_detected: true, error: "access denied" });

  const watched = normalizeScrapeResult({ query: "case watch", terms: ["lian li a3", "dan a3 wood"], added: 0, updated: 0 });
  assert.equal(watched.status, SCRAPE_STATUSES.BLOCKED);
  assert.equal(watched.ok, false);
  assert.equal(watched.result_count, null);
  assert.equal(watched.result_count_valid, false);
  assert.equal(watched.challenge_detected, true);
  assert.equal(isBaselineSafeScrape(watched), false);
  assert.match(describeScrapeFailure(watched), /challenge|block/i);
});
