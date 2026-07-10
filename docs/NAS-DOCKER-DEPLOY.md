# NAS Docker deployment

This app can run on a NAS as one Docker Compose service. Runtime state stays in `data/`, logs stay in `logs/`, and the container uses the Microsoft Playwright image so Chromium dependencies are already present.

## NAS requirements

- SSH access from your PC
- `git`
- Docker
- Docker Compose, either `docker compose` or `docker-compose`
- A NAS user that can run Docker commands

## One-command deploy from Windows

From this repo on your PC:

```powershell
.\scripts\deploy-nas.ps1 -HostName 192.168.1.50 -User your-nas-user -RemoteDir /volume1/docker/carousell-bot -Port 3000
```

The script will:

- clone or update `https://github.com/Pikalev15/carousell-bot.git`
- checkout `main`
- create `.env` on the NAS if it does not exist
- set `PUID` / `PGID` so Docker writes `data/` and `logs/` as your NAS SSH user
- build the Docker image
- start `carousell-bot` with persistent `data/` and `logs/`

If you want a specific dashboard token:

```powershell
.\scripts\deploy-nas.ps1 -HostName 192.168.1.50 -User your-nas-user -RemoteDir /volume1/docker/carousell-bot -Port 3000 -DashboardToken "replace-with-a-long-random-string"
```

If the GitHub repo is private and your NAS has a GitHub SSH key, use the SSH repo URL:

```powershell
.\scripts\deploy-nas.ps1 -HostName 192.168.1.50 -User your-nas-user -Repo git@github.com:Pikalev15/carousell-bot.git
```

## Open the dashboard

After deploy:

```text
http://NAS_IP:3000
```

The dashboard will ask for the token from the `.env` file on the NAS.

## Useful NAS commands

SSH into the NAS and go to the app folder:

```bash
cd /volume1/docker/carousell-bot
```

View logs:

```bash
docker compose logs -f carousell-bot
```

Restart:

```bash
docker compose restart carousell-bot
```

Update later:

```bash
git pull --ff-only origin main
docker compose up -d --build
```

Stop:

```bash
docker compose down
```

## Persistent files

These stay on the NAS:

- `data/carousell-bot.db`
- `data/config.json`
- `data/image-cache/`
- `logs/`

Do not delete `data/` unless you intentionally want to reset listings, labels, watchlists, Telegram settings, and training state.

## Permission Fix

The Compose file runs the app as the NAS user configured by `.env`:

```env
PUID=1026
PGID=100
```

The deploy script fills these automatically from `id -u` and `id -g`. If you installed manually and SQLite cannot open `data/carousell-bot.db`, add those values yourself:

```bash
id -u
id -g
nano .env
```

Then restart:

```bash
docker compose down
docker compose up -d --build
```
