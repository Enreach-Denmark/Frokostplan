# Lunchly

Lunchly is a small, self-hosted lunch planner for teams. Employees get a weekly view of their lunch time, while administrators manage the roster, assign lunch slots, and approve new accounts.

## Features

- Weekly lunch schedule with four fixed 30-minute slots: 11:00, 11:30, 12:00, and 12:30.
- Employee lunch swaps for one day, several days, or a full week.
- Swap approval before the plan changes.
- **Lunch now** status during an employee's assigned slot.
- Admin auto-fill and Monday assignment applied across the week.
- Employee exclusion, admin roles, account approval, password reset, and recovery phrases.

## How it works

Lunchly is a single Node.js application:

```text
Browser → same-origin /api requests → Node.js server
                                      ├─ SQLite accounts and sessions
                                      └─ JSON lunch plan
```

The browser loads the UI from the server and calls relative `/api/...` URLs, so the UI and API should normally use the same host and port.

Accounts are stored in SQLite. The roster, assignments, lunch plan, and swap requests are stored in `data/lunch-plan.json`. Passwords and recovery phrases are stored as scrypt hashes.

### Account lifecycle

1. The first registered account becomes the administrator.
2. Later registrations start as **pending** accounts.
3. An administrator approves each account and links it to an existing employee or creates a new employee.
4. Approved employees can view their plan and use swaps.

## Requirements

- Node.js 24 or newer
- Docker and Docker Compose (optional)

## Run locally

```powershell
npm start
```

Open [http://localhost:3000](http://localhost:3000). To expose it on a LAN:

```powershell
$env:LUNCHLY_HOST = "0.0.0.0"
$env:PORT = "5000"
npm start
```

Local data is stored in `data/`.

## Run with Docker Compose

```powershell
docker compose up -d --build
docker compose ps
docker compose logs -f lunchly
```

Open `http://192.168.11.154:3005/`, or use `https://frokost.ipnordic.dk/` through the reverse proxy. Compose publishes host port 3005 to the container's port 5000. It bind-mounts the local `data/` directory into the container, so data survives rebuilds.

Back up these files before moving or upgrading the server:

```text
data/accounts.sqlite
data/lunch-plan.json
```

Stop the service with:

```powershell
docker compose down
```

The data directory is retained.

## Reverse proxy and HTTPS

The Docker setup serves HTTP. For production or internet-accessible use, put an HTTPS reverse proxy in front of Lunchly.

The proxy must forward both the static application and `/api/` routes, while preserving:

```text
Host
X-Forwarded-Host
X-Forwarded-Proto
```

Configure the proxy upstream as `http://192.168.11.154:3005`. If it serves the UI but does not forward `/api/`, registration and sign-in will fail with browser errors such as `Failed to fetch` or `502 Bad Gateway`.

## Development

Run the tests with:

```powershell
node --test *.test.js
```

Tests cover authentication, roles, fixed lunch slots, weekly assignments, lunch-now behavior, auto-fill, and swap requests.

## Project structure

```text
server.js       HTTP server, API routes, authentication, persistence
app.js          Browser application and interactions
index.html      Application shell
styles.css      Visual styling
data/           Persistent accounts and lunch plan
compose.yaml    Docker Compose deployment
Dockerfile      Production container image
DOCKER.md       Docker deployment notes
*.test.js       Node.js tests
```

## Security and backups

- Use HTTPS on untrusted networks.
- Keep the `data/` directory private.
- Back up the `data/` directory regularly.
- Do not run two Lunchly servers against the same data directory.
- Authentication attempts are rate-limited per client address.

## License

This project does not currently declare a software license.
