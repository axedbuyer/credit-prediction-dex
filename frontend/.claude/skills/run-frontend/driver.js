#!/usr/bin/env node
/**
 * Driver for Credit Prediction DEX frontend.
 *
 * Usage:
 *   node driver.js                   # start server + screenshot /portfolio and /market/mstr
 *   node driver.js --url /portfolio  # screenshot a specific route
 *   node driver.js --stop            # kill dev server
 *
 * Screenshots land in /tmp/credit-dex-screenshots/
 *
 * Prerequisites: run setup() once to copy missing .so files into the
 * chromium headless-shell directory. This script handles that automatically.
 */

const { chromium } = require('/home/wenxu/.npm/_npx/86170c4cd1c5da32/node_modules/playwright-core/index.js');
const { execSync, spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const FRONTEND_DIR = path.resolve(__dirname, '../../..');  // .../frontend
const CHROMEDIR = '/home/wenxu/.cache/ms-playwright/chromium_headless_shell-1226/chrome-headless-shell-linux64';
const EXECUTABLE = `${CHROMEDIR}/chrome-headless-shell`;
const SS_DIR = '/tmp/credit-dex-screenshots';
const PID_FILE = '/tmp/credit-dex-dev.pid';
const LOG_FILE = '/tmp/credit-dex-dev.log';

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) { process.stdout.write(`[driver] ${msg}\n`); }

/** Find which port the dev server is listening on (tries 3000 then 3001). */
function detectPort() {
  for (const p of [3000, 3001]) {
    try {
      execSync(`curl -sf --max-time 1 http://localhost:${p} > /dev/null 2>&1`);
      return p;
    } catch {}
  }
  return null;
}

/** Wait up to timeoutMs for the dev server to respond. */
async function waitForServer(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((res, rej) => {
        const req = http.get(`http://localhost:${port}`, res);
        req.on('error', rej);
        req.setTimeout(1000, () => req.destroy(new Error('timeout')));
      });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return false;
}

/**
 * Ensure the chromium headless-shell has the shared libs it needs.
 * Ubuntu 26.04 doesn't ship libnspr4/libnss3/libasound2 by default.
 * We download the .deb packages from the archive and copy the .so files
 * into the chromium directory, then set LD_LIBRARY_PATH.
 */
function ensureLibs() {
  if (fs.existsSync(`${CHROMEDIR}/libnspr4.so`)) return;  // already done
  log('Setting up missing shared libraries (one-time)…');

  const pkgs = {
    libnspr4:    'pool/main/n/nspr/libnspr4_4.38.2-1ubuntu1_amd64.deb',
    libnss3:     'pool/main/n/nss/libnss3_3.120-1ubuntu2_amd64.deb',
    libasound2:  'pool/main/a/alsa-lib/libasound2t64_1.2.15.3-1ubuntu1_amd64.deb',
    libglib2:    'pool/main/g/glib2.0/libglib2.0-0t64_2.88.0-1_amd64.deb',
    libdbus:     'pool/main/d/dbus/libdbus-1-3_1.16.2-2ubuntu4_amd64.deb',
    libxkb:      'pool/main/libx/libxkbcommon/libxkbcommon0_1.13.1-1_amd64.deb',
  };

  const tmpDir = '/tmp/credit-dex-libs';
  fs.mkdirSync(tmpDir, { recursive: true });

  for (const [name, path_] of Object.entries(pkgs)) {
    const debFile = `${tmpDir}/${name}.deb`;
    const extractDir = `${tmpDir}/${name}`;
    try {
      execSync(`curl -sfL "http://archive.ubuntu.com/ubuntu/${path_}" -o "${debFile}"`, { stdio: 'pipe' });
      fs.mkdirSync(extractDir, { recursive: true });
      execSync(`dpkg-deb -x "${debFile}" "${extractDir}"`, { stdio: 'pipe' });
      execSync(`find "${extractDir}" -name "*.so*" -type f -exec cp {} "${CHROMEDIR}/" \\;`, { stdio: 'pipe' });
    } catch (e) {
      log(`Warning: could not fetch ${name}: ${e.message}`);
    }
  }

  // Symlinks for versioned .so files
  const links = [
    ['libasound.so.2.0.0',        'libasound.so.2'],
    ['libglib-2.0.so.0.8800.0',   'libglib-2.0.so.0'],
    ['libgobject-2.0.so.0.8800.0','libgobject-2.0.so.0'],
    ['libgio-2.0.so.0.8800.0',    'libgio-2.0.so.0'],
    ['libgmodule-2.0.so.0.8800.0','libgmodule-2.0.so.0'],
    ['libgthread-2.0.so.0.8800.0','libgthread-2.0.so.0'],
    ['libdbus-1.so.3.38.3',        'libdbus-1.so.3'],
    ['libxkbcommon.so.0.13.1',    'libxkbcommon.so.0'],
  ];
  for (const [target, link] of links) {
    const linkPath = `${CHROMEDIR}/${link}`;
    if (!fs.existsSync(linkPath) && fs.existsSync(`${CHROMEDIR}/${target}`)) {
      try { fs.symlinkSync(target, linkPath); } catch {}
    }
  }
  log('Shared library setup complete.');
}

/** Start the Next.js dev server and return the port it bound to. */
async function startServer() {
  let port = detectPort();
  if (port) {
    log(`Dev server already running on :${port}`);
    return port;
  }

  log(`Starting dev server in ${FRONTEND_DIR}…`);
  const logStream = fs.openSync(LOG_FILE, 'w');
  const child = spawn('npm', ['run', 'dev'], {
    cwd: FRONTEND_DIR,
    detached: true,
    stdio: ['ignore', logStream, logStream],
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  log(`Dev server PID ${child.pid}, log: ${LOG_FILE}`);

  // Wait up to 45s, then detect actual port
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 1000));
    port = detectPort();
    if (port) { log(`Ready on :${port}`); return port; }
  }
  throw new Error('Dev server did not start in time. Check ' + LOG_FILE);
}

/** Stop the dev server. */
function stopServer() {
  try {
    const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
    execSync(`kill -- -$(ps -o pgid= -p ${pid} | tr -d ' ') 2>/dev/null || kill ${pid} 2>/dev/null || true`);
    fs.unlinkSync(PID_FILE);
    log('Dev server stopped.');
  } catch {
    execSync("pkill -f 'next dev' 2>/dev/null || true");
    log('Killed next dev processes.');
  }
}

/** Launch browser, navigate to route, take screenshot. Returns path. */
async function screenshot(port, route, outFile) {
  ensureLibs();
  process.env.LD_LIBRARY_PATH = CHROMEDIR + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '');

  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });

    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    // Use 'load' — pages with pollers never reach 'networkidle'.
    // 45s timeout: Next.js compiles each route on first request (~10-30s cold).
    await page.goto(`http://localhost:${port}${route}`, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(2500);

    fs.mkdirSync(SS_DIR, { recursive: true });
    const ssPath = outFile || `${SS_DIR}/${route.replace(/\//g, '_').replace(/^_/, '')}.png`;
    await page.screenshot({ path: ssPath });
    log(`Screenshot: ${ssPath}`);

    const realErrors = consoleErrors.filter(e =>
      !e.includes('404') && !e.includes('localhost:3001/orderbook') && !e.includes('localhost:3000/orderbook')
    );
    if (realErrors.length) {
      log('JS console errors:\n' + realErrors.join('\n'));
    }

    return ssPath;
  } finally {
    await browser.close();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const args = process.argv.slice(2);

  if (args.includes('--stop')) {
    stopServer();
    return;
  }

  const urlIdx = args.indexOf('--url');
  const routes = urlIdx !== -1
    ? [args[urlIdx + 1]]
    : ['/portfolio', '/market/mstr'];

  const port = await startServer();

  for (const route of routes) {
    await screenshot(port, route);
  }

  log('Done. Screenshots in ' + SS_DIR);
})().catch(e => { console.error(e); process.exit(1); });
