import { normalizeScrapeResult } from "./scrapeResult.js";

export function scrapeMetadataFromWebSearch(webSearch = {}, fallback = {}) {
  const scrapeResult = normalizeScrapeResult({
    ...(webSearch.scrape_result || webSearch),
    query: webSearch.query || fallback.query || "",
    watch_id: webSearch.watch_id ?? fallback.watch_id ?? fallback.watchId ?? null,
    started_at: webSearch.started_at || fallback.started_at,
    finished_at: webSearch.finished_at || fallback.finished_at,
    duration_ms: webSearch.duration_ms ?? fallback.duration_ms
  });

  return {
    status: scrapeResult.status,
    ok: scrapeResult.ok,
    result_count: scrapeResult.result_count,
    result_count_valid: scrapeResult.result_count_valid,
    parser: scrapeResult.parser,
    anchors_found: scrapeResult.anchors_found,
    next_data_found: scrapeResult.next_data_found,
    challenge_detected: scrapeResult.challenge_detected,
    consent_page_detected: scrapeResult.consent_page_detected,
    duration_ms: scrapeResult.duration_ms,
    started_at: scrapeResult.started_at,
    finished_at: scrapeResult.finished_at,
    error: scrapeResult.error,
    diagnostic: scrapeResult.diagnostic,
    scrape_result: scrapeResult
  };
}

export function attachScrapeMetadataToSearchSummary(summary = {}, webSearch = {}, fallback = {}) {
  return {
    ...summary,
    ...scrapeMetadataFromWebSearch(webSearch, fallback)
  };
}

export function aggregateWatchedSearchDiagnostics(results = [], fallback = {}) {
  const children = results
    .map((item) => item?.scrape_result ? normalizeScrapeResult(item.scrape_result) : null)
    .filter(Boolean);

  if (children.length === 0 || children.length !== results.length) {
    return {
      ...normalizeScrapeResult({
        ...fallback,
        result_count: null
      }),
      scrape_results: []
    };
  }

  const failing = children.find((item) => !item.ok);
  const allCountsValid = children.every((item) => item.result_count_valid);
  const resultCount = allCountsValid ? children.reduce((total, item) => total + item.result_count, 0) : null;
  const status = failing?.status || watchedAggregateStatus(children);

  return {
    ...normalizeScrapeResult({
      ...fallback,
      status,
      ok: !failing,
      result_count: resultCount,
      started_at: earliestIso(children.map((item) => item.started_at)) || fallback.started_at,
      finished_at: latestIso(children.map((item) => item.finished_at)) || fallback.finished_at,
      duration_ms: children.reduce((total, item) => total + Number(item.duration_ms || 0), 0),
      diagnostic: {
        ...(fallback.diagnostic || {}),
        child_scrape_count: children.length
      }
    }),
    scrape_results: children
  };
}

function watchedAggregateStatus(children) {
  if (children.every((item) => item.status === "zero_results")) return "zero_results";
  if (children.some((item) => item.status === "partial")) return "partial";
  if (children.some((item) => item.status === "low_results")) return "low_results";
  return "success";
}

function earliestIso(values = []) {
  return pickIso(values, (a, b) => a < b);
}

function latestIso(values = []) {
  return pickIso(values, (a, b) => a > b);
}

function pickIso(values, compare) {
  let selected = null;
  for (const value of values) {
    const timestamp = new Date(value || "").getTime();
    if (!Number.isFinite(timestamp)) continue;
    const iso = new Date(timestamp).toISOString();
    if (!selected || compare(iso, selected)) selected = iso;
  }
  return selected;
}
