# Carousell Bot

Local-first Carousell deal detection prototype for PC testing before NAS deployment.

## Run locally

```powershell
npm start
```

Open `http://localhost:3000`.

## Current MVP

- Browser dashboard for deals, listings, and filter settings
- Local HTTP API with no external dependencies
- JSON-backed seed data for fast PC testing
- Phrase blacklist, seller blacklist, and "stupid pricer" detection
- Post classification for WTS, WTB, looking-for, spam, blocked seller, and bad pricing behavior

## Planned next

- Replace JSON persistence with SQLite schema
- Add Playwright scraper proof of concept
- Add deal scoring history and Telegram/browser notifications
- Add Python ML negotiation estimator
