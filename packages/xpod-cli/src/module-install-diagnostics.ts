/** Fixed, bounded timing events. Never include user, registry or filesystem values. */
export const MODULE_INSTALL_DIAGNOSTIC_LIMIT = 64;
export const MODULE_INSTALL_PHASES = ['lock-acquire', 'metadata', 'archive-download-hash', 'archive-scan',
  'archive-extract', 'manifest-modes', 'verify-manifest', 'verify-files', 'verify-walk', 'publish', 'cleanup'] as const;
export type ModuleInstallPhase = typeof MODULE_INSTALL_PHASES[number];
export interface ModuleInstallDiagnostic {
  kind: 'module-install-phase'; phase: ModuleInstallPhase; state: 'started' | 'completed' | 'failed';
  elapsedMs: number; durationMs?: number;
}
export type ModuleInstallPhaseEvent = ModuleInstallDiagnostic;
export type ModuleInstallDiagnosticObserver = (event: ModuleInstallDiagnostic) => void;
export function createModuleInstallDiagnostics(observer?: ModuleInstallDiagnosticObserver) {
  const origin = observer ? performance.now() : 0; let elapsed = 0; let lines = 0;
  const now = () => !observer ? 0 : (elapsed = Math.max(elapsed, Math.round((performance.now() - origin) * 1000) / 1000));
  const emit = (phase: ModuleInstallPhase, state: ModuleInstallDiagnostic['state'], started?: number) => {
    const elapsedMs = now();
    if (!observer || lines >= MODULE_INSTALL_DIAGNOSTIC_LIMIT || !MODULE_INSTALL_PHASES.includes(phase)
      || !['started', 'completed', 'failed'].includes(state)) return;
    lines++;
    try { observer({ kind: 'module-install-phase', phase, state, elapsedMs,
      ...(started === undefined ? {} : { durationMs: Math.max(0, Math.round((elapsedMs - started) * 1000) / 1000) }) }); }
    catch { /* Diagnostics must never change installation or its original failure. */ }
  };
  return {
    start(phase: ModuleInstallPhase) {
      const started = now(); emit(phase, 'started'); let finished = false;
      return (state: 'completed' | 'failed') => { if (!finished) { finished = true; emit(phase, state, started); } };
    },
    async run<T>(phase: ModuleInstallPhase, action: () => T | Promise<T>): Promise<T> {
      const finish = this.start(phase);
      try { const result = await action(); finish('completed'); return result; }
      catch (cause) { finish('failed'); throw cause; }
    },
  };
}
export type ModuleInstallDiagnostics = ReturnType<typeof createModuleInstallDiagnostics>;
