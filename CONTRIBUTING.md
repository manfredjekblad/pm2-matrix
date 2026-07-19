# Contributing to PM2 Matrix

Thanks for your interest in contributing. By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs and proposing features

Use [GitHub Issues](https://github.com/manfredjekblad/pm2-matrix/issues). Include steps to reproduce for bugs, and a clear use case for feature requests.

Do **not** open public issues for security vulnerabilities — see [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node.js 18+, PM2 on Linux or macOS (same OS user as this app).

```bash
cp .env.example .env
# Set PM2_MATRIX_PASSWORD_HASH and SESSION_SECRET (see README)

npm install

# Terminal 1 — API (hot reload)
npm run dev:server

# Terminal 2 — Vite UI (proxies /api and /ws)
npm run dev:client
```

Open `http://localhost:5173`.

## Before you open a pull request

There is no automated test suite yet. Please ensure:

```bash
npm run lint
npm run typecheck
npm run build
```

all succeed.

## Pull request guidelines

- Keep changes focused and explain **why** in the PR description.
- Do not commit `.env`, session files under `data/sessions/`, or other runtime state.
- Prefer small PRs that are easy to review.
