# Access Carousell Bot Through Tailscale

This app is meant to stay private. The safest way to open it away from home is to use Tailscale instead of exposing the Docker port to the public internet.

## Quick Check

1. Keep the Docker compose port local/LAN-only if possible.
2. Confirm Tailscale is running on the NAS.
3. From your phone or laptop, connect to the same Tailnet.
4. Open:

```text
http://<nas-tailscale-ip>:3010
```

If you kept the compose mapping as `3010:3000`, use port `3010`.

## Find the NAS Tailscale IP

Run this on the NAS:

```sh
tailscale ip -4
```

Use the returned `100.x.y.z` address in the browser URL.

## Security Notes

- Do not port-forward this app through your router.
- Keep Telegram enabled only for your configured chat ID.
- If you enable dashboard auth, keep the password in `.env`, not in Git.
- Back up the config from the Settings page before major changes.

## Troubleshooting

- If the page works on LAN but not Tailscale, check that your client is connected to Tailscale.
- If the container is healthy but the page does not load, run `docker compose ps` and confirm the host port is still `3010`.
- If Telegram commands work but the dashboard does not, Telegram is reaching out from the NAS correctly; the browser path is the part to debug.
