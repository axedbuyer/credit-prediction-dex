// Graceful-shutdown orchestration for main.ts.
//
// Wires SIGTERM/SIGINT to run an ordered list of steps once, bounded by a
// timeout, so a Railway redeploy (which sends SIGTERM) doesn't kill the
// server mid-request or leave an in-flight order-book mutation half-applied.

export interface ShutdownStep {
  name: string
  run: () => Promise<void>
}

export interface ShutdownOptions {
  /** Overall budget for all steps combined. Defaults to env SHUTDOWN_TIMEOUT_MS, else 25000. */
  timeoutMs?: number
  /** Injectable for tests — defaults to process.exit. */
  exit?: (code: number) => void
  /** Injectable for tests — defaults to ['SIGTERM', 'SIGINT']. */
  signals?: NodeJS.Signals[]
  logger?: Pick<typeof console, 'log' | 'error'>
}

/** SHUTDOWN_TIMEOUT_MS — overall shutdown budget in ms. Unset/blank/invalid/negative -> 25000. */
export function defaultShutdownTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SHUTDOWN_TIMEOUT_MS
  if (raw == null || raw.trim() === '') return 25_000
  const n = Number(raw.trim())
  return Number.isFinite(n) && n >= 0 ? n : 25_000
}

/**
 * Wires SIGTERM/SIGINT (once — a second signal forces immediate exit(1)) to run
 * `steps` in order. Each step is logged and swallowed individually so one
 * failing step doesn't abandon the rest. Bounded by opts.timeoutMs, via an
 * unref'd timer (never itself keeps the process alive) — on timeout, logs
 * whichever step names hadn't completed yet and exits 1.
 */
export function installShutdownHandlers(
  serviceName: string,
  steps: ShutdownStep[],
  opts: ShutdownOptions = {},
): { shutdown: (signal: string) => Promise<void> } {
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  const timeoutMs = opts.timeoutMs ?? defaultShutdownTimeoutMs()
  const logger = opts.logger ?? console
  let shuttingDown = false

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      logger.error(`[${serviceName}] ${signal} received again — forcing immediate exit`)
      exit(1)
      return
    }
    shuttingDown = true
    logger.log(`[${serviceName}] ${signal} received — shutting down`)

    const pending = new Set(steps.map(s => s.name))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      logger.error(
        `[${serviceName}] shutdown timed out after ${timeoutMs}ms — still pending: ` +
        `${[...pending].join(', ') || 'none'}`,
      )
      exit(1)
    }, timeoutMs)
    timer.unref?.()

    for (const step of steps) {
      if (timedOut) break
      try {
        await step.run()
      } catch (err) {
        logger.error(`[${serviceName}] shutdown step "${step.name}" failed:`, err)
      }
      pending.delete(step.name)
    }

    clearTimeout(timer)
    if (!timedOut) {
      logger.log(`[${serviceName}] shutdown complete`)
      exit(0)
    }
  }

  for (const signal of opts.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[])) {
    process.on(signal, () => { void shutdown(signal) })
  }

  return { shutdown }
}
