---
name: run-frontend
description: Run, start, launch, screenshot, or verify the Credit Prediction DEX Next.js frontend. Use when asked to run the app, take a screenshot, confirm a UI change works, or test the dev server.
---

# run-frontend

Next.js 14 frontend for the Credit Prediction DEX. The driver at `.claude/skills/run-frontend/driver.js` handles starting the dev server, launching a headless browser, and taking screenshots.

All paths below are relative to `frontend/`.

## Prerequisites

The driver auto-installs missing shared libraries on first run (downloads from Ubuntu archive). The only hard requirement is that the playwright-core package is already in the npm npx cache:

```
/home/wenxu/.npm/_npx/86170c4cd1c5da32/node_modules/playwright-core/index.js
```

This is present because prior sessions ran `npx playwright`. If it's missing, run:

```bash
npx playwright --version
```

## Run (agent path)

### Start + screenshot default pages

```bash
node .claude/skills/run-frontend/driver.js
```

Starts the dev server (if not already running), then screenshots `/portfolio` and `/market/mstr`. Output lands in `/tmp/credit-dex-screenshots/`.

### Screenshot a specific route

```bash
node .claude/skills/run-frontend/driver.js --url /portfolio
node .claude/skills/run-frontend/driver.js --url /market/mstr
node .claude/skills/run-frontend/driver.js --url /admin
```

### Stop the dev server

```bash
node .claude/skills/run-frontend/driver.js --stop
```

### Read screenshots

Use the `Read` tool on the output path, e.g. `/tmp/credit-dex-screenshots/portfolio.png`.

## Run (human path)

```bash
npm run dev
```

Opens at http://localhost:3000 (or :3001 if 3000 is in use). Access from Windows browser (this is WSL2 — `localhost` tunnels through automatically).

## Type-check

```bash
npm run type-check
```

## Gotchas

**First navigation can take 30–40s cold.** Next.js compiles each route on first request. The driver uses a 45s timeout. Do not shrink it.

**`networkidle` never settles on the market page.** The OrderBook component polls `/orderbook` every 2 s. Use `waitUntil: 'load'` — the driver already does this.

**`libnspr4.so`, `libnss3.so`, `libasound.so.2` missing on Ubuntu 26.04.** The playwright chromium headless-shell needs these but they aren't installed by default. The driver downloads the relevant `.deb` files from `archive.ubuntu.com` on first run, extracts the `.so` files, and copies them into the chromium binary directory. It also sets `LD_LIBRARY_PATH` before launching. This is a one-time setup (~5 s).

**ERR_CONNECTION_REFUSED in browser console (market page).** Expected — the order book server (`localhost:3001/orderbook`) isn't running in dev. The page renders correctly; the order book panel shows "No orders". Ignore these errors.

**Port may be 3001 instead of 3000.** If something else holds 3000, Next.js binds to 3001. The driver detects this automatically by polling both ports.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `libnspr4.so: cannot open shared object file` | Run the driver once — it auto-fetches and copies the library. Or run: `curl -sfL "http://archive.ubuntu.com/ubuntu/pool/main/n/nspr/libnspr4_4.38.2-1ubuntu1_amd64.deb" -o /tmp/nspr.deb && dpkg-deb -x /tmp/nspr.deb /tmp/nspr_ext && cp /tmp/nspr_ext/usr/lib/x86_64-linux-gnu/libnspr4.so /home/wenxu/.cache/ms-playwright/chromium_headless_shell-1226/chrome-headless-shell-linux64/` |
| Timeout on first nav | Dev server was still compiling. Re-run the driver — it reuses the warm server. |
| `playwright-core` not found | Run `npx playwright --version` to populate the cache, then retry. |
| Port already in use | Kill stale servers: `pkill -f 'next dev'` |
