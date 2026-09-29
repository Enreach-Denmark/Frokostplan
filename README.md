# Lunchly

Lunchly is a self-hosted lunch planner for teams. Employees can see their weekly lunch schedule and request swaps, while administrators manage employees, lunch assignments, and account access.

## Features

- Weekly schedules with four fixed 30-minute slots: 11:00, 11:30, 12:00, and 12:30.
- Employee swaps for individual days or full weeks, with approval before the plan changes.
- “Lunch now” status during an assigned lunch slot.
- Administrator auto-fill and manual weekly assignments.
- Employee exclusion and administrator roles.
- Account registration, approval, login, password reset, and recovery phrases.

## How it works

Lunchly is a single Node.js application. The browser uses same-origin API requests such as /api/register and /api/login.

Data is stored in:

    data/accounts.sqlite       Accounts and authentication data
    data/lunch-plan.json       Employees, assignments, and swap requests

The first registered account becomes the administrator. Later accounts remain pending until an administrator approves and links them to an employee.

## Current deployment

| Item | Value |
|---|---|
| Public domain | http://frokost.ipnordic.dk |
| Lunchly host | 192.168.11.154 |
| Lunchly host port | 3005 |
| Container port | 5000 |
| Docker registry | 192.168.11.145:5000 |

The reverse proxy should forward http://frokost.ipnordic.dk to http://192.168.11.154:3005. It must forward both the application and /api/ routes, preserving Host, X-Forwarded-Host, and X-Forwarded-Proto.

## Run locally

    npm start

Open http://localhost:3000. To expose the server on a network:

    $env:LUNCHLY_HOST = "0.0.0.0"
    $env:PORT = "5000"
    npm start

Run tests with:

    node --test *.test.js

## Run with Docker Compose

    docker compose up -d --build
    docker compose ps
    docker compose logs -f lunchly

Lunchly will be available at http://192.168.11.154:3005/. Stop it with:

    docker compose down

The data directory is bind-mounted and retained when the container is stopped or rebuilt.

## Backups

Back up data/accounts.sqlite and data/lunch-plan.json regularly. Do not run two Lunchly servers against the same data directory at the same time.

## Troubleshooting

### Failed to fetch

Check that the browser can reach the public domain and that the reverse proxy forwards /api/ to Lunchly.

### 502 Bad Gateway

A 502 means the reverse proxy cannot reach Lunchly. Check that the container is running and that the proxy upstream is exactly http://192.168.11.154:3005.

From the host, test:

    curl http://127.0.0.1:3005/api/session

It should return JSON rather than an HTML 502 page.

### Account creation errors

Check the container logs with:

    docker compose logs --tail=100 lunchly

Also confirm that the data directory is writable by the container user.

## Project structure

    server.js       HTTP server, API routes, authentication, persistence
    app.js          Browser application and interactions
    index.html      Application shell
    styles.css      Visual styling
    data/           Persistent accounts and lunch plan
    compose.yaml    Docker Compose deployment
    Dockerfile      Production container image
    DOCKER.md       Docker deployment notes
    *.test.js       Node.js tests

## Security

- The current deployment uses HTTP only; use it on a trusted network.
- Keep the data directory private.
- Back up account and plan data.
- Do not expose the SQLite database directly.
- Authentication attempts are rate-limited per client address.

## License

No software license is currently declared for this project.
