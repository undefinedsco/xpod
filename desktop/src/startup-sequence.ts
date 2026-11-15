/**
 * Ordering of the packaged startup steps: create the window without waiting for
 * runtime readiness. Readiness is bounded (60s by default) and the packaged
 * harness allows the same 60s for the first window, so serializing window
 * creation behind that wait can consume the whole window budget.
 */

export interface StartupSequenceHooks {
  /** Create the main window; its existing readiness guards control showing. */
  createWindow: () => void
  /** Start the runtime and resolve once it settles (may reject). */
  startRuntime: () => Promise<unknown>
  /** Refresh tray status after the runtime settles. */
  refreshTray: () => void | Promise<void>
  /** Called once the startup attempt finished, success or failure. */
  onSettled?: () => void
}

export interface StartupSequenceResult {
  /** Settles when the whole background startup finished. Never rejects. */
  settled: Promise<void>
}

/**
 * Create the window independently of runtime readiness, then refresh the tray
 * when the startup attempt settles. RuntimeManager retains the startup result.
 */
export function runStartupSequence(hooks: StartupSequenceHooks): StartupSequenceResult {
  hooks.createWindow()
  const settled = (async () => {
    try {
      await hooks.startRuntime()
    } catch {
      // Preserve the existing policy: a startup failure does not quit the app.
    }
    try {
      await hooks.refreshTray()
    } catch {
      // A tray refresh failure must not surface as an unhandled rejection.
    }
    try {
      hooks.onSettled?.()
    } catch {
      // A settle hook failure must not turn the background start into a rejection.
    }
  })()
  return { settled }
}
