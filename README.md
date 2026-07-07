# Carousell Bot

Local-first Carousell deal detection prototype for PC testing before NAS deployment.

## Run locally

```powershell
npm.cmd start
```

Open `http://localhost:3000`.

On Windows you can also double-click `start-local.bat`.

### Chromebook / Linux Chrome

If you run this in the Chromebook Linux environment, install Google Chrome or Chromium there, not just in ChromeOS, so the Node server can launch it. The app now checks common Linux paths such as `/usr/bin/google-chrome`, `/opt/google/chrome/chrome`, `/usr/bin/chromium`, and `/usr/bin/chromium-browser`. If Chrome is installed somewhere else, start the server with `CHROME_PATH=/path/to/chrome npm start`.

## Current MVP

- Browser dashboard for deals, listings, and filter settings
- Real Carousell web search using installed Chrome through Playwright Core
- JSON-backed seed data for fast PC testing
- Phrase blacklist, seller blacklist, and "stupid pricer" detection
- Post classification for WTS, WTB, looking-for, spam, blocked seller, and bad pricing behavior

## Search behavior

`Search web` opens Carousell in installed Chrome from the local server, parses visible listing cards, stores new results in `data/listings.json`, and then runs the blacklist/scoring logic.

`Search more` asks for a larger Carousell pull. If Carousell blocks the request or Chrome is unavailable, the request fails with the real browser/search error instead of silently adding local demo listings.

## Planned next

- Replace JSON persistence with SQLite schema
- Add Playwright scraper proof of concept
- Add deal scoring history and Telegram/browser notifications
- Add Python ML negotiation estimator
