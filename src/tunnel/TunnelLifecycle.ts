import type { TunnelStage, TunnelStatus } from './TunnelProvider';

/**
 * Tunnel readiness is a sequence, not a boolean.
 *
 * A provider process that started is not a control connection, a control connection is not
 * a published proxy, and a published proxy is not proof that the Gateway is reachable from
 * outside. These helpers keep every provider reporting the same four facts so the UI and
 * the diagnostics never turn "we spawned something" into "the tunnel is up".
 */
export function createTunnelStatus(stage: TunnelStage, patch: Partial<TunnelStatus> = {}): TunnelStatus {
  return {
    running: stage !== 'stopped' && stage !== 'failed',
    connected: stage === 'proxy-ready',
    stage,
    ...patch,
  };
}

/** Keeps the previous error visible while a provider transitions through a restart. */
export function mergeTunnelError(previous: string | undefined, next: string | undefined): string | undefined {
  return next ?? previous;
}

/** Recognizes a missing client binary, which is a deployment fact, not a network failure. */
export function describeSpawnError(provider: string, binary: string, error: unknown): string {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
  if (code === 'ENOENT') {
    return `binary-missing:${provider}:${binary}`;
  }
  return `spawn-failed:${provider}:${(error as Error)?.message ?? String(error)}`;
}
