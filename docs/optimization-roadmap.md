# Carousell Bot Optimization Roadmap

This roadmap is a planning document for improving the Carousell bot across performance, deal intelligence, reliability, and user experience.

It separates **confirmed issues** from **proposed improvements**. Any performance numbers below are **targets or expected impact**, not guaranteed results, until baseline measurements prove them.

## Current optimization work already merged from PR #15

PR #15 already included these changes:

- Shared Playwright Chromium reuse for plus hydration.
- Safer browser singleton state with `sharedBrowser` plus `sharedBrowserPromise`.
- Cleanup handling for browser disconnects, launch failures, and process shutdown.
- Scoped listings cache around expensive `buildListings -> duplicate grouping -> rolling medians` work.
- Cache clear after hydrated listings are written.
- Optional performance logging with `PERF_LOG=1`.
- Cheaper listing fingerprinting using ISO timestamp string comparison instead of repeated `Date.parse()`.

These should be treated as the first performance patch, not the final architecture.

---

## Baseline measurements required before more optimization

Before implementing the next wave, measure the current system with real data sizes.

### Required timing points

Keep or add timing logs around:

```js
getState()
buildListings()
applyScopedDuplicateInfo()
applyRollingCategoryMedians()
getAlerts()
shouldSuppressAlert()
searchAndStoreStartUrls()
hydrateCarousellListings()
readJson("listings")
writeJson("listings")
```

### Recommended test sizes

Measure with:

| Dataset size | Purpose |
|---:|---|
| 100 listings | Small local MVP baseline |
| 1,000 listings | Realistic active watchlist usage |
| 5,000 listings | Stress test |
| 10,000 listings | Long-term ceiling test |

### Metrics to capture

| Metric | Target direction |
|---|---|
| `/api/listings` p50/p95 latency | Lower |
| `/api/deals` p50/p95 latency | Lower |
| Hydration time per listing | Lower |
| Chromium processes | Stable, no leaks |
| Memory after 1h idle | Stable |
| Memory after 100 hydrations | Stable |
| Alert suppression time | Lower |
| Cache hit rate | Higher |
| Duplicate group build time | Lower |

Run locally with:

```bash
PERF_LOG=1 npm run dev
```

Then hit:

```txt
/api/listings
/api/deals
/api/search
/api/export/listings.csv
/api/export/deals.csv
```

---

## Priority framework

Each initiative uses:

- **Priority**: P0 urgent, P1 high, P2 medium, P3 later.
- **Effort**: rough engineering estimate.
- **Risk**: chance of breaking current behavior.
- **Type**: performance, intelligence, robustness, or UX.

---

# Part 1: Performance

## Initiative 1 — Store-level state versioning

**Type:** Performance  
**Priority:** P0  
**Effort:** 3-5h  
**Risk:** Medium

### Current state

The app builds cache keys by walking listings and hashing parts of state in `server-plus.js`.

### Problem

Even with cheaper timestamp comparison, route-level cache fingerprinting still loops over every listing on every request. That is better than rebuilding analytics, but not ideal at larger data sizes.

### Solution

Move invalidation into `store.js` with a monotonic version counter.

```js
let stateVersion = 0;

function bumpStateVersion(reason) {
  stateVersion += 1;
  lastStateMutation = { reason, at: new Date().toISOString(), version: stateVersion };
}

export function getStateVersion() {
  return stateVersion;
}
```

Every write path should bump the version:

```js
writeJson(name, value)
upsertListing(listing)
bulkUpsertListings(listings)
upsertWatchedSearch(input)
deleteWatchedSearch(id)
createAlert(input)
markAlertsRead()
```

Then route caches can key by:

```js
const key = `${getStateVersion()}|${filterFingerprint(query, options)}`;
```

### Expected impact

Avoids scanning all listings just to decide whether cached data is still valid.

### Testing

- Unit test that `getStateVersion()` increments after each write.
- Test that read-only calls do not increment version.
- Test that cached listings update after `writeJson("listings")`.

---

## Initiative 2 — Push filtering and pagination into SQLite

**Type:** Performance  
**Priority:** P0  
**Effort:** 4-7h  
**Risk:** Medium

### Current state

The API often loads all listings, builds enriched listing objects, then filters in memory.

### Problem

For large datasets, filtering after loading everything wastes CPU and memory.

### Solution

Add query helpers to `store.js`:

```js
export function queryListings({ q, minPrice, maxPrice, limit = 100, offset = 0 }) {
  const where = [];
  const params = {};

  if (q) {
    where.push("(title LIKE @q OR description LIKE @q OR category LIKE @q)");
    params.q = `%${q}%`;
  }
  if (minPrice !== undefined) {
    where.push("current_price >= @minPrice");
    params.minPrice = Number(minPrice);
  }
  if (maxPrice !== undefined) {
    where.push("current_price <= @maxPrice");
    params.maxPrice = Number(maxPrice);
  }

  return db.prepare(`
    SELECT payload FROM listings
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY scraped_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset }).map((row) => parsePayload(row.payload));
}
```

Add indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_listings_price ON listings(current_price);
CREATE INDEX IF NOT EXISTS idx_listings_scraped_at ON listings(scraped_at);
CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category);
CREATE INDEX IF NOT EXISTS idx_listings_seller_id ON listings(seller_id);
```

### Expected impact

Target: reduce API response work by avoiding full dataset scans for common filtered views.

### Testing

- Compare results of old in-memory filtering vs SQLite filtering.
- Test min/max price filters.
- Test query matching.
- Test pagination boundaries.

---

## Initiative 3 — Market stats cache

**Type:** Performance / Intelligence  
**Priority:** P1  
**Effort:** 3-5h  
**Risk:** Low-Medium

### Current state

Market medians and insights are derived repeatedly from listing data.

### Problem

Market stats are slow to rebuild and should not change unless listings or price history change.

### Solution

Create a `market_stats` table or persisted JSON collection.

```js
{
  bucket_key: "electronics:rtx-3070",
  median_price: 300,
  average_price: 315,
  min_price: 220,
  max_price: 420,
  sample_size: 42,
  calculated_at: "2026-07-10T00:00:00.000Z"
}
```

Recompute when:

- Listings change.
- Price history changes.
- A scheduled daily refresh runs.

### Expected impact

Makes scoring and digest generation more stable and faster.

### Testing

- Given a known set of listings, verify median calculation.
- Verify stale stats are rebuilt after listing writes.
- Verify suspicious-low ratings still work.

---

## Initiative 4 — Alert dedupe index

**Type:** Performance / Robustness  
**Priority:** P1  
**Effort:** 1-2h  
**Risk:** Low

### Current state

Alert suppression scans recent alerts to detect duplicates.

### Problem

Repeated scans get slower as alert history grows.

### Solution

Store and index `alert_key` directly.

SQLite migration:

```sql
ALTER TABLE alerts ADD COLUMN alert_key TEXT;
CREATE INDEX IF NOT EXISTS idx_alerts_alert_key ON alerts(alert_key);
```

Helper:

```js
export function hasSentAlertKey(alertKey) {
  if (!alertKey) return false;
  return Boolean(db.prepare(`
    SELECT 1 FROM alerts
    WHERE alert_key = ? AND sent_at IS NOT NULL
    LIMIT 1
  `).get(alertKey));
}
```

### Expected impact

Turns alert dedupe from repeated scans into indexed lookup.

### Testing

- Same alert is suppressed.
- Price-drop alerts can still fire for different new prices.
- Failed alerts do not suppress future successful alerts.

---

## Initiative 5 — Browser page pool and concurrency limiter

**Type:** Performance / Robustness  
**Priority:** P1  
**Effort:** 4-6h  
**Risk:** Medium

### Current state

PR #15 reuses a shared Chromium browser. Pages are still created per listing.

### Problem

Unbounded or poorly coordinated hydration jobs can still create too many pages at once.

### Solution

Add a small queue/limiter around page creation.

```js
const pageQueue = [];
let activePages = 0;
const MAX_PAGES = Number(process.env.PLAYWRIGHT_MAX_PAGES || 4);

async function withPage(browser, fn) {
  await acquirePageSlot();
  let page;
  try {
    page = await browser.newPage({ locale: "en-SG", timezoneId: "Asia/Singapore", userAgent: USER_AGENT });
    return await fn(page);
  } finally {
    await page?.close().catch(() => {});
    releasePageSlot();
  }
}
```

### Expected impact

Prevents memory spikes and Chromium overload during multiple concurrent hydration jobs.

### Testing

- Start multiple hydration jobs concurrently.
- Assert active pages never exceed max.
- Verify failed pages release slots.

---

## Initiative 6 — Avoid repeated price history calls inside listing builds

**Type:** Performance  
**Priority:** P1  
**Effort:** 2-4h  
**Risk:** Low-Medium

### Current state

Listing building may attach price history per listing.

### Problem

Calling `getPriceHistory(id)` for many listings can become N+1 database work.

### Solution

Batch load price histories:

```js
export function getPriceHistories(listingIds = []) {
  if (!listingIds.length) return new Map();
  const placeholders = listingIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT listing_id, price, recorded_at
    FROM price_history
    WHERE listing_id IN (${placeholders})
    ORDER BY listing_id ASC, recorded_at ASC, id ASC
  `).all(...listingIds.map(Number));

  const byListing = new Map();
  for (const row of rows) {
    if (!byListing.has(row.listing_id)) byListing.set(row.listing_id, []);
    byListing.get(row.listing_id).push(row);
  }
  return byListing;
}
```

### Expected impact

Reduces repeated DB work on listing-heavy endpoints.

### Testing

- Verify batch result equals individual calls.
- Test empty input.
- Test deleted/missing listing IDs.

---

# Part 2: Deal intelligence

## Initiative 7 — Separate deal score, risk score, and final score

**Type:** Intelligence  
**Priority:** P0  
**Effort:** 3-5h  
**Risk:** Medium

### Current state

Listings are scored as deals, but suspicious listings may still look attractive if cheap.

### Problem

Cheap fake-looking listings can accidentally rank too high.

### Solution

Use separate scores:

```js
{
  dealScore: 82,
  riskScore: 24,
  finalScore: 68,
  dealReasons: ["18% below market median", "Exact keyword match"],
  riskReasons: ["Seller has few reviews"]
}
```

Formula:

```js
finalScore = clamp(dealScore - riskScore * 0.6);
```

### Expected impact

Scams and suspicious listings become visible without being over-promoted.

### Testing

- Very cheap listing with risky keywords should have high risk.
- Normal below-market listing should keep high final score.
- Placeholder price should not become top-ranked.

---

## Initiative 8 — Rule-based fake/scam risk detection

**Type:** Intelligence / Safety  
**Priority:** P0  
**Effort:** 4-6h  
**Risk:** Medium

### Current state

Suspicious price ratings exist, but there is no full fake-item risk model.

### Problem

The bot should not claim certainty that an item is fake. It should produce a risk score with reasons.

### Solution

Create `src/services/riskScorer.js`.

Risk signals:

- Price far below market median.
- Placeholder prices: `S$0`, `S$1`, `S$123`, `S$8888`.
- Description asks for deposit or off-platform contact.
- Missing/short description.
- Missing images.
- Duplicate/reposted listing.
- Seller has low or missing trust signals.

```js
const RISKY_KEYWORDS = [
  "deposit",
  "reservation fee",
  "telegram",
  "whatsapp only",
  "paynow first",
  "delivery only",
  "no meetups",
  "dm for price",
  "pm for price"
];
```

Return:

```js
{
  riskScore: 72,
  riskLevel: "high",
  reasons: [
    "Price is more than 40% below market median",
    "Contains risky keyword: deposit"
  ]
}
```

### Expected impact

Improves trust in daily digest and dashboard rankings.

### Testing

- Risky keyword tests.
- Placeholder price tests.
- Market-median discount tests.
- Explanation reason tests.

---

## Initiative 9 — Price trend detection

**Type:** Intelligence  
**Priority:** P1  
**Effort:** 3-5h  
**Risk:** Low

### Current state

Price history exists, but users do not get strong trend context.

### Problem

A listing can be a good deal because the price dropped, or a bad deal because the whole market is falling.

### Solution

Add trend fields:

```js
{
  priceTrend: "falling",
  priceDropPercent: 12,
  marketTrend: "stable",
  trendReasons: ["Seller dropped price twice in 7 days"]
}
```

Trend categories:

- `new_listing`
- `stable`
- `falling`
- `rising`
- `volatile`

### Expected impact

Better deal explanations and better daily digest summaries.

### Testing

- Price history with falling prices returns `falling`.
- Flat history returns `stable`.
- Mixed changes returns `volatile`.

---

## Initiative 10 — Duplicate and repost confidence score

**Type:** Intelligence / Robustness  
**Priority:** P1  
**Effort:** 3-5h  
**Risk:** Medium

### Current state

Duplicate grouping exists, but confidence could be clearer.

### Problem

Some listings are exact duplicates. Others are similar but not the same. Treating them identically can cause bad merges.

### Solution

Return duplicate confidence:

```js
{
  duplicateGroupId: "dup-12",
  duplicateConfidence: 0.86,
  duplicateReasons: ["same seller", "similar title", "same price band"]
}
```

Signals:

- Same Carousell ID: 1.0 confidence.
- Same seller + title tokens + price band: high.
- Same image hash: high.
- Similar title only: medium.

### Expected impact

Cleaner dashboard and fewer repeated alerts.

### Testing

- Same listing ID groups together.
- Same title but different sellers does not auto-merge with high confidence.
- Manual overrides still work.

---

## Initiative 11 — Local image hash comparison

**Type:** Intelligence  
**Priority:** P2  
**Effort:** 4-8h  
**Risk:** Medium

### Current state

The app stores image URLs and proxies/cache images.

### Problem

Fake or reposted listings often reuse the same images.

### Solution

Add local perceptual-ish hashing using downloaded/cached images. Start simple with normalized URL hash, then upgrade later.

Fields:

```js
{
  image_hashes: ["abc123", "def456"],
  reused_image_count: 3,
  image_reuse_risk: "medium"
}
```

Do **not** start with internet reverse image search. Local comparison is safer, cheaper, and enough for MVP.

### Expected impact

Finds repeated scam/repost patterns within your own database.

### Testing

- Same image URL produces same hash.
- Different images do not collide too often.
- Missing images handled safely.

---

# Part 3: Robustness

## Initiative 12 — Stronger hydration job lifecycle

**Type:** Robustness  
**Priority:** P1  
**Effort:** 3-5h  
**Risk:** Medium

### Current state

Hydration jobs are tracked in memory.

### Problem

If the server restarts, queued/running hydration state disappears.

### Solution

Persist hydration jobs:

```js
{
  id,
  status,
  total,
  completed,
  failed,
  started_at,
  completed_at,
  error,
  listing_ids
}
```

On startup:

- Mark stale `running` jobs as `interrupted`.
- Allow user to retry interrupted jobs.

### Expected impact

Better debugging and less confusion when long jobs fail.

### Testing

- Job survives restart as interrupted.
- Retry creates a new job or resumes safely.
- Failed listing count is accurate.

---

## Initiative 13 — Atomic writes for JSON fallback

**Type:** Robustness  
**Priority:** P2  
**Effort:** 2-3h  
**Risk:** Low

### Current state

SQLite is primary when available, but JSON fallback still exists.

### Problem

A crash during JSON write can corrupt a file.

### Solution

Write to temp file then rename:

```js
function writeJsonFileAtomic(name, value) {
  const filePath = jsonPaths[name];
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}
```

### Expected impact

Safer fallback storage.

### Testing

- Write then read returns same object.
- Existing file stays valid if temp write fails.

---

## Initiative 14 — Error classification and retry policy

**Type:** Robustness  
**Priority:** P2  
**Effort:** 3-5h  
**Risk:** Low-Medium

### Current state

Hydration errors are mostly treated generically.

### Problem

Network timeout, blocked page, missing listing, and parser failure need different handling.

### Solution

Classify errors:

```js
{
  type: "timeout" | "not_found" | "blocked" | "parse_error" | "unknown",
  retryable: true,
  retry_after_minutes: 30
}
```

Retry policy:

- Timeout: retry later.
- 404/deleted: do not retry often.
- Blocked/captcha: slow down and reduce concurrency.
- Parse error: log sample HTML metadata.

### Expected impact

Fewer wasted retries and clearer troubleshooting.

### Testing

- Simulated timeout maps to retryable.
- Simulated not found maps to non-retryable.
- Retry count stops at max.

---

# Part 4: UX and workflow

## Initiative 15 — Daily digest risk badges and explanations

**Type:** UX / Intelligence  
**Priority:** P1  
**Effort:** 2-4h  
**Risk:** Low

### Current state

Daily digest sends deal candidates.

### Problem

The email should explain why a listing is good and whether it is risky.

### Solution

Add badges:

```txt
LOW RISK
MEDIUM RISK
HIGH RISK
```

Email row example:

```txt
RTX 3070 Ventus — S$260
Deal: 82 | Risk: 22 | Final: 69
Why: 18% below market median, seller has normal history
Warning: none
```

### Expected impact

More useful daily email with less manual checking.

### Testing

- High-risk listing shows warning badge.
- Low-risk listing shows no scare wording.
- Missing risk score falls back cleanly.

---

## Initiative 16 — Feedback loop in dashboard and email

**Type:** UX / Intelligence  
**Priority:** P2  
**Effort:** 4-7h  
**Risk:** Medium

### Current state

Feedback labels already exist.

### Problem

The algorithm improves only if feedback is easy to give.

### Solution

Add actions:

- Good deal.
- Bad deal.
- Suspicious.
- Not relevant.
- Ignore seller.
- Ignore keyword.

Store structured feedback:

```js
{
  listing_id,
  feedback_type: "good" | "bad_deal" | "suspicious" | "not_relevant",
  note,
  created_at
}
```

Use feedback in scoring:

- Positive feedback boosts similar future listings.
- Suspicious feedback increases risk for repeated seller/image/title patterns.
- Not relevant feedback reduces category/token match weight.

### Expected impact

The bot learns your personal buying preferences without needing ML first.

### Testing

- Feedback updates listing label.
- Feedback changes future score explanation.
- Unmarking feedback reverts effect.

---

# Effort, risk, and priority matrix

| # | Initiative | Priority | Effort | Risk | Type |
|---:|---|---|---:|---|---|
| 1 | Store-level state versioning | P0 | 3-5h | Medium | Performance |
| 2 | SQLite filtering and pagination | P0 | 4-7h | Medium | Performance |
| 3 | Market stats cache | P1 | 3-5h | Low-Med | Performance/Intel |
| 4 | Alert dedupe index | P1 | 1-2h | Low | Performance/Robustness |
| 5 | Browser page pool/concurrency limiter | P1 | 4-6h | Medium | Performance/Robustness |
| 6 | Batch price history loading | P1 | 2-4h | Low-Med | Performance |
| 7 | Separate deal/risk/final score | P0 | 3-5h | Medium | Intelligence |
| 8 | Rule-based fake/scam risk detection | P0 | 4-6h | Medium | Intelligence |
| 9 | Price trend detection | P1 | 3-5h | Low | Intelligence |
| 10 | Duplicate/repost confidence | P1 | 3-5h | Medium | Intelligence |
| 11 | Local image hash comparison | P2 | 4-8h | Medium | Intelligence |
| 12 | Hydration job lifecycle | P1 | 3-5h | Medium | Robustness |
| 13 | Atomic JSON fallback writes | P2 | 2-3h | Low | Robustness |
| 14 | Error classification/retry policy | P2 | 3-5h | Low-Med | Robustness |
| 15 | Digest risk badges/explanations | P1 | 2-4h | Low | UX |
| 16 | Feedback loop improvements | P2 | 4-7h | Medium | UX/Intel |

---

# Four-week implementation plan

## Week 1 — Stabilize and measure

Goal: prove current bottlenecks and remove easy waste.

- Keep PR #15 improvements.
- Add baseline measurement script.
- Implement store-level state versioning.
- Implement alert dedupe index.
- Add tests for browser singleton and cache invalidation.

## Week 2 — Make the API scale

Goal: stop loading and rebuilding everything for common routes.

- Push filtering and pagination into SQLite.
- Add listing indexes.
- Batch price history loading.
- Add market stats cache.

## Week 3 — Make ranking smarter

Goal: reduce bad recommendations and suspicious top deals.

- Separate deal/risk/final scores.
- Add rule-based risk scorer.
- Add price trend detection.
- Add duplicate confidence reasons.

## Week 4 — Improve user trust and workflow

Goal: make the bot easier to act on.

- Add risk badges to digest.
- Add better explanation text.
- Add dashboard/email feedback actions.
- Add hydration job persistence or retry classification.

---

# Testing strategy

## Unit tests

### State versioning

```js
test("state version increments after listing write", () => {
  const before = getStateVersion();
  upsertListing({ id: 999, title: "test", current_price: 1 });
  assert.equal(getStateVersion(), before + 1);
});
```

### Risk scoring

```js
test("placeholder price raises risk", () => {
  const result = scoreRisk({ title: "RTX 3070", current_price: 1, description: "pm" }, { median_price: 300 });
  assert.ok(result.riskScore >= 50);
  assert.ok(result.reasons.some((reason) => /placeholder/i.test(reason)));
});
```

### Alert dedupe

```js
test("same alert key is suppressed after successful send", () => {
  createAlert({ alert_key: "new_deal:1:123:once", sent_at: new Date().toISOString() });
  assert.equal(hasSentAlertKey("new_deal:1:123:once"), true);
});
```

### Browser singleton

```js
test("concurrent hydration calls share one launch", async () => {
  const calls = await Promise.all([getSharedBrowser(), getSharedBrowser(), getSharedBrowser()]);
  assert.equal(new Set(calls).size, 1);
});
```

This may require exporting an internal test helper or testing through a browser manager module.

## Integration tests

- Seed 1,000 fake listings.
- Hit `/api/listings` twice.
- Confirm second request is faster when cache is warm.
- Update one listing.
- Confirm cache invalidates.

## Manual tests

- Run search.
- Confirm hydration job starts.
- Confirm only one Chromium process is reused under normal flow.
- Kill Chromium manually.
- Confirm next hydration launches one replacement browser.

---

# Monitoring and success metrics

Add a lightweight metrics endpoint later:

```txt
/api/metrics
```

Example response:

```js
{
  cache: {
    scopedListingsHits: 120,
    scopedListingsMisses: 12,
    hitRate: 0.91
  },
  hydration: {
    activePages: 2,
    totalHydrated: 430,
    failed: 12
  },
  api: {
    listingsP50Ms: 80,
    listingsP95Ms: 220
  }
}
```

Avoid building a full observability stack. Basic counters and timing summaries are enough for this project.

---

# Recommended next PR order

1. **PR A:** Store state versioning + cache invalidation cleanup.
2. **PR B:** SQLite query filtering + indexes.
3. **PR C:** Alert dedupe index.
4. **PR D:** Deal/risk/final score split.
5. **PR E:** Rule-based fake/scam risk scorer.
6. **PR F:** Digest risk badges and explanation improvements.
7. **PR G:** Price trends and duplicate confidence.
8. **PR H:** Browser page pool and hydration job persistence.

---

# Blunt guidance

Do not optimize everything at once.

The strongest order is:

```txt
measure -> cache invalidation -> SQLite filtering -> alert index -> risk scoring -> digest UX
```

The riskiest mistake would be adding AI fake detection before the deterministic rule-based system is good. Start with explainable rules, collect feedback, then consider ML/AI later if the data proves it is needed.
