# Carousell Bot

A local-first Carousell deal finder for people who are tired of scrolling through noisy listings.

This started as a small PC-testing prototype for hunting good second-hand deals, especially hardware listings, before eventually moving it to a NAS. It runs a small web dashboard on your own machine, searches Carousell with a real installed browser, saves listings locally, and tries to separate actual deals from spam, WTB posts, bait prices, and annoying sellers.

It is not trying to be a polished SaaS app. It is more like a personal marketplace command center that you can tweak as your own buying habits change.

## What it does

- Searches Carousell Singapore from a local web dashboard
- Uses Playwright Core with your installed Chrome, Edge, or Chromium browser
- Saves listings into local JSON files under `data/`
- Scores listings based on price, condition, age, seller signal, listing detail, and learned preference
- Filters out WTB / looking-for posts, spammy listings, bait prices, blocked phrases, and blocked sellers
- Lets you add phrase rules and seller blacklist entries from the UI
- Tracks watched searches and can run them on a scheduler
- Shows alerts, activity history, and deal candidates in the dashboard
- Supports Telegram notifications for deal alerts
- Lets you label listings so the simple training model can learn what you usually skip or like

## Current status

This is still an MVP. The main flow works locally, but the project is intentionally simple right now:

- Storage is JSON-backed, not a proper database yet
- The scraper depends on Carousell's current frontend structure, so it may break if their site changes
- It is meant for personal local use, not public hosting
- The UI is functional, but not final

## Requirements

- Node.js `22.5` or newer
- npm
- One installed browser that Playwright Core can launch:
  - Google Chrome
  - Microsoft Edge
  - Chromium

The app does not download its own browser because it uses `playwright-core`. That keeps the repo lighter, but it also means your system browser needs to be installed properly.

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

## Browser path notes

The scraper tries common browser paths automatically, including Chrome, Edge, and Chromium locations on Windows, macOS, and Linux.

If it cannot find your browser, set `CHROME_PATH` manually:

```bash
CHROME_PATH=/path/to/chrome npm start
```

Example on Linux:

```bash
CHROME_PATH=/usr/bin/chromium npm start
```

For Chromebook Linux, install Chrome or Chromium inside the Linux environment itself. The ChromeOS browser outside the container is not enough for the Node server to launch.

## How to use it

1. Open the dashboard at `localhost:3000`.
2. Search for something like `RTX 3070`, `MacBook`, `AirPods`, or `camera`.
3. The server opens Carousell through the installed browser, reads visible listing cards, and stores the results.
4. Listings are classified and scored.
5. Use the filters, seller blacklist, and feedback buttons to make the results less noisy over time.

The important buttons are:

- **Search web** — runs a normal Carousell search
- **Search more** — asks for a larger scrape
- **Block seller** — hides future listings from that seller
- **Good / skip / spam / bad pricer / bad deal** — labels a listing for the training model
- **Retrain from labels** — rebuilds the preference model from your feedback

## Watchlist and scheduler

The watchlist is for searches you want to keep checking, like:

- `RTX 3070`
- `B550 motherboard`
- `SFX PSU`
- `MacBook Air M1`

The scheduler can run active watched searches every few minutes or hours, with a bit of jitter so it does not hit the site in an overly robotic pattern.

Scheduler settings are stored locally in `data/config.json`.

## Telegram alerts

Telegram alerts are optional.

From the Settings page, you can add:

- Telegram bot token
- Telegram chat ID
- Enabled / paused state

Use **Send test message** to check that the bot can reach your chat.

Do not commit real Telegram secrets if you ever replace the local config with your own credentials.

## Local data

Most app state currently lives in JSON files under `data/`, including listings, filters, sellers, labels, watched searches, alerts, config, and the training model.

That makes the project easy to inspect and edit while it is still small. The tradeoff is that JSON storage will not scale as cleanly as SQLite once the listing history grows.

There is already a migration command reserved for moving toward SQLite:

```bash
npm run migrate
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
├── data/                  # Local JSON state
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

- Move persistence from JSON to SQLite
- Add better duplicate detection across repeated scrapes
- Improve seller reputation tracking
- Add more reliable price history charts
- Make the scheduler easier to configure from the UI
- Add export/import for filters and watchlists
- Improve the training model so it learns more than simple user labels
- Make deployment to a NAS cleaner

## Notes

This project is for personal marketplace research and local deal tracking. Be reasonable with search frequency and respect the sites you interact with. If Carousell changes its frontend, the scraper may need updates.