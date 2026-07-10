import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPageSnapshot,
  classifyScrapeStatus,
  detectChallengePage,
  detectConsentPage,
  detectLayoutChange,
  parserLabel,
  validateSearchPage
} from "../src/scrapePageDiagnostics.js";
import { SCRAPE_STATUSES } from "../src/scrapeResult.js";

test("detects challenge pages with multiple signals", () => {
  const snapshot = buildPageSnapshot({
    requested_url: "https://www.carousell.sg/search/gpu",
    final_url: "https://www.carousell.sg/search/gpu",
    page_title: "Security check",
    body_text: "Please verify that you are not a robot. Unusual traffic detected.",
    anchors_found: 0,
    next_data_found: false,
    html: "<html><body>captcha</body></html>"
  });

  assert.equal(detectChallengePage(snapshot), true);
  assert.equal(validateSearchPage(snapshot).challenge_detected, true);
  assert.equal(classifyScrapeStatus(snapshot, []), SCRAPE_STATUSES.BLOCKED);
});

test("detects consent and login interstitial pages", () => {
  const snapshot = buildPageSnapshot({
    requested_url: "https://www.carousell.sg/search/ssd",
    final_url: "https://www.carousell.sg/login",
    page_title: "Log in",
    body_text: "Log in to continue. Continue with Google.",
    anchors_found: 0,
    next_data_found: false,
    html: "<html><body>login</body></html>"
  });

  assert.equal(detectConsentPage(snapshot), true);
  assert.equal(classifyScrapeStatus(snapshot, []), SCRAPE_STATUSES.BLOCKED);
});

test("detects layout change when search structure is missing", () => {
  const snapshot = buildPageSnapshot({
    requested_url: "https://www.carousell.sg/search/rtx%203070",
    final_url: "https://www.carousell.sg/search/rtx%203070",
    page_title: "Carousell",
    body_text: "Welcome",
    anchors_found: 0,
    next_data_found: false,
    expected_search_structure: false,
    html: "<html><body>Welcome to a new shell</body></html>"
  });

  assert.equal(detectLayoutChange(snapshot), true);
  assert.equal(classifyScrapeStatus(snapshot, []), SCRAPE_STATUSES.LAYOUT_CHANGED);
});

test("distinguishes a valid zero-result page from scraper failure", () => {
  const snapshot = buildPageSnapshot({
    requested_url: "https://www.carousell.sg/search/nonexistent-keyword",
    final_url: "https://www.carousell.sg/search/nonexistent-keyword",
    page_title: "Search results",
    body_text: "No results found. Try a different search keyword.",
    anchors_found: 0,
    next_data_found: true,
    html: '<script id="__NEXT_DATA__">{}</script><main>No results found</main>'
  });

  const validation = validateSearchPage(snapshot);
  assert.equal(validation.valid, true);
  assert.equal(classifyScrapeStatus(snapshot, []), SCRAPE_STATUSES.ZERO_RESULTS);
});

test("classifies normal pages and parser label", () => {
  const snapshot = buildPageSnapshot({
    requested_url: "https://www.carousell.sg/search/ssd",
    final_url: "https://www.carousell.sg/search/ssd",
    page_title: "SSD listings",
    body_text: "Sort by Recent Filter Buyer Protection",
    anchors_found: 3,
    next_data_found: true,
    html: '<script id="__NEXT_DATA__">{}</script><a href="/p/test-123">SSD</a>'
  });

  assert.equal(validateSearchPage(snapshot).valid, true);
  assert.equal(classifyScrapeStatus(snapshot, [{ title: "SSD" }]), SCRAPE_STATUSES.SUCCESS);
  assert.equal(parserLabel(snapshot), "DOM + Next data");
});
