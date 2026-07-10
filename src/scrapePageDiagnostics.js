import { SCRAPE_STATUSES } from "./scrapeResult.js";

const CHALLENGE_PATTERNS = [
  /captcha/i,
  /security\s+check/i,
  /unusual\s+traffic/i,
  /verify\s+(?:you|yourself|that\s+you)/i,
  /access\s+denied/i,
  /blocked/i,
  /robot/i,
  /automated\s+(?:traffic|requests)/i,
  /cloudflare/i,
  /checking\s+your\s+browser/i,
  /too\s+many\s+requests/i
];

const CONSENT_PATTERNS = [
  /accept\s+(?:all\s+)?cookies/i,
  /cookie\s+(?:settings|preferences|policy)/i,
  /privacy\s+(?:settings|preferences)/i,
  /consent/i,
  /log\s*in\s+to\s+continue/i,
  /sign\s*up\s+to\s+continue/i,
  /continue\s+with\s+(?:google|facebook|apple|email)/i
];

const VALID_ZERO_PATTERNS = [
  /no\s+(?:results|listings|items)\s+(?:found|yet)?/i,
  /we\s+could(?:n['’]?t| not)\s+find/i,
  /try\s+(?:another|a different)\s+(?:keyword|search)/i,
  /change\s+your\s+search/i
];

const SEARCH_STRUCTURE_PATTERNS = [
  /sort\s+by/i,
  /filter/i,
  /recent/i,
  /search\s+results/i,
  /buyer\s+protection/i,
  /carousell/i
];

export function buildPageSnapshot(input = {}) {
  const html = String(input.html || "");
  const bodyText = compactText(input.body_text ?? input.bodyText ?? "");
  const title = String(input.page_title ?? input.title ?? "").trim();
  const finalUrl = String(input.final_url ?? input.finalUrl ?? input.url ?? "").trim();
  const requestedUrl = String(input.requested_url ?? input.requestedUrl ?? "").trim();
  const anchorsFound = nullableCount(input.anchors_found ?? input.anchorsFound);
  const nextDataFound = input.next_data_found ?? input.nextDataFound;
  const expectedSearchStructure = input.expected_search_structure === undefined
    ? hasExpectedSearchStructure({ html, bodyText })
    : Boolean(input.expected_search_structure);

  return {
    requested_url: requestedUrl,
    final_url: finalUrl,
    page_title: title,
    body_text_sample: bodyText.slice(0, 1000),
    html_length: nullableCount(input.html_length ?? input.htmlLength) ?? html.length,
    anchors_found: anchorsFound,
    next_data_found: nextDataFound === null || nextDataFound === undefined ? htmlHasNextData(html) : Boolean(nextDataFound),
    expected_search_structure: expectedSearchStructure,
    redirected_away_from_search: detectSearchRedirect(requestedUrl, finalUrl),
    suspiciously_empty: isSuspiciouslyEmpty({ html, bodyText }),
    valid_zero_result_hint: VALID_ZERO_PATTERNS.some((pattern) => pattern.test(`${title}\n${bodyText}`))
  };
}

export function detectChallengePage(snapshot = {}) {
  const text = snapshotText(snapshot);
  return CHALLENGE_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectConsentPage(snapshot = {}) {
  const text = snapshotText(snapshot);
  const finalUrl = String(snapshot.final_url || "");
  if (/\/login|\/signup|\/users\/sign/i.test(finalUrl)) return true;
  return CONSENT_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectLayoutChange(snapshot = {}) {
  if (detectChallengePage(snapshot) || detectConsentPage(snapshot)) return false;
  const anchors = nullableCount(snapshot.anchors_found);
  const nextData = snapshot.next_data_found === null || snapshot.next_data_found === undefined ? null : Boolean(snapshot.next_data_found);
  if (snapshot.redirected_away_from_search) return true;
  if (snapshot.suspiciously_empty) return true;
  if (anchors === 0 && nextData === false && !snapshot.expected_search_structure && !snapshot.valid_zero_result_hint) return true;
  return false;
}

export function validateSearchPage(snapshot = {}) {
  const challengeDetected = detectChallengePage(snapshot);
  const consentPageDetected = detectConsentPage(snapshot);
  const layoutChanged = detectLayoutChange(snapshot);
  const anchors = nullableCount(snapshot.anchors_found);
  const hasListings = anchors !== null && anchors > 0;
  const hasExpectedStructure = Boolean(snapshot.expected_search_structure || snapshot.next_data_found || snapshot.valid_zero_result_hint);
  const onSearchRoute = isSearchRoute(snapshot.final_url || snapshot.requested_url);
  const valid = !challengeDetected && !consentPageDetected && !layoutChanged && (hasListings || (onSearchRoute && hasExpectedStructure));

  return {
    valid,
    challenge_detected: challengeDetected,
    consent_page_detected: consentPageDetected,
    layout_changed: layoutChanged,
    reason: challengeDetected ? "challenge" : consentPageDetected ? "consent" : layoutChanged ? "layout_changed" : valid ? "valid_search_page" : "unknown"
  };
}

export function classifyScrapeStatus(snapshot = {}, listings = [], error = null) {
  const validation = validateSearchPage(snapshot);
  const count = Array.isArray(listings) ? listings.length : 0;
  if (validation.challenge_detected) return SCRAPE_STATUSES.BLOCKED;
  if (validation.consent_page_detected) return SCRAPE_STATUSES.BLOCKED;
  if (error && !validation.valid) return classifyScrapeError(error);
  if (validation.layout_changed) return SCRAPE_STATUSES.LAYOUT_CHANGED;
  if (!validation.valid) return SCRAPE_STATUSES.LAYOUT_CHANGED;
  if (count === 0) return SCRAPE_STATUSES.ZERO_RESULTS;
  return SCRAPE_STATUSES.SUCCESS;
}

export function classifyScrapeError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  if (/timeout|timed out|navigation timeout/.test(text)) return SCRAPE_STATUSES.TIMEOUT;
  if (/net::|network|econn|enotfound|socket|dns|fetch failed|connection|tls|ssl/.test(text)) return SCRAPE_STATUSES.NETWORK_ERROR;
  if (/captcha|challenge|blocked|unusual traffic|access denied|verify|security check/.test(text)) return SCRAPE_STATUSES.BLOCKED;
  return SCRAPE_STATUSES.FAILED;
}

export function parserLabel(snapshot = {}) {
  const parts = [];
  if (Number(snapshot.anchors_found || 0) > 0) parts.push("DOM");
  if (snapshot.next_data_found) parts.push("Next data");
  return parts.length ? parts.join(" + ") : null;
}

function snapshotText(snapshot = {}) {
  return `${snapshot.page_title || ""}\n${snapshot.body_text_sample || snapshot.body_text || ""}\n${snapshot.final_url || ""}`;
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function nullableCount(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number);
}

function htmlHasNextData(html) {
  return /<script[^>]+id=["']__NEXT_DATA__["']/i.test(String(html || ""));
}

function hasExpectedSearchStructure({ html = "", bodyText = "" } = {}) {
  const text = `${stripTags(html).slice(0, 5000)}\n${bodyText}`;
  return SEARCH_STRUCTURE_PATTERNS.some((pattern) => pattern.test(text)) || VALID_ZERO_PATTERNS.some((pattern) => pattern.test(text));
}

function detectSearchRedirect(requestedUrl, finalUrl) {
  if (!requestedUrl || !finalUrl) return false;
  if (!isSearchRoute(requestedUrl)) return false;
  if (isSearchRoute(finalUrl)) return false;
  try {
    const requested = new URL(requestedUrl);
    const final = new URL(finalUrl);
    return requested.hostname !== final.hostname || !/\/search\//i.test(final.pathname);
  } catch {
    return false;
  }
}

function isSearchRoute(value) {
  try {
    const url = new URL(String(value || ""));
    return /\/search\//i.test(url.pathname) || url.searchParams.has("searchId");
  } catch {
    return /\/search\//i.test(String(value || ""));
  }
}

function isSuspiciouslyEmpty({ html = "", bodyText = "" } = {}) {
  const length = String(html || "").length;
  const textLength = compactText(bodyText).length;
  return length > 0 && length < 1200 && textLength < 80;
}

function stripTags(value) {
  return String(value || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ");
}
