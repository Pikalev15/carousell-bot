# Carousell Bot

A local-first Carousell deal finder for people who are tired of scrolling through noisy listings.

This started as a small PC-testing prototype for hunting good second-hand deals, especially hardware listings, before eventually moving it to a NAS. It runs a small web dashboard on your own machine, searches Carousell with Playwright, saves listings locally, and tries to separate actual deals from spam, WTB posts, bait prices, accessories, duplicates, and annoying sellers.

It is not trying to be a polished SaaS app. It is more like a personal marketplace command center that you can tweak as your own buying habits change.

## What it does

- Searches Carousell Singapore from a local web dashboard
- Uses the full `playwright` package and its bundled Chromium install
- Saves local app state under `data/`
- Scores listings based on price, condition, age, seller signal, listing detail, relevance, and learned preference
- Filters out WTB / looking-for posts, spammy listings, bait prices, blocked phrases, and blocked sellers
- Lets you add phrase rules and seller blacklist entries from the UI
- Tracks watched searches and can run them on a scheduler
- Shows alerts, activity history, export routes, and deal candidates in the dashboard
- Supports Telegram notifications for deal alerts and scrape-health warnings
- Lets you label listings so the training model can learn what you usually skip or like

## Current status

This is still an MVP. The main flow works locally, but the project is intentionally simple right now:

- Storage prefers SQLite when `node:sqlite` is available; JSON files are the fallback/bootstrap path
- The scraper depends on Carousell's current frontend structure, so it may break if their site changes
- It is meant for personal local/LAN use, not public hosting
- The UI is functional, but not final

## Requirements

- Node.js `22.5` or newer
- npm
- Network access from the machine running the scraper

The project depends on full `playwright`, not `playwright-core`. `npm install` runs:

```bash
playwright install chromium
```

So a bundled Playwright Chromium is normally used. You do not need to set `CHROME_PATH` for the normal setup.

## Setup

Clone the repo:

```bash
git clone https://github.com/Pikalev15/carousell-bot.git
cd carousell-bot
```

Install dependencies:

```bash
npm install
```

Create a local config if you want to edit settings manually:

```bash
cp data/config.example.json data/config.json
```

Start the local server:

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

On Windows, you can also double-click:

```text
start-local.bat
```

## Dashboard authentication

For LAN/NAS use, set a simple shared dashboard token:

```bash
DASHBOARD_TOKEN=replace-with-a-long-random-string npm start
```

Every `/api/*` route except `/api/health` requires this token when it is set. The browser dashboard prompts for the token once and stores it in `sessionStorage` for that tab/session.

If `DASHBOARD_TOKEN` is not set, the server still starts for localhost-only development but logs a clear warning that API routes are unauthenticated.

## Browser path notes

The normal setup uses bundled Playwright Chromium. No browser path is required.

A custom system browser path is only useful if you intentionally modify the scraper launch code to use your installed Chrome/Chromium instead of Playwright's bundled browser. In the current code path, `CHROME_PATH` is not required for normal use.

For Chromebook Linux, install/run the project inside the Linux environment. The ChromeOS browser outside the container is not enough for Node/Playwright to launch browser automation.

## How to use it

1. Open the dashboard at `localhost:3000`.
2. Search for something like `RTX 3070`, `MacBook`, `AirPods`, or `camera`.
3. The server opens Carousell through Playwright, reads visible listing cards, and stores the results.
4. Listings are classified and scored.
5. Use the filters, seller blacklist, and feedback buttons to make the results less noisy over time.

Useful buttons/features:

- **Search web** — runs a normal Carousell search
- **Search more** — asks for a larger scrape
- **Block seller** — hides future listings from that seller
- **Good / skip / spam / bad pricer / bad deal** — labels a listing for the training model
- **Train model better** — refined labels such as accessory-only, duplicate, wrong category, WTB/service, overpriced
- **Retrain from labels** — rebuilds the preference model from your feedback

## Watchlist and scheduler

The watchlist is for searches you want to keep checking, like:

- `RTX 3070`
- `B550 motherboard`
- `SFX PSU`
- `MacBook Air M1`

The scheduler can run active watched searches every few minutes or hours, with a bit of jitter so it does not hit the site in an overly robotic pattern.

Scheduler and scrape-health settings are stored locally in `data/config.json`. `scrapeHealthCheck.minResultRatio` controls when the bot warns that a watched search suddenly returned far fewer results than before.

## Telegram alerts

Telegram alerts are optional.

From the Settings page, you can add:

- Telegram bot token
- Telegram chat ID
- Enabled / paused state

Use **Send test message** to check that the bot can reach your chat.

Do not commit real Telegram secrets. If a real Telegram bot token was ever committed, revoke it through @BotFather and issue a new token.

## Local data

Local mutable state lives under `data/`, including config, labels, search history, alerts, watchlist data, exports, cached images, and SQLite databases. These files are ignored by default so secrets and personal marketplace history do not get committed.

Committed seed/template files:

- `data/config.example.json` — safe config template with empty Telegram values
- `data/listings.json` — intentional mock/demo listing seed data, not real scraped data
- `data/filters.json` — default phrase-filter seed data
- `data/seller-blacklist.json` — default mock seller-block seed data

SQLite notes:

- When `node:sqlite` is available, `src/store.js` opens `data/carousell-bot.db`, migrates JSON once, and prefers SQLite.
- If `node:sqlite` is unavailable, JSON files remain the fallback path.
- Price history is SQLite-only at the moment; the JSON fallback returns an empty history.

Migration command:

```bash
npm run migrate
```

## Runtime scripts

```bash
npm start          # default full runtime: src/server-plus.js
npm run dev        # same as npm start
npm run start:plus # explicit alias for the default full runtime
npm run start:core # core server only, mostly for debugging
npm run clean:images
npm run enrich:data
npm run medians:default
npm run export:data
npm test
```

## NAS Docker deployment

The repo includes a NAS-friendly Docker setup:

- `Dockerfile`
- `docker-compose.yml`
- `scripts/deploy-nas.ps1`

From Windows, deploy over SSH with:

```powershell
.\scripts\deploy-nas.ps1 -HostName 192.168.1.50 -User your-nas-user -RemoteDir /volume1/docker/carousell-bot -Port 3000
```

See `docs/NAS-DOCKER-DEPLOY.md` for the full install/update flow.

## Export routes

Available from the default runtime:

```text
/api/export/listings.csv
/api/export/deals.csv
/api/export/alerts.json
/api/export/price-history.csv
/api/start-urls/parse?url=<encoded carousell url>
```

## Tests

Run the test suite with:

```bash
npm test
```

The tests use Node's built-in test runner.

## Project structure

```text
carousell-bot/
├── data/                  # Local data templates and ignored runtime state
├── docs/                  # Notes and spec addendums
├── public/                # Dashboard HTML, CSS, and browser JS
├── src/                   # Server, scraper, scoring, storage, notifications
├── test/                  # Node test files
├── start-local.bat        # Windows local launcher
├── package.json
└── README.md
```

## Roadmap

Things that would make the project stronger next:

- Make SQLite the explicit documented default everywhere
- Add better duplicate detection across repeated scrapes
- Improve seller reputation tracking
- Add more reliable price history charts
- Make the scheduler easier to configure from the UI
- Add export/import for filters and watchlists
- Improve the training model so it learns more than simple user labels
- Make deployment to a NAS cleaner

## Notes

This project is for personal marketplace research and local deal tracking. Be reasonable with search frequency and respect the sites you interact with. If Carousell changes its frontend, the scraper may need updates.
