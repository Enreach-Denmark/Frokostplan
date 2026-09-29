# Run Lunchly with Docker Compose

The Compose setup serves Lunchly over HTTP and keeps the existing accounts and lunch plans in the bind-mounted `data` directory. Stop the existing `node server.js` process before starting Compose; two servers must not write to the same data files at once.

```powershell
docker compose up -d --build
docker compose ps
docker compose logs -f lunchly
```

Open `http://192.168.11.154:3005/`, or use the public domain `https://frokost.ipnordic.dk/` through the reverse proxy. Compose publishes host port 3005 to the container's port 5000.

If a reverse proxy is used, set its upstream to `http://192.168.11.154:3005` and proxy both `/` and `/api/`. Preserve the public `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto` headers.

This deployment sends passwords and recovery phrases over HTTP. Use it only on a network where that is acceptable, or put an HTTPS reverse proxy in front of it.

To stop the container, run `docker compose down`. The bind-mounted `data` directory remains in place. Back up `data/accounts.sqlite` and `data/lunch-plan.json` before moving to another host.

On Linux, ensure `data` is writable by UID 1000 (the container's `node` user). The container uses the Europe/Copenhagen time zone because Lunch now uses the server's local clock.
