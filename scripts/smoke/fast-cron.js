// Smoke-only preload (node -r): makes the funding-keeper's REAL main() tick fast without
// editing it. funding-keeper.ts schedules its cycle with node-cron "0 */8 * * *" (wall
// clock, 8h) — here we swap every node-cron expression for SMOKE_CRON (default every 4s;
// node-cron accepts a leading seconds field). Nothing else about the keeper changes.
const Module = require('module')
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  const mod = origLoad.apply(this, arguments)
  if (request === 'node-cron' && mod && typeof mod.schedule === 'function' && !mod.__smokeFast) {
    const orig = mod.schedule.bind(mod)
    const expr = process.env.SMOKE_CRON || '*/4 * * * * *'
    mod.schedule = (_expression, cb, opts) => orig(expr, cb, opts)
    mod.__smokeFast = true
  }
  return mod
}
