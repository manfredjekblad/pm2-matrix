# PM2 Matrix

**A self-hosted, real-time dashboard for monitoring and managing your PM2 processes — right from your browser.**

---

## What is PM2?

[PM2](https://pm2.keymetrics.io/) is a popular process manager for Node.js (and other runtimes) on Linux/macOS servers. It keeps your apps running, restarts them on crash, and manages logs. If you run web services, APIs, or background workers on a VPS or server, there's a good chance you're already using PM2.

## What is PM2 Matrix?

PM2 Matrix is a web dashboard that connects to PM2 on your server and shows you everything in one place — live stats, real-time logs, and one-click controls — without needing to SSH into the server every time. It is:

- **Self-hosted** — runs on your own server, no cloud accounts needed
- **Lightweight** — a single Node.js process serving both the API and the React frontend
- **Secure** — login-protected with bcrypt passwords and signed session cookies

---

## Features

### Real-time Dashboard

- Live grid of all your PM2 services, each shown as a card with a built-in log console
- **Service summary pill** in the topbar: shows `online / total` counts at a glance; turns red when any service is errored
- **PM2 aggregate stats** in the topbar: total CPU % and total RAM summed across all managed processes, updated at the poll interval
- **Server stats** in the topbar: server load average (1-minute) and used/total RAM from the OS, also updated at the poll interval; hover for 5-minute and 15-minute load averages and server uptime
- Configurable number of columns (1 to 8) — choose full-width cards or a dense multi-column view
- **Configurable card height** — choose S / M / L / XL from the topbar; saved in `localStorage`
- **Show archived toggle** in the topbar — hide archived cards by default, or reveal them on demand
- Configurable refresh rate for stats (1 s to 60 s, default 3 s) — applies server-side for all connected browsers
- New services detected automatically and added to the grid without a page reload
- Drag cards to reorder them — order is saved to the server instantly
- **Port discovery** (Linux only) — click the plug icon in the topbar to open a modal listing every service and the TCP ports it is actively listening on; detected ports are also shown inline in the expanded log modal title bar

### Service Cards

- Status dot and label: **Online** (green), **Stopped** (grey), **Errored** (red), **Launching** (yellow)
- Live stats: CPU %, RAM, and uptime — updated at your chosen interval
- **Four action buttons** in the title bar: **Reload** (instant), **Restart** (asks for confirmation), **Stop** (asks for confirmation) — when a service is stopped, the Stop button is replaced by a **Start** button
- **Archive / Unarchive** action in the title bar to hide rarely used cards without deleting them; archived state is persisted server-side
- Real-time log console inside each card — scrollable, ANSI colour support, capped at 1 000 lines
- **Log filter** in the title bar: switch between All / Stdout / Stderr per card — filter is saved to the server so it persists across page reloads; on narrow cards the pills collapse into a compact dropdown
- **Stderr warning triangle**: a yellow ⚠ icon with a **red unread count badge** appears when new error lines arrive while you're not watching the Err filter; click it to jump straight to the error view
- **Timestamp hover**: hover over any log timestamp to see the full ISO date and time in a tooltip
- Double-click the title bar to open the full expanded log modal
- **Drag-and-drop reorder**: drag a card to a new position; a blue left border highlights the drop target

### Expanded Log Modal

- Opens any service in a large, tall overlay that fills most of the screen
- Same All / Out / Err filter with a live count badge and unread error badge
- **Log search** — click the 🔍 button or press **Ctrl+F** to open an inline search bar; logs are filtered in real time by case-insensitive substring match, and matching text is highlighted in yellow
- **Copy all visible logs** — click the copy icon to copy every visible log line (timestamp + message) to your clipboard; the same toast notification confirms it
- **Action buttons in the modal** — Reload / Restart / Stop (or Start) directly from the expanded view without closing the modal
- **Font size toggle** — switch between S / M / L log font sizes in the modal header; choice is saved in `localStorage`
- **Pause / Resume** — freezes the log at a snapshot for easy reading; a banner reminds you it's paused
- **Auto-copy on text selection** — select any text in the log window and it is copied to your clipboard automatically (Putty-style); a "Copied to clipboard" notice confirms it; duplicate copies of the same selection are suppressed
- **Timestamp hover**: hover any timestamp to see the full ISO date and time
- Auto-scroll with a "Jump to bottom" button when you scroll up
- Close with the ✕ button or the **Escape** key

### Authentication & Security

- Single-user login with a bcrypt-hashed password stored in your `.env` file
- Session cookie — `httpOnly`, `sameSite: lax`, `Secure` flag enabled in production
- Rate limiting on the login endpoint (20 attempts per 15 minutes per IP)
- All API routes and WebSocket connections require a valid session
- HTTP security headers via `helmet`

### Resilience

- Backend reconnects to PM2 automatically if the daemon restarts
- Frontend reconnects to the WebSocket automatically if the connection drops; a red banner warns you while disconnected
- **PM2 health indicator** in the topbar shows `PM2 degraded` or `PM2 reconnecting` if PM2 connectivity is unhealthy even while the web app itself is still reachable

---

## Requirements

- **Node.js 18 or later** — check with `node --version`
- **PM2 already installed** globally on the same server — check with `pm2 list`
- **Same OS user** — PM2 Matrix must run under the same Linux/macOS user as PM2; it connects via the PM2 socket at `~/.pm2/rpc.sock`
- **Linux or macOS** (Windows is not supported)

---

## Quick Start

Follow these six steps to go from zero to a running dashboard.

---

### Step 1 — Get the code

```bash
git clone https://github.com/manfredjekblad/pm2-matrix.git pm2-matrix
cd pm2-matrix
```

If you downloaded a ZIP instead, unzip it and `cd` into the folder.

---

### Step 2 — Install dependencies

```bash
npm install
```

This installs everything the server and the frontend build need. It takes about 30 seconds.

---

### Step 3 — Create your `.env` file

Copy the example file:

```bash
cp .env.example .env
```

Then open `.env` in your editor. You will see these variables:

```
PM2_MATRIX_USER=admin
PM2_MATRIX_PASSWORD_HASH=$2b$12$your_bcrypt_hash_here
PM2_MATRIX_HOST=0.0.0.0
PM2_MATRIX_PORT=8080
SESSION_SECRET=REPLACE_WITH_A_RANDOM_64_CHAR_HEX_STRING
NODE_ENV=production
TRUST_PROXY=0
```

| Variable | What it does | Default |
|---|---|---|
| `PM2_MATRIX_USER` | Your login username | `admin` |
| `PM2_MATRIX_PASSWORD_HASH` | Bcrypt hash of your password — generated in Step 4 | *(required)* |
| `PM2_MATRIX_HOST` | Network interface. Use `127.0.0.1` behind a reverse proxy; `0.0.0.0` for direct access | `0.0.0.0` |
| `PM2_MATRIX_PORT` | Port the server listens on | `8080` |
| `SESSION_SECRET` | A long random string used to sign session cookies — generated in Step 4 | *(required)* |
| `NODE_ENV` | Set to `production` to enable the `Secure` flag on session cookies (required for HTTPS) | — |
| `TRUST_PROXY` | Set to `1` when behind Nginx/Caddy; enables correct IP detection for rate limiting and the `Secure` cookie | `0` |

---

### Step 4 — Generate your secrets

You need to fill in two values: the password hash and the session secret.

#### Password hash

Choose a password and run:

```bash
npm run generate-hash YourPasswordHere
```

You will see a long string starting with `$2b$12$...`. Copy the **entire** string and paste it as the value of `PM2_MATRIX_PASSWORD_HASH` in `.env`.

> This is a one-way hash — PM2 Matrix never stores your plain-text password.

#### Session secret

The session secret must be a long, random string. Pick one of these commands:

```bash
# Linux / macOS — uses OpenSSL
openssl rand -hex 32

# Any platform — uses Node.js built-in crypto
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output (a 64-character hex string) and paste it as the value of `SESSION_SECRET` in `.env`.

> Never use the placeholder value. The server will refuse to start if `SESSION_SECRET` is missing or left as the default.

#### Your finished `.env` should look like this

```
PM2_MATRIX_USER=admin
PM2_MATRIX_PASSWORD_HASH=$2b$12$Ej8K1mLqN3rPvXsT0uWdYeOiBhGfCzAkDjMoQnRwSy7Ux6Vt4HlI9a2Fp5Nc8Gs
PM2_MATRIX_HOST=127.0.0.1
PM2_MATRIX_PORT=8080
SESSION_SECRET=a3f8e2c1d7b4096f5e3a1c8d2b6f4e9a0c7d5b3e8f2a1c4d9b6e3f0a7c8d2b5
NODE_ENV=production
TRUST_PROXY=1
```

*(The hash and secret above are examples — generate your own. Use `HOST=127.0.0.1` and `TRUST_PROXY=1` when behind a reverse proxy with HTTPS; use `HOST=0.0.0.0` and `TRUST_PROXY=0` for direct access.)*

---

### Step 5 — Build

Compile the React frontend and the TypeScript server:

```bash
npm run build
```

This produces:
- `dist/` — the compiled React app (served as static files)
- `dist-server/` — the compiled Node.js server

You only need to rebuild when you update the code.

---

### Step 6 — Run

```bash
npm start
```

Then open your browser at **`http://your-server-ip:8080`** and log in with the username and password you chose.

---

### Optional — Keep it running with PM2

You can manage PM2 Matrix with PM2 itself so it starts automatically on server boot:

```bash
# Start PM2 Matrix as a PM2-managed process
pm2 start dist-server/index.js --name pm2-matrix

# Save the PM2 process list so it survives reboots
pm2 save

# Set up PM2 to start on boot (run the command it prints)
pm2 startup
```

To check it is running:

```bash
pm2 status
```

To view its own logs:

```bash
pm2 logs pm2-matrix
```

---

## Development Mode

If you want to modify the code, run the backend and frontend separately with hot reload:

```bash
# Terminal 1 — backend with automatic restart on file changes
npm run dev:server

# Terminal 2 — frontend with Vite Hot Module Replacement
npm run dev:client
```

Open `http://localhost:5173` in your browser. The Vite dev server automatically proxies `/api` and `/ws` requests to the backend on port `8080`.

> Make sure the backend is running before you open the browser — it needs to connect to PM2 first.

---

## Configuration Reference

All configuration is via environment variables in `.env`.

| Variable | Type | Default | Description |
|---|---|---|---|
| `PM2_MATRIX_USER` | string | `admin` | Login username |
| `PM2_MATRIX_PASSWORD_HASH` | string | *(required)* | Bcrypt hash of your password. Generate with `npm run generate-hash <password>` |
| `PM2_MATRIX_HOST` | string | `0.0.0.0` | Network interface to bind. Use `127.0.0.1` to restrict to localhost (e.g. behind a reverse proxy) |
| `PM2_MATRIX_PORT` | number | `8080` | TCP port |
| `SESSION_SECRET` | string | *(required)* | Random secret for signing session cookies. Must be at least 32 characters. Generate with `openssl rand -hex 32` |
| `NODE_ENV` | string | — | Set to `production` to enable the `Secure` flag on the session cookie. Also set `TRUST_PROXY=1` when behind a reverse proxy |
| `TRUST_PROXY` | `0` or `1` | `0` | Set to `1` **only** when running behind a reverse proxy (Nginx, Caddy, etc.). Enables Express to trust `X-Forwarded-For` for the rate limiter and also activates the `Secure` cookie flag automatically |

---

## Security Notes

To report a vulnerability privately, see [SECURITY.md](SECURITY.md).

### Run behind a reverse proxy with HTTPS

In production, place PM2 Matrix behind **Nginx** or **Caddy** with HTTPS. This encrypts traffic between the browser and your server. When you do:

1. Set `NODE_ENV=production` in your `.env` — this enables the `Secure` cookie flag so the session cookie is only sent over HTTPS
2. Set `TRUST_PROXY=1` in your `.env` — this tells Express to trust `X-Forwarded-For` headers from the proxy (enables correct IP-based rate limiting) and also enables the `Secure` cookie flag automatically
3. Set `PM2_MATRIX_HOST=127.0.0.1` so the server only listens on localhost
4. Point your reverse proxy to `http://127.0.0.1:8080`

Example Nginx snippet:

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> With `TRUST_PROXY=1` set, Express trusts the proxy's `X-Forwarded-For` header so the rate limiter sees real client IPs and the session cookie gets the `Secure` flag. Do **not** set `TRUST_PROXY=1` if PM2 Matrix is exposed directly to the internet — it would allow attackers to spoof their IP.

### Other security measures already in place

- **Rate limiting**: Login is limited to 20 attempts per 15 minutes per IP address
- **HTTP security headers**: `helmet` adds `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and others
- **Session cookies**: `httpOnly` (not accessible from JavaScript), `sameSite: lax`, session files written with mode `0600` (owner-readable only)
- **Session fixation prevention**: a new session ID is issued on every successful login
- **All endpoints protected**: every API route and WebSocket connection requires a valid authenticated session
- **Password storage**: only a bcrypt hash is stored — the plain-text password is never saved anywhere
- **XSS-safe log search**: the search highlight function HTML-escapes the search term before inserting it into the DOM

### What to avoid

- Do not leave `SESSION_SECRET` as the placeholder — the server will refuse to start
- Do not expose port 8080 directly to the internet without HTTPS
- PM2 Matrix must run as the same OS user as PM2 — do not run it as root unless PM2 itself runs as root

---

## API Reference

All routes except `POST /api/login` require an authenticated session cookie.

| Method | Path | Description |
|---|---|---|
| POST | `/api/login` | Log in (body: `{ username, password }`) |
| POST | `/api/logout` | Destroy the current session |
| GET | `/api/me` | Check if the current session is authenticated |
| GET | `/api/services` | Get all service stats and the saved grid order |
| GET | `/api/services/:name/logs` | Get the buffered log lines for a specific service |
| POST | `/api/service/:name/restart` | Restart a service |
| POST | `/api/service/:name/reload` | Reload a service (zero-downtime for cluster mode) |
| POST | `/api/service/:name/stop` | Stop a service |
| POST | `/api/service/:name/start` | Start a stopped service |
| GET | `/api/ports` | Get listening TCP ports per service (Linux only; returns `{ ports: Record<name, number[]> }`) |
| POST | `/api/settings/poll-interval` | Set stats refresh interval (body: `{ seconds: 1–60 }`) |
| GET | `/api/layout` | Get the saved card order |
| POST | `/api/layout` | Save the card order (body: `{ order: string[] }`) |
| GET | `/api/card-filters` | Get all saved per-card log filters |
| POST | `/api/card-filters` | Save a filter for a card (body: `{ name, filter: 'all' \| 'stdout' \| 'stderr' }`) |

**WebSocket**: `ws://host:port/ws` — requires a valid session cookie. The server pushes the following message types in real time:

| Message type | When | Key fields |
|---|---|---|
| `stats` | Every poll interval | `services[]` — array of `{ name, status, cpu, memoryMB, uptimeSec }` |
| `log` | On every log line from PM2 | `app`, `level` (`stdout`/`stderr`), `message`, `timestamp` |
| `service_added` | When PM2 starts a new process | `name` |
| `service_removed` | When PM2 removes a process | `name` |
| `server_stats` | Every poll interval (alongside `stats`) | `loadAvg1`, `loadAvg5`, `loadAvg15` (null on Windows), `totalMemMB`, `usedMemMB`, `cpuCount`, `serverUptimeSec` |

---

## Troubleshooting

### The server won't start

**Error: `SESSION_SECRET is not set`**
→ Open `.env` and make sure `SESSION_SECRET` has a real value (not the placeholder). Generate one with `openssl rand -hex 32`.

**Error: `PM2_MATRIX_PASSWORD_HASH is not set`**
→ Run `npm run generate-hash YourPassword` and paste the output into `.env`.

---

### I see a blank page or "Cannot GET /"

→ You need to build the frontend first:
```bash
npm run build
npm start
```

---

### "Connection lost — reconnecting…" banner stays on screen

→ The browser cannot reach the WebSocket. Check:
1. The server is actually running (`pm2 status` or `npm start`)
2. Your firewall allows traffic on port 8080
3. If behind a reverse proxy, make sure WebSocket upgrade headers are forwarded (see the Nginx snippet above)

---

### PM2 services are not showing up

→ PM2 Matrix connects to PM2 via `~/.pm2/rpc.sock`. Make sure:
1. PM2 is running: `pm2 list`
2. PM2 Matrix is running under the **same OS user** as PM2

---

### Session cookie not sent / logged out immediately on HTTPS

→ Set `NODE_ENV=production` in your `.env` and restart the server. This enables the `Secure` flag on the cookie, which is required when the site is served over HTTPS.

---

### Port 8080 is already in use

→ Change `PM2_MATRIX_PORT` in `.env` to any free port (e.g. `9595`) and rebuild + restart.

---

## License

Licensed under the MIT License — see [LICENSE](LICENSE).
