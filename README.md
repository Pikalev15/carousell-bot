# Carousell Bot

A local-first Carousell Singapore search, deal-ranking, watchlist, alerting, and marketplace-analysis dashboard.

Carousell Bot is built for personal marketplace monitoring. It searches Carousell with Playwright, stores observations locally, filters noisy listings, ranks likely deals, tracks price/history changes, alerts you through Telegram or email, and learns from manual feedback.

The project is intended for personal local or LAN/NAS use. It is **not** a hosted SaaS service and should not be exposed directly to the public internet.

## Current status

**v1.0 status: NAS-ready stable baseline.**

The app now has a working Docker/NAS deployment path, a unified default runtime, dashboard search, watched searches, Telegram alerts, alert mark-read reliability, duplicate handling, scraper diagnostics, SQLite-first persistence, JSON fallback, and a passing Node test suite.

This does not mean the project is finished forever. It means the current `main` branch is a usable baseline that can run continuously on a home NAS.

Important limitations:

- Carousell can change its frontend or anti-automation behavior at any time.
- Scraper diagnostics reduce false baselines, but real-world scraping still needs monitoring.
- Deal scores depend on extracted price, title, description, model, condition, seller, and market data quality.
- Seller ratings and detail fields may be unavailable until hydration succeeds.
- SQLite is preferred, but selected fallback/local state remains JSON-based.
- Default runtime is unified through `src/server-unified.js`; the legacy core `src/server.js` remains available mainly for debugging.
- The app is designed for one trusted user/household, not untrusted multi-user hosting.

## Highlights

- Playwright-powered Carousell search using bundled Chromium
- Browser dashboard for search, review, filtering, and training
- Unified default runtime via `src/server-unified.js`
- SQLite-first storage with automatic JSON migration and JSON fallback
- Listing classification and multi-factor deal scoring
- Confidence scores, risk flags, penalties, and negotiation estimates
- Watched searches with scheduler, jitter, per-watch failure isolation, and health checks
- Structured scrape outcomes such as success, zero-results, blocked, layout-changed, timeout, network error, and failure
- Telegram deal alerts, scrape-health warnings, commands, and training buttons
- Optional daily Gmail SMTP deal digest
- Listing detail hydration and data-enrichment tools
- Price history and duplicate-aware merged price history
- Duplicate grouping with manual merge and split overrides
- Seller blacklist and seller reputation history
- Listing snoozing and watched-search muting
- Refined feedback labels and preference-model retraining
- Rolling category median auto-tuning
- Search history, alert history, and activity logs
- CSV and JSON export routes
- Import/export bundles for backup and migration
- Carousell start-URL parsing and multi-URL searches
- Cached listing views and optional performance logging
- Docker and NAS deployment files

## Requirements

- Node.js 22.5 or newer
- npm
- Network access to Carousell Singapore
- Enough disk space for Playwright Chromium and local data
- Docker and Docker Compose for NAS deployment

The project uses the full `playwright` package. During installation, the `postinstall` script runs:

```bash
playwright install chromium
```

A separate Chrome installation and `CHROME_PATH` are not required for the normal setup.

## Quick start: local Node runtime

```bash
git clone https://github.com/Pikalev15/carousell-bot.git
cd carousell-bot
npm install
cp data/config.example.json data/config.json
npm test
npm start
```

Open:

```text
http://localhost:3000
```

On Windows, `start-local.bat` can also launch the project.

## Quick start: NAS Docker runtime

The normal NAS update flow is:

```bash
cd ~/carousell-bot
git pull origin main
docker compose up -d --build
```

Check logs:

```bash
docker compose logs -f
```

Check container status:

```bash
docker compose ps
```

Health check from the NAS:

```bash
curl http://localhost:3000/api/health
```

Expected response:

```json
{"ok":true}
```

For a clean restart:

```bash
docker compose down
docker compose up -d --build
```

Persist the `data/` directory or database path so searches, alerts, watchlists, labels, config, and history survive container rebuilds.

## Watchtower note

Watchtower can update containers only when the running service uses an image from a registry such as Docker Hub or GHCR.

If `docker-compose.yml` uses:

```yaml
services:
  carousell-bot:
    build: .
```

then Watchtower will **not** pull Git changes or rebuild the app. Use:

```bash
git pull origin main
docker compose up -d --build
```

Watchtower becomes useful later if the project publishes a versioned image, for example:

```yaml
services:
  carousell-bot:
    image: ghcr.io/pikalev15/carousell-bot:latest
```

That would require a GitHub Actions image build/push workflow.

## Runtime commands

```bash
npm start              # Default unified runtime: src/server-unified.js
npm run dev            # Same runtime without a separate build step
npm run start:plus     # Explicit unified-runtime alias
npm run start:core     # Legacy core server only, mainly for debugging
npm run migrate        # Migrate supported JSON data into SQLite
npm run clean:images   # Clean cached listing images
npm run enrich:data    # Enrich stored listing data
npm run medians:default
npm run export:data
npm run debug:duplicates
npm test
```

## Dashboard authentication

Set a long random dashboard token before making the service reachable from other devices:

```bash
DASHBOARD_TOKEN=replace-with-a-long-random-string npm start
```

For Docker Compose, set it in the service environment or `.env` file.

When configured, every `/api/*` route except `/api/health` requires the token. The dashboard stores the supplied token in `sessionStorage` for the current browser tab/session.

Authentication can be supplied through:

- `x-dashboard-token`
- `Authorization: Bearer <token>`
- The dashboard session cookie used by the local UI

Do not expose an unauthenticated instance on a NAS, reverse proxy, port forward, or public tunnel.

## Core workflow

1. Enter a search query or one or more supported Carousell start URLs.
2. The scraper opens Carousell with Playwright.
3. Visible listing cards and supported structured page data are parsed.
4. The scraper records diagnostics about the page shape and result count.
5. New and changed listings are stored.
6. Optional detail hydration retrieves descriptions, sellers, locations, images, and better price information.
7. Listings are classified and scored.
8. Duplicate metadata, market medians, feedback, watch rules, snoozes, and seller rules are applied.
9. The dashboard displays results and alerts qualifying deals.
10. Manual labels improve future preference scoring.

## Search and scraping

The scraper combines several extraction paths:

- Visible DOM anchors linking to listing pages
- Card text and images collected from surrounding DOM nodes
- Supported `__NEXT_DATA__` structures when present
- HTML-anchor parsing as a fallback
- Optional per-listing detail-page hydration

Search modes include:

- Normal query search
- Larger “search more” runs
- Carousell start-URL parsing
- Multi-URL searches
- Scheduled watched searches

The scraper uses Singapore locale and timezone settings where supported.

Search responses can include scrape metadata such as:

- `status`
- `ok`
- `result_count`
- `result_count_valid`
- `parser`
- `anchors_found`
- `next_data_found`
- `challenge_detected`
- `consent_page_detected`
- `diagnostic`
- `scrape_result`
- `scrape_results`

Invalid/blocked/layout-changed pages keep `result_count: null` so they do not become fake zero-result baselines.

## Listing hydration

Initial search cards may not include complete information. Hydration can add or improve:

- Full description
- Seller name and identifier
- Seller profile URL
- Location
- Real price when the card uses a placeholder
- Product image URLs
- Listing timestamp information where available
- Variation and structured listing details

Hydration is concurrency-limited to reduce load and avoid opening too many pages at once.

## Classification

Listings are classified before deal ranking. Current post types include:

- `WTS` — normal item for sale
- `WTB` — wanted, buyback, or service post
- `WTF` — looking-for or recommendation-style post
- `SPAM` — suspicious contact/payment or keyword pattern
- `BAD_PRICER` — placeholder, bait, or unusable pricing
- `BAD_DEAL` — user-labelled poor deal
- `LEARNED_SKIP` — skipped by learned preference rules
- `SELLER_BLOCKED` — seller is blacklisted
- `UNKNOWN` — insufficient usable data

Classification considers:

- Configured phrase rules
- Seller blacklist entries
- WTB, buyback, repair, and service language
- Looking-for language
- Off-platform contact and payment patterns
- Placeholder prices
- Suspicious listing shapes
- Accessory-only and incomplete-product patterns
- User feedback and learned skip signals

## Deal scoring

The ranking engine produces a deal score from multiple components rather than relying only on price.

Current components include:

- Price relative to an available market or category median
- Condition
- Seller signal
- Listing age
- Learned preference score
- Listing-detail completeness
- Image count and basic image quality heuristics
- Market sample confidence
- Risk penalties

Returned score data includes:

- Overall deal score
- Deal/non-deal decision
- Price score
- Seller score
- Age score
- Preference score
- Detail score
- Image score
- Confidence score
- Combined penalty
- Estimated negotiation price
- Percentage difference from median
- Trend direction
- Risk flags

A high score should still be reviewed when confidence is low, the displayed price is unusually cheap, or the listing appears to be a bundle, accessory, deposit, variation, damaged item, or incomplete product.

## Market medians

The bot can use:

1. A listing-specific market median
2. A category median
3. A generic electronics fallback median

Rolling category-median tuning can update market references from collected data. Default-median scripts are also included.

Broad category medians are approximations. Exact product-model, capacity, condition, and variant matching is a future improvement area.

## Duplicate handling

The project supports automatic duplicate grouping plus manual corrections.

Features include:

- Duplicate metadata attached to listings
- Duplicate-group inspection tools
- Manual merge overrides
- Manual split overrides
- Duplicate-aware merged price history
- Duplicate-aware exports
- Feedback labels for duplicate listings

Manual overrides are useful when reposts, edited titles, reused images, bundles, or similar products confuse automatic grouping.

## Price history

When SQLite is active, a new price-history point is recorded when a listing’s observed price changes.

The dashboard and API can retrieve:

- Direct listing price history
- Duplicate-aware merged history
- CSV price-history exports

## Seller tools

Seller-related features include:

- Seller blacklist
- Seller-name and seller-ID storage
- Seller profile URL storage
- Seller rating when available
- Seller reputation history
- Seller-aware duplicate and listing analysis
- Seller blocking from the dashboard

Seller data can be incomplete when Carousell does not expose it on the search card or detail hydration fails.

## Feedback and training

The dashboard supports basic and refined feedback labels.

Basic examples:

- Good
- Skip
- Spam
- Bad pricer
- Bad deal

Refined examples:

- Good deal
- Accessory only
- Duplicate listing
- Wrong category
- WTB/service
- Overpriced or otherwise unsuitable

Feedback is stored locally and can be used to rebuild the preference model. Telegram training callbacks can apply the same refined labels from alert messages.

The current training system is rule and score based. It is not a large external AI model.

## Watched searches

Watched searches can store:

- Query
- Optional price ceiling
- Category
- Search kind
- Terms
- Start URLs
- Enabled/disabled state
- Last-run time
- Previous result count
- Scrape-health alert time
- Temporary mute state

Muted watches remain configured but are skipped until the mute expires.

## Scheduler

The scheduler runs active, unmuted watches at a configured interval.

Features include:

- Minimum and maximum interval limits
- Random jitter
- Manual run-now support
- Run status and next-run time
- Activity records
- Per-watch failure isolation
- Continued processing when one watch fails
- Scrape-health checks
- Summary or individual health-alert modes
- Recovery notifications after unhealthy runs recover
- Protection against overwriting settings changed during a long run

Scheduler configuration is stored in the local config collection.

## Scrape-health monitoring

Health monitoring compares a watch’s current valid result count with its previous healthy count.

The bot can detect or preserve signals for:

- Real zero-result pages
- Suspiciously low result counts
- Blocked/challenge pages
- Consent/login/interstitial pages
- Layout changes
- Timeouts
- Network errors
- Generic scrape failures

Health alerts are deduped and rate-limited per watch/event type. Invalid scrapes keep `result_count: null`, so failed pages are not treated as real empty markets.

The unified default runtime also bridges watched-search scrape diagnostics through the scheduler health layer. Direct legacy-core `server.js` diagnostics wiring is experimental and lives on the beta branch/patch path.

## Listing snoozing and watch muting

Listings can be snoozed so they temporarily disappear from normal attention and alert flows.

Watched searches can also be muted for a duration. Telegram commands support these actions:

```text
/snooze <listing_id> [duration]
/mute <query_or_watch_id> <duration>
```

## Telegram

Telegram integration is optional.

Configure:

- Bot token
- Chat ID
- Enabled state

Supported capabilities include:

- Deal alerts
- Scrape-health alerts
- Test messages
- Command polling
- Snooze command
- Watch mute command
- Interactive training menu
- Refined feedback callbacks

Never commit a real Telegram bot token. Revoke any token that has been exposed.

## Daily email digest

The app can send a once-daily HTML Top Deals digest through Gmail SMTP.

Dashboard configuration includes:

- Gmail address
- Gmail App Password
- Recipient address
- Daily send time
- Enabled state

Environment-variable fallback:

```bash
GMAIL_USER=your-address@gmail.com
GMAIL_APP_PASSWORD=your-app-password
DIGEST_EMAIL_TO=recipient@example.com
DIGEST_SEND_TIME=08:00
npm start
```

Use a Gmail App Password, not the normal account password.

The digest uses locally calculated deal, risk, and final ranking scores. It does not require Gmail API access or an external AI service.

## Alerts and activity

Local alert records can include:

- Deal alerts
- Scrape-health warnings
- Delivery status
- Read/unread state
- Listing and watch references
- Error details

Reliability improvements include:

- Monotonic runtime IDs for notifier-created alerts
- Safer mark-read behavior for large alert sets
- JSON and SQLite mark-read paths that avoid truncating alert history

The activity log records scheduler runs, scrape failures, health-check failures, hydration jobs, alerts, and other operational events.

## Imports and exports

The full runtime exposes export and import features for analysis, backup, or migration.

Common routes:

```text
GET  /api/export
POST /api/import
GET  /api/export/listings.csv
GET  /api/export/deals.csv
GET  /api/export/alerts.json
GET  /api/export/price-history.csv
GET  /api/start-urls/parse?url=<encoded-url>
```

Additional API routes cover listings, deals, price history, duplicate overrides, seller reputation, snoozing, feedback, searches, alerts, scheduler status, and search-job status.

Treat exports as personal data: they can contain search history, seller information, pricing history, configuration, and marketplace behavior.

## Storage

Mutable state lives under `data/`.

SQLite behavior:

- `src/store.js` attempts to load Node’s built-in `node:sqlite`.
- The default database is `data/carousell-bot.db`.
- `CAROUSELL_DB_PATH` can override the database location.
- WAL mode is enabled.
- Foreign keys are enabled.
- Supported JSON data is migrated when needed.
- Price history is currently SQLite-only.

JSON files remain useful as:

- Safe examples and seed data
- Bootstrap data
- Fallback storage when `node:sqlite` is unavailable
- Local files for selected collections

Committed templates and seed data include:

- `data/config.example.json`
- `data/listings.json`
- `data/filters.json`
- `data/seller-blacklist.json`

Do not commit runtime databases, alert data, watchlists, exports, cached images, or files containing secrets.

## Performance and caching

The full server includes:

- Scoped listing-result caching
- Configurable cache size through `LISTINGS_CACHE_MAX`
- Optional timing logs through `PERF_LOG`
- Asynchronous hydration jobs
- Limited hydration concurrency
- Batched listing operations
- SQLite transactions for supported bulk writes

Example:

```bash
PERF_LOG=1 LISTINGS_CACHE_MAX=80 npm start
```

## Docker and NAS deployment

The repository includes:

- `Dockerfile`
- `docker-compose.yml`
- `scripts/deploy-nas.ps1`
- `docs/NAS-DOCKER-DEPLOY.md`

Example Windows deployment helper:

```powershell
.\scripts\deploy-nas.ps1 `
  -HostName 192.168.1.50 `
  -User your-nas-user `
  -RemoteDir /volume1/docker/carousell-bot `
  -Port 3000
```

For NAS use:

- Persist the `data/` directory or database path.
- Set `DASHBOARD_TOKEN`.
- Avoid public port forwarding.
- Back up the SQLite database and configuration.
- Monitor disk usage from cached images, logs, alerts, and history.
- Keep Playwright and Chromium versions aligned with the application image.
- Rebuild after Git pulls when using local `build: .` images.

## Configuration and environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port, default `3000` |
| `DASHBOARD_TOKEN` | Protects dashboard API routes |
| `CAROUSELL_DB_PATH` | Overrides the SQLite database path |
| `LISTINGS_CACHE_MAX` | Maximum scoped listing-cache entries |
| `PERF_LOG` | Enables performance timing logs |
| `GMAIL_USER` | Gmail SMTP sender fallback |
| `GMAIL_APP_PASSWORD` | Gmail App Password fallback |
| `DIGEST_EMAIL_TO` | Daily-digest recipient fallback |
| `DIGEST_SEND_TIME` | Daily-digest local send time |
| `CAROUSELL_ALERT_EVENTS_PATH` | Optional JSON path for scrape-health alert-event state |
| `CAROUSELL_SCRAPE_RESULT_CACHE_TTL_MS` | Optional scrape-result cache TTL for watched-search aggregation |

Additional notification and runtime settings can be stored in the local config through the dashboard.

## Tests

Run:

```bash
npm test
```

For a more explicit test list:

```bash
node --test test/*.test.js --test-reporter spec
```

The project uses Node’s built-in test runner.

Important regression areas include:

- Runtime defaults
- Scrape diagnostics and normalization
- Classification and scoring
- Duplicate grouping
- Storage and migration
- Scheduler behavior
- Authentication
- Search URL parsing
- Export formatting
- Alert ID and mark-read reliability

Real-page fixture coverage should continue to expand because scraper behavior is the most change-sensitive part of the application.

## Project structure

```text
carousell-bot/
├── data/                       # Templates, seeds, and ignored runtime state
├── docs/                       # Deployment notes and design documents
├── public/                     # Dashboard HTML, CSS, and browser JavaScript
├── scripts/                    # Migration, cleanup, enrichment, export, deployment
├── src/
│   ├── server-unified.js       # Default unified runtime entrypoint
│   ├── plusRuntime.js          # Extended dashboard/API runtime layer
│   ├── server-plus.js          # Compatibility shim to server-unified.js
│   ├── server.js               # Legacy core HTTP server/debug runtime
│   ├── carousellSearch.js      # Playwright search and page diagnostics
│   ├── startUrlSearch.js       # Carousell URL parsing and multi-URL search
│   ├── scrapeResult.js         # Scrape-result normalization and watch bridge
│   ├── scrapeHealth.js         # Scheduler scrape-health events and formatting
│   ├── scrapePageDiagnostics.js
│   ├── serverSearchDiagnostics.js
│   ├── store.js                # SQLite-first persistence and JSON fallback
│   ├── storeReliability.js     # Alert mark-read reliability helpers
│   ├── runtimeIds.js           # Monotonic runtime ID helper
│   ├── scheduler.js            # Watched-search scheduling and health checks
│   ├── filterEngine.js         # Classification, scoring, confidence, risk
│   ├── notifier.js             # Telegram and notification delivery
│   ├── plusHydration.js        # Extended listing hydration
│   ├── duplicateGroups.js      # Duplicate grouping
│   ├── batchFeatures.js        # Batch, import/export, duplicate overrides
│   ├── listingDataQuality.js   # Parsing, enrichment, CSV helpers
│   ├── refinedFeedback.js      # Refined training labels
│   ├── categoryMedianAutoTune.js
│   └── dashboardAuth.js
├── test/                       # Node test files
├── Dockerfile
├── docker-compose.yml
├── start-local.bat
├── package.json
└── README.md
```

## v1.1 roadmap

Highest-priority improvements after v1.0:

- Publish Docker images to GHCR and make Watchtower useful
- Complete/validate the experimental direct `src/server.js` scrape-diagnostics beta patch
- Add database backup, integrity checking, retention, and restore tooling
- Add persistent scrape-job queue with retries and cancellation
- Add request body limits, rate limits, and stronger LAN defaults
- Improve listing lifecycle states: new, updated, sold, deleted, relisted
- Expand real-page fixtures for scraper regression testing

## Data-quality roadmap

- Exact product identity extraction
- Model, generation, capacity, and variant matching
- Better bundle and per-unit price handling
- Comparable-sales engine rather than broad category medians
- Separate deal, confidence, product-match, and scam-risk scores
- More seller reputation fields
- Improved multilingual and negation-aware classification
- Image hashing and cross-listing image reuse detection
- Stronger repost and underlying-item identity

## Dashboard roadmap

- Operational health view
- Persistent job progress
- Database and cache size indicators
- Last backup and integrity-check status
- Comparable-listing explanations
- Manual corrections for extracted price, model, condition, and category
- Side-by-side comparison
- Better historical charts
- More advanced watched-search rule builder

## Security notes

- Keep the service local or behind a trusted LAN/VPN/reverse proxy.
- Set `DASHBOARD_TOKEN` before LAN deployment.
- Never commit Telegram tokens, Gmail App Passwords, cookies, or exports.
- Do not expose the SQLite database through a public file share.
- Treat imported bundles as untrusted until validated.
- Keep dependencies and the Playwright browser updated together.

## Responsible use

Use reasonable search intervals and concurrency. This project is for personal marketplace research and deal tracking. Carousell may enforce limits or change its service, frontend, and automation protections.

## License

No explicit open-source license is currently documented. Until a license is added, normal copyright rules apply even though the repository is public.
