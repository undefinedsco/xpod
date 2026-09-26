import path from 'node:path';
import { describeTunnelClientMissing } from './TunnelClientResolver';
import { canonicalTunnelProviderId } from './TunnelProviderCatalog';
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

/**
 * Recognizes a missing client binary, which is a deployment fact, not a network failure.
 *
 * The prefix stays `binary-missing:<provider>:<binary>` (callers and acceptance assert on it);
 * `<provider>` is resolved to the catalog id first, so an implementation that calls itself
 * `sakura-frp` cannot put a provider id into the message that no catalog lookup resolves.
 * The install hint from the provider catalog is appended so an operator reading the failure
 * knows what to install instead of having to search (audit N16).
 */
export function describeSpawnError(provider: string, binary: string, error: unknown): string {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
  // `spawn-failed` is a plain diagnostic, but its provider segment is normalized the same way
  // so both families of message name the same provider.
  const id = canonicalTunnelProviderId(provider) ?? provider;
  if (code === 'ENOENT') {
    // The prefix stays `binary-missing:<provider>:<binary name>` because callers assert on it;
    // when the command was an absolute path, which file was tried is appended for the operator.
    const name = path.basename(binary);
    const message = describeTunnelClientMissing(id, name);
    return name === binary ? message : `${message} (tried: ${binary})`;
  }
  return `spawn-failed:${id}:${(error as Error)?.message ?? String(error)}`;
}
