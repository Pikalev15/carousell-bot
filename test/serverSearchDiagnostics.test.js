import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateWatchedSearchDiagnostics,
  attachScrapeMetadataToSearchSummary,
  scrapeMetadataFromWebSearch
} from "../src/serverSearchDiagnostics.js";

const started_at = "2026-07-10T07:00:00.000Z";
const finished_at = "2026-07-10T07:00:02.000Z";

test("extracts direct scrape metadata from a web search result", () => {
  const metadata = scrapeMetadataFromWebSearch({
    query: "rtx 3070",
    status: "success",
    ok: true,
    result_count: 12,
    parser: "DOM + Next data",
    anchors_found: 24,
    next_data_found: true,
    started_at,
    finished_at,
    duration_ms: 2000,
    diagnostic: { validation_reason: "ok" }
  });

  assert.equal(metadata.status, "success");
  assert.equal(metadata.ok, true);
  assert.equal(metadata.result_count, 12);
  assert.equal(metadata.result_count_valid, true);
  assert.equal(metadata.scrape_result.query, "rtx 3070");
  assert.equal(metadata.scrape_result.parser, "DOM + Next data");
});

test("attaches direct scrape metadata to server search summaries", () => {
  const summary = attachScrapeMetadataToSearchSummary({
    source: "carousell-web",
    url: "https://www.carousell.sg/search/gpu",
    added: 2,
    updated: 1,
    price_drops: 0,
    job: null
  }, {
    query: "gpu",
    status: "zero_results",
    ok: true,
    result_count: 0,
    next_data_found: true
  });

  assert.equal(summary.source, "carousell-web");
  assert.equal(summary.added, 2);
  assert.equal(summary.updated, 1);
  assert.equal(summary.status, "zero_results");
  assert.equal(summary.result_count, 0);
  assert.equal(summary.result_count_valid, true);
  assert.equal(summary.scrape_result.status, "zero_results");
});

test("aggregates watched search diagnostics from direct child summaries", () => {
  const aggregate = aggregateWatchedSearchDiagnostics([
    { scrape_result: { query: "gpu", status: "success", ok: true, result_count: 6, started_at, finished_at } },
    { scrape_result: { query: "rtx", status: "zero_results", ok: true, result_count: 0, started_at, finished_at } }
  ], { query: "graphics cards", watch_id: 7 });

  assert.equal(aggregate.status, "success");
  assert.equal(aggregate.ok, true);
  assert.equal(aggregate.result_count, 6);
  assert.equal(aggregate.result_count_valid, true);
  assert.equal(aggregate.watch_id, 7);
  assert.equal(aggregate.scrape_results.length, 2);
});

test("propagates failed child scrape status instead of inventing zero count", () => {
  const aggregate = aggregateWatchedSearchDiagnostics([
    { scrape_result: { query: "gpu", status: "success", ok: true, result_count: 6, started_at, finished_at } },
    { scrape_result: { query: "rtx", status: "blocked", ok: false, result_count: null, challenge_detected: true, started_at, finished_at } }
  ], { query: "graphics cards", watch_id: 7 });

  assert.equal(aggregate.status, "blocked");
  assert.equal(aggregate.ok, false);
  assert.equal(aggregate.result_count, null);
  assert.equal(aggregate.result_count_valid, false);
  assert.equal(aggregate.scrape_results.length, 2);
});
