# Carousell Bot

Local-first Carousell deal detection prototype for PC testing before NAS deployment.

## Run locally

```powershell
npm.cmd start
```

Open `http://localhost:3000`.

On Windows you can also double-click `start-local.bat`.

## Current MVP

- Browser dashboard for deals, listings, and filter settings
- Real Carousell web search using installed Chrome through Playwright Core
- JSON-backed seed data for fast PC testing
- Phrase blacklist, seller blacklist, and "stupid pricer" detection
- Post classification for WTS, WTB, looking-for, spam, blocked seller, and bad pricing behavior

## Search behavior

`Search web` opens Carousell in installed Chrome from the local server, parses visible listing cards, stores new results in `data/listings.json`, and then runs the blacklist/scoring logic.

`Search more` asks for a larger Carousell pull. If Carousell blocks the request or Chrome is unavailable, the API returns a visible warning instead of pretending it worked.

## Planned next

- Replace JSON persistence with SQLite schema
- Add Playwright scraper proof of concept
- Add deal scoring history and Telegram/browser notifications
- Add Python ML negotiation estimator
