// Graceful SIGTERM/SIGINT shutdown for the matching-engine process.
//
// Drain sequence (see root CLAUDE.md "CLOB Architecture" for the engine/settler
// split this depends on):
//   1. Stop the engine's poll interval so no NEW match cycle starts.
//   2. Await any runOnce() cycle that was already in flight (MatchingEngine.stop()).
//      This is what lets a just-emitted 'matched' event finish being handed to
//      the settler's queue before we start waiting on that queue.
//   3. Await the settler's queue draining (submitted tx's receipt + Redis
//      cleanup), if a settler is wired at all (log-only mode has none).
//   4. Quit the Redis connection, if one was opened.
// Bounded by SHUTDOWN_TIMEOUT_MS (default 25000, unref'd so it never itself
// keeps the process alive) — on timeout, log exactly what was still pending
// and exit(1) instead of hanging a redeploy forever.
//
// Kept deliberately dependency-light (no reference to MatchingEngine/Settler
// types) so it's easy to unit test with fakes; main.ts supplies the real
// stop/drain/close functions.

export interface ShutdownDeps {
  /** e.g. console.log */
  log: (message: string) => void
  /** MatchingEngine.stop() — clears the interval and awaits any in-flight cycle. */
  stopEngine: () => Promise<void>
  /** Settler.whenIdle() — awaits the settlement queue draining. Omit if no settler is wired. */
  drainSettler?: () => Promise<void>
  /** Settler.describePending() — for timeout logging only. Omit if no settler is wired. */
  describePending?: () => string | null
  /** Redis#quit() — omit if no Redis connection was opened. */
  closeRedis?: () => Promise<void>
  /** Defaults to process.exit; injectable for tests. */
  exit?: (code: number) => void
  /** ms before giving up and force-exiting. Defaults to 25000. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 25_000

/**
 * Runs the drain sequence once. Exported mainly for direct testing; production
 * code should go through createShutdownHandler so a second signal forces an
 * immediate exit instead of running this twice concurrently.
 */
export async function gracefulShutdown(signal: string, deps: ShutdownDeps): Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  deps.log(`[matching-engine] ${signal} received — draining`)

  // `settled` guards against BOTH branches acting twice (a real process.exit()
  // from the timeout would kill the drain outright, but the injectable `exit`
  // used in tests doesn't, so the drain chain can still be running — and must
  // still notice — after the timeout has already fired).
  let settled = false
  // Assigned synchronously below (the Promise executor runs immediately) —
  // the definite-assignment assertion just tells tsc what's already true.
  let timer!: ReturnType<typeof setTimeout>

  const timeoutPromise = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      if (settled) return
      settled = true
      const pending = deps.describePending?.() ?? null
      deps.log(
        `[matching-engine] shutdown timed out after ${timeoutMs}ms — ` +
        (pending ? `pending settlement: ${pending}` : 'no settlement was reported pending'),
      )
      exit(1)
      resolve()
    }, timeoutMs)
    // Never let this timer itself keep the process alive if everything else
    // has already exited cleanly for some other reason.
    timer.unref()
  })

  const drainPromise = (async () => {
    try {
      await deps.stopEngine()
      if (deps.drainSettler) await deps.drainSettler()
      if (settled) return  // timed out while we were awaiting — already exited(1)

      if (deps.closeRedis) await deps.closeRedis()
      if (settled) return

      settled = true
      clearTimeout(timer)
      deps.log('[matching-engine] drained — exiting')
      exit(0)
    } catch (err) {
      if (settled) return  // already handled by the timeout path
      settled = true
      clearTimeout(timer)
      deps.log(`[matching-engine] error while draining — exiting: ${String(err)}`)
      exit(1)
    }
  })()

  // Whichever finishes first decides the outcome. In production, exit()
  // is process.exit() and the loser's continuation never gets scheduled at
  // all; in tests, the loser keeps running in the background but its guarded
  // `settled` checks make it a no-op.
  await Promise.race([timeoutPromise, drainPromise])
}

/**
 * Returns a signal handler for main.ts to register with process.on(). The
 * first call runs the drain sequence; any call while a drain is already in
 * progress logs and force-exits immediately (exit(1)) rather than starting a
 * second, overlapping drain.
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  let draining = false

  return (signal: string) => {
    if (draining) {
      deps.log(`[matching-engine] ${signal} received again — forcing exit`)
      exit(1)
      return
    }
    draining = true
    void gracefulShutdown(signal, deps)
  }
}
