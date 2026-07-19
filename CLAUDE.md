# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev:server   # ts-node-dev backend (hot reload)
npm run dev:client   # Vite frontend dev server
npm run build        # build:client (Vite) + build:server (tsc)
npm run start        # node dist-server/index.js (production)
npm run typecheck    # typecheck:client + typecheck:server
npm run lint         # ESLint (server + client)
npm run generate-hash <password>  # bcrypt hash for admin password setup
```

No test runner is configured.

## Architecture

Local web dashboard for monitoring and controlling PM2-managed processes. **Express** backend + **React** (Vite) SPA + **WebSocket** push updates.

**Server** (`src/server/`): Express app with session auth (bcrypt password, `express-session` + file store). All `/api/*` routes require `requireAuth`. Service actions (restart/reload/stop/start) validate the name against the live PM2 process list before dispatching — prevents acting on arbitrary injected names.

**PM2 integration** (`pm2Service.ts`): polls PM2 at configurable interval; exposes `getServiceStats()`, `getLogs()`, restart/reload/stop/start. Reconnect loop handles PM2 unavailability at startup.

**Persistent state** (stored in `data/` as JSON files):
- `layoutStore.ts` — drag-and-drop card order
- `filterStore.ts` — per-service log stream filter (`all` / `stdout` / `stderr`)
- `archiveStore.ts` — per-service archive (hide from main view)

All three stores call `pruneUnknown(knownNames)` on every write to prevent unbounded growth as services change.

**WebSocket** (`websocket.ts`): pushes PM2 state updates to all connected browser clients.

**Port probe** (`portService.ts`): resolves listening ports for each service's PIDs; falls back to UID-based matching when direct PID lookup fails (`fallbackUsed` flag returned to frontend).

**Auth setup**: set `PM2_MATRIX_PASSWORD_HASH` in `.env` (generate with `npm run generate-hash`). Set `TRUST_PROXY=1` when behind a reverse proxy.
