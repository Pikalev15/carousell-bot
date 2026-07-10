export const SCRAPE_STATUSES = Object.freeze({
  SUCCESS: "success",
  PARTIAL: "partial",
  LOW_RESULTS: "low_results",
  ZERO_RESULTS: "zero_results",
  BLOCKED: "blocked",
  LAYOUT_CHANGED: "layout_changed",
  TIMEOUT: "timeout",
  NETWORK_ERROR: "network_error",
  FAILED: "failed"
});

const VALID_STATUSES = new Set(Object.values(SCRAPE_STATUSES));
const SUCCESSFUL_STATUSES = new Set([
  SCRAPE_STATUSES.SUCCESS,
  SCRAPE_STATUSES.PARTIAL,
  SCRAPE_STATUSES.LOW_RESULTS,
  SCRAPE_STATUSES.ZERO_RESULTS
]);
const SUSPICIOUS_STATUSES = new Set([
  SCRAPE_STATUSES.PARTIAL,
  SCRAPE_STATUSES.LOW_RESULTS,
  SCRAPE_STATUSES.ZERO_RESULTS,
  SCRAPE_STATUSES.BLOCKED,
  SCRAPE_STATUSES.LAYOUT_CHANGED,
  SCRAPE_STATUSES.TIMEOUT,
  SCRAPE_STATUSES.NETWORK_ERROR,
  SCRAPE_STATUSES.FAILED
]);
const BASELINE_SAFE_STATUSES = new Set([
  SCRAPE_STATUSES.SUCCESS,
  SCRAPE_STATUSES.PARTIAL,
  SCRAPE_STATUSES.LOW_RESULTS,
  SCRAPE_STATUSES.ZERO_RESULTS
]);
const FAILURE_STATUSES = new Set([
  SCRAPE_STATUSES.BLOCKED,
  SCRAPE_STATUSES.LAYOUT_CHANGED,
  SCRAPE_STATUSES.TIMEOUT,
  SCRAPE_STATUSES.NETWORK_ERROR,
  SCRAPE_STATUSES.FAILED
]);

const RESULT_CACHE_TTL_MS = Math.max(10_000, Number(process.env.CAROUSELL_SCRAPE_RESULT_CACHE_TTL_MS || 5 * 60 * 1000));
const cachedScrapeResults = new Map();

export function normalizeScrapeResult(input = {}) {
  const now = new Date().toISOString();
  const cachedAggregate = aggregateCachedTermResults(input);
  const status = normalizeStatus(input.status || cachedAggregate?.status, input);
  const resultCount = nullableNonNegativeInteger(input.result_count ?? input.results_count ?? input.count ?? cachedAggregate?.result_count);
  const added = nonNegativeInteger(input.added);
  const updated = nonNegativeInteger(input.updated);
  const startedAt = normalizeIso(input.started_at || input.startedAt) || now;
  const finishedAt = normalizeIso(input.finished_at || input.finishedAt) || now;
  const diagnostic = input.diagnostic && typeof input.diagnostic === "object" ? { ...input.diagnostic } : {};
  if (cachedAggregate) {
    diagnostic.aggregate_terms = cachedAggregate.scrape_results.length;
    diagnostic.aggregate_source = "cached_term_results";
  }

  const normalized = {
    status,
    ok: input.ok === undefined ? cachedAggregate?.ok ?? SUCCESSFUL_STATUSES.has(status) : Boolean(input.ok) && !FAILURE_STATUSES.has(status),
    query: String(input.query || ""),
    watch_id: input.watch_id ?? input.watchId ?? null,
    result_count: resultCount,
    result_count_valid: resultCount !== null,
    added,
    updated,
    parser: input.parser ?? cachedAggregate?.parser ?? null,
    anchors_found: nullableNonNegativeInteger(input.anchors_found ?? input.anchorsFound ?? cachedAggregate?.anchors_found),
    next_data_found: input.next_data_found === null || input.next_data_found === undefined ? cachedAggregate?.next_data_found ?? null : Boolean(input.next_data_found),
    challenge_detected: Boolean(input.challenge_detected || input.challengeDetected || cachedAggregate?.challenge_detected),
    consent_page_detected: Boolean(input.consent_page_detected || input.consentPageDetected || cachedAggregate?.consent_page_detected),
    duration_ms: nonNegativeInteger(input.duration_ms ?? input.durationMs ?? cachedAggregate?.duration_ms),
    started_at: startedAt,
    finished_at: finishedAt,
    error: input.error ? String(input.error) : cachedAggregate?.error ?? null,
    diagnostic,
    scrape_results: cachedAggregate?.scrape_results ?? (Array.isArray(input.scrape_results) ? input.scrape_results.map((item) => normalizeScrapeResult(item)) : [])
  };

  recordCachedScrapeResult(normalized, input);
  return normalized;
}

export function clearScrapeResultCache() {
  cachedScrapeResults.clear();
}

export function isSuccessfulScrape(result) {
  const normalized = normalizeScrapeResult(result);
  if (!normalized.ok) return false;
  if (!SUCCESSFUL_STATUSES.has(normalized.status)) return false;
  if (normalized.challenge_detected || normalized.consent_page_detected) return false;
  return true;
}

export function isSuspiciousScrape(result) {
  const normalized = normalizeScrapeResult(result);
  if (!normalized.ok) return true;
  if (normalized.challenge_detected || normalized.consent_page_detected) return true;
  return SUSPICIOUS_STATUSES.has(normalized.status) && normalized.status !== SCRAPE_STATUSES.SUCCESS;
}

export function isBaselineSafeScrape(result) {
  const normalized = normalizeScrapeResult(result);
  if (!isSuccessfulScrape(normalized)) return false;
  if (!BASELINE_SAFE_STATUSES.has(normalized.status)) return false;
  if (normalized.status === SCRAPE_STATUSES.LAYOUT_CHANGED || normalized.status === SCRAPE_STATUSES.BLOCKED || normalized.status === SCRAPE_STATUSES.TIMEOUT || normalized.status === SCRAPE_STATUSES.NETWORK_ERROR || normalized.status === SCRAPE_STATUSES.FAILED) return false;
  if (!normalized.result_count_valid) return false;
  if (normalized.anchors_found === 0 && normalized.next_data_found === false && normalized.result_count > 0) return false;
  return true;
}

export function resultCountFromScrape(result) {
  const normalized = normalizeScrapeResult(result);
  return normalized.result_count_valid ? normalized.result_count : null;
}

export function describeScrapeFailure(result) {
  const normalized = normalizeScrapeResult(result);
  if (normalized.challenge_detected || normalized.status === SCRAPE_STATUSES.BLOCKED) return "Bot challenge or access block detected";
  if (normalized.consent_page_detected) return "Consent, login, or interstitial page detected";
  if (normalized.status === SCRAPE_STATUSES.LAYOUT_CHANGED) return "Search page structure was not recognized";
  if (normalized.status === SCRAPE_STATUSES.TIMEOUT) return "Navigation or page-load timeout";
  if (normalized.status === SCRAPE_STATUSES.NETWORK_ERROR) return "Network error while scraping";
  if (normalized.status === SCRAPE_STATUSES.ZERO_RESULTS) return "Valid search page returned zero listings";
  if (normalized.status === SCRAPE_STATUSES.LOW_RESULTS) return "Suspicious result drop";
  if (normalized.status === SCRAPE_STATUSES.PARTIAL) return "Partial scrape completed";
  if (normalized.error) return normalized.error;
  if (normalized.status === SCRAPE_STATUSES.FAILED) return "Unknown scrape failure";
  return "Scrape completed";
}

function aggregateCachedTermResults(input = {}) {
  const terms = normalizeTerms(input.terms);
  if (!terms.length) return null;
  if (input.result_count !== undefined || input.results_count !== undefined || input.count !== undefined) return null;

  pruneCachedScrapeResults();
  const scrapeResults = terms.map((term) => cachedScrapeResults.get(cacheKey(term))?.result).filter(Boolean);
  if (scrapeResults.length !== terms.length) return null;

  const failing = scrapeResults.find((item) => FAILURE_STATUSES.has(item.status) || !item.ok);
  const allCountsValid = scrapeResults.every((item) => item.result_count_valid);
  const resultCount = allCountsValid ? scrapeResults.reduce((total, item) => total + Number(item.result_count || 0), 0) : null;
  const ok = scrapeResults.every((item) => item.ok) && !failing;
  const status = aggregateStatus(scrapeResults, resultCount, failing);

  return {
    status,
    ok,
    result_count: resultCount,
    parser: aggregateParser(scrapeResults),
    anchors_found: aggregateNullableSum(scrapeResults, "anchors_found"),
    next_data_found: aggregateNullableBoolean(scrapeResults, "next_data_found"),
    challenge_detected: scrapeResults.some((item) => item.challenge_detected),
    consent_page_detected: scrapeResults.some((item) => item.consent_page_detected),
    duration_ms: scrapeResults.reduce((total, item) => total + Number(item.duration_ms || 0), 0),
    error: failing?.error || null,
    scrape_results: scrapeResults
  };
}

function aggregateStatus(scrapeResults, resultCount, failing) {
  if (failing) return FAILURE_STATUSES.has(failing.status) ? failing.status : SCRAPE_STATUSES.PARTIAL;
  if (scrapeResults.some((item) => item.status === SCRAPE_STATUSES.PARTIAL)) return SCRAPE_STATUSES.PARTIAL;
  if (scrapeResults.some((item) => item.status === SCRAPE_STATUSES.LOW_RESULTS)) return SCRAPE_STATUSES.LOW_RESULTS;
  if (resultCount === 0 && scrapeResults.every((item) => item.status === SCRAPE_STATUSES.ZERO_RESULTS)) return SCRAPE_STATUSES.ZERO_RESULTS;
  return SCRAPE_STATUSES.SUCCESS;
}

function recordCachedScrapeResult(result, input = {}) {
  if (!result.query || normalizeTerms(input.terms).length) return;
  cachedScrapeResults.set(cacheKey(result.query), { result: { ...result, scrape_results: [] }, cached_at: Date.now() });
  pruneCachedScrapeResults();
}

function pruneCachedScrapeResults() {
  const cutoff = Date.now() - RESULT_CACHE_TTL_MS;
  for (const [key, entry] of cachedScrapeResults.entries()) {
    if (!entry?.cached_at || entry.cached_at < cutoff) cachedScrapeResults.delete(key);
  }
}

function normalizeTerms(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function cacheKey(value) {
  return String(value || "").trim().toLowerCase();
}

function aggregateParser(scrapeResults) {
  const parsers = [...new Set(scrapeResults.map((item) => item.parser).filter(Boolean))];
  if (!parsers.length) return null;
  return parsers.length === 1 ? parsers[0] : parsers.join(" + ");
}

function aggregateNullableSum(items, key) {
  if (items.every((item) => item[key] === null || item[key] === undefined)) return null;
  return items.reduce((total, item) => total + Number(item[key] || 0), 0);
}

function aggregateNullableBoolean(items, key) {
  if (items.every((item) => item[key] === null || item[key] === undefined)) return null;
  return items.some((item) => Boolean(item[key]));
}

function normalizeStatus(status, input = {}) {
  const text = String(status || "").trim().toLowerCase();
  if (VALID_STATUSES.has(text)) return text;
  if (input.challenge_detected || input.challengeDetected) return SCRAPE_STATUSES.BLOCKED;
  if (input.consent_page_detected || input.consentPageDetected) return SCRAPE_STATUSES.BLOCKED;
  if (input.error) return classifyError(input.error);
  return SCRAPE_STATUSES.SUCCESS;
}

function classifyError(error) {
  const text = String(error || "").toLowerCase();
  if (/timeout|timed out|navigation timeout/.test(text)) return SCRAPE_STATUSES.TIMEOUT;
  if (/net::|network|econn|enotfound|socket|dns|fetch failed/.test(text)) return SCRAPE_STATUSES.NETWORK_ERROR;
  if (/captcha|challenge|blocked|unusual traffic|access denied|verify/.test(text)) return SCRAPE_STATUSES.BLOCKED;
  return SCRAPE_STATUSES.FAILED;
}

function nonNegativeInteger(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number);
}

function nullableNonNegativeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number);
}

function normalizeIso(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
