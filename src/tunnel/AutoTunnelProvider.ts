import { getLoggerFor } from 'global-logger-factory';
import type { TunnelConfig, TunnelProvider, TunnelSetupOptions, TunnelStatus } from './TunnelProvider';
import { createTunnelStatus } from './TunnelLifecycle';

/** One tunnel the auto provider may bring up, in the order it is worth trying. */
export interface AutoTunnelCandidate {
  /** Provider or profile id, used in status and in the failure detail. */
  id: string;
  provider: TunnelProvider;
}

export interface AutoTunnelProviderOptions {
  candidates: readonly AutoTunnelCandidate[];
  /**
   * How long one candidate gets to reach `proxy-ready` before the next one is
   * tried. A candidate that is blocked (network policy, rejected credential)
   * usually fails faster than this; the timeout only bounds the silent ones.
   */
  readinessTimeoutMs?: number;
  /** Poll interval while waiting for readiness. */
  pollIntervalMs?: number;
}

const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * Brings up whichever tunnel actually works.
 *
 * An operator configures the providers they have credentials for; which of them
 * can reach its control plane is a property of the network, not of the list. So
 * the candidates are tried in order and the first one that publishes a proxy
 * wins, with the losers stopped and their reasons kept for the failure report.
 * An explicit selection never goes through here: the runtime registers that
 * provider directly, so a closed or pinned tunnel cannot come back on its own.
 */
export class AutoTunnelProvider implements TunnelProvider {
  public readonly name = 'auto';
  private readonly logger = getLoggerFor(this);
  private readonly candidates: readonly AutoTunnelCandidate[];
  private readonly readinessTimeoutMs: number;
  private readonly pollIntervalMs: number;

  private configs = new Map<string, TunnelConfig>();
  private active?: AutoTunnelCandidate;
  private started: AutoTunnelCandidate[] = [];
  private status: TunnelStatus = createTunnelStatus('stopped');
  /** Why each candidate that did not win was dropped. */
  private readonly attempts: string[] = [];

  constructor(options: AutoTunnelProviderOptions) {
    this.candidates = options.candidates;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  public async setup(options: TunnelSetupOptions): Promise<TunnelConfig> {
    this.configs = new Map();
    for (const candidate of this.candidates) {
      try {
        this.configs.set(candidate.id, await candidate.provider.setup(options));
      } catch (error) {
        this.attempts.push(`${candidate.id}: ${describeError(error)}`);
        this.logger.warn(`Tunnel candidate ${candidate.id} could not be prepared: ${describeError(error)}`);
      }
    }
    // The driver round-trips this config back into `start`, which drives the
    // candidates itself, so it only has to describe the requested origin.
    const first = this.candidates[0];
    const config = first ? this.configs.get(first.id) : undefined;
    return config ?? {
      subdomain: options.subdomain,
      provider: 'cloudflare',
      endpoint: '',
      originUrl: `${options.localProtocol ?? 'http'}://127.0.0.1:${options.localPort}`,
    };
  }

  public async start(config?: TunnelConfig): Promise<void> {
    void config;
    for (const candidate of this.candidates) {
      const candidateConfig = this.configs.get(candidate.id);
      if (!candidateConfig) {
        continue;
      }
      this.status = createTunnelStatus('process-started', { endpoint: candidate.provider.getEndpoint() });
      try {
        this.started.push(candidate);
        await candidate.provider.start(candidateConfig);
        const ready = await this.waitForReady(candidate.provider);
        if (ready) {
          this.active = candidate;
          this.status = withCandidate(candidate, candidate.provider.getStatus());
          this.logger.info(`Tunnel ready through ${candidate.id}`);
          await this.stopLosers(candidate);
          return;
        }
        this.attempts.push(`${candidate.id}: ${describeStatus(candidate.provider.getStatus())}`);
        this.logger.warn(`Tunnel candidate ${candidate.id} did not become ready; trying the next one`);
        await this.dropCandidate(candidate);
      } catch (error) {
        this.attempts.push(`${candidate.id}: ${describeError(error)}`);
        this.logger.warn(`Tunnel candidate ${candidate.id} failed: ${describeError(error)}`);
        await this.dropCandidate(candidate);
      }
    }

    // Nothing worked: report which candidates were tried and why, so a caller
    // never has to guess whether the tunnel is off or merely unreachable.
    const detail = this.attempts.length > 0
      ? this.attempts.join('; ')
      : 'no tunnel provider is configured';
    this.status = createTunnelStatus('failed', { error: `no-tunnel-candidate-ready: ${detail}` });
  }

  public async stop(): Promise<void> {
    const targets = this.started;
    this.started = [];
    this.active = undefined;
    await Promise.all(targets.map(async (candidate) => {
      await candidate.provider.stop().catch((error: unknown) => {
        this.logger.warn(`Stopping tunnel candidate ${candidate.id} failed: ${describeError(error)}`);
      });
    }));
    this.status = createTunnelStatus('stopped');
  }

  public getStatus(): TunnelStatus {
    if (!this.active) {
      return this.status;
    }
    const current = this.active.provider.getStatus();
    // A tunnel that was ready and then died is still the active one, so its
    // failure is what callers must see - never a stale "connected".
    return withCandidate(this.active, current);
  }

  public getEndpoint(): string | undefined {
    return this.active?.provider.getEndpoint();
  }

  public async cleanup(config: TunnelConfig): Promise<void> {
    await Promise.all(this.candidates.map(async (candidate) => {
      await candidate.provider.cleanup(config).catch((error: unknown) => {
        this.logger.warn(`Cleaning up tunnel candidate ${candidate.id} failed: ${describeError(error)}`);
      });
    }));
  }

  /** Id of the candidate currently serving, once one is ready. */
  public getActiveId(): string | undefined {
    return this.active?.id;
  }

  /** The candidates that were tried, and why the ones that lost did. */
  public getAttempts(): readonly string[] {
    return this.attempts;
  }

  private async waitForReady(provider: TunnelProvider): Promise<boolean> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    while (Date.now() < deadline) {
      const status = provider.getStatus();
      if (status.stage === 'proxy-ready' || status.connected) {
        return true;
      }
      if (status.stage === 'failed') {
        return false;
      }
      await delay(this.pollIntervalMs);
    }
    return false;
  }

  /** Stop a candidate that lost and stop counting it as started. */
  private async dropCandidate(candidate: AutoTunnelCandidate): Promise<void> {
    await candidate.provider.stop().catch((error: unknown) => {
      this.logger.warn(`Stopping tunnel candidate ${candidate.id} failed: ${describeError(error)}`);
    });
    this.started = this.started.filter((started) => started.id !== candidate.id);
  }

  private async stopLosers(winner: AutoTunnelCandidate): Promise<void> {
    await Promise.all(this.started
      .filter((candidate) => candidate.id !== winner.id)
      .map(async (candidate) => {
        await candidate.provider.stop().catch(() => undefined);
      }));
    this.started = [winner];
  }
}

/**
 * The winning candidate's own status, with its error text attributed to the
 * profile id the operator configured rather than to the provider class name.
 */
function withCandidate(candidate: AutoTunnelCandidate, status: TunnelStatus): TunnelStatus {
  const stage = status.stage ?? (status.connected ? 'proxy-ready' : 'process-started');
  const error = status.error ? `${candidate.id}: ${status.error}` : undefined;
  return createTunnelStatus(stage, {
    ...status,
    ...(error ? { error } : {}),
  });
}

function describeStatus(status: TunnelStatus): string {
  return status.error ?? status.stage ?? (status.connected ? 'connected' : 'unknown');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
