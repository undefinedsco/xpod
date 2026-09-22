import { describe, expect, it, vi } from 'vitest';
import { AutoTunnelProvider, type AutoTunnelCandidate } from '../../src/tunnel/AutoTunnelProvider';
import type { TunnelConfig, TunnelProvider, TunnelSetupOptions, TunnelStatus } from '../../src/tunnel/TunnelProvider';

const SETUP: TunnelSetupOptions = { subdomain: 'local', localPort: 3399, localProtocol: 'http' };

/**
 * The operator configures the providers they have credentials for; which of them
 * can reach its control plane depends on the network they are on. The auto
 * provider settles that by readiness, and reports why the losers lost.
 */

interface FakeOptions {
  /** Stages the provider walks through, one per `getStatus` call. */
  stages: TunnelStatus[];
  endpoint?: string;
  startError?: Error;
  setupError?: Error;
}

function fakeProvider(options: FakeOptions) {
  const calls = { setup: 0, start: 0, stop: 0, cleanup: 0 };
  let index = 0;
  const current = (): TunnelStatus => options.stages[Math.min(index, options.stages.length - 1)]!;
  const provider: TunnelProvider = {
    name: 'fake',
    setup: vi.fn(async(): Promise<TunnelConfig> => {
      calls.setup += 1;
      if (options.setupError) throw options.setupError;
      return { subdomain: 'local', provider: 'cloudflare', endpoint: options.endpoint ?? '', originUrl: 'http://127.0.0.1:3399' };
    }),
    start: vi.fn(async(): Promise<void> => {
      calls.start += 1;
      if (options.startError) throw options.startError;
    }),
    stop: vi.fn(async(): Promise<void> => {
      calls.stop += 1;
    }),
    getStatus: (): TunnelStatus => {
      const status = current();
      index += 1;
      return status;
    },
    getEndpoint: (): string | undefined => options.endpoint,
    cleanup: vi.fn(async(): Promise<void> => {
      calls.cleanup += 1;
    }),
  };
  return { provider, calls };
}

function candidate(id: string, options: FakeOptions): { candidate: AutoTunnelCandidate; calls: ReturnType<typeof fakeProvider>['calls'] } {
  const { provider, calls } = fakeProvider(options);
  return { candidate: { id, provider }, calls };
}

const READY: TunnelStatus = { running: true, connected: true, stage: 'proxy-ready' };
const FAILED: TunnelStatus = { running: false, connected: false, stage: 'failed', error: 'token rejected' };
const STARTING: TunnelStatus = { running: true, connected: false, stage: 'process-started' };

describe('AutoTunnelProvider', () => {
  it('uses the first candidate that actually publishes a proxy', async () => {
    const blocked = candidate('ngrok', { stages: [STARTING, FAILED], endpoint: 'https://ngrok.example/' });
    const working = candidate('cloudflare', { stages: [STARTING, STARTING, READY], endpoint: 'https://node.example/' });
    const provider = new AutoTunnelProvider({
      candidates: [blocked.candidate, working.candidate],
      readinessTimeoutMs: 500,
      pollIntervalMs: 1,
    });

    const config = await provider.setup(SETUP);
    await provider.start(config);

    expect(provider.getEndpoint()).toBe('https://node.example/');
    expect(provider.getStatus()).toMatchObject({ stage: 'proxy-ready', connected: true });
    // The blocked provider is stopped, not left half-started behind the winner.
    expect(blocked.calls.start).toBe(1);
    expect(blocked.calls.stop).toBe(1);
    expect(working.calls.stop).toBe(0);
    // A candidate that never became ready is reported with its reason.
    expect(provider.getAttempts()).toEqual(['ngrok: token rejected']);
  });

  it('never reports connected when no candidate works, and names every attempt', async () => {
    const first = candidate('ngrok', { stages: [STARTING, FAILED], endpoint: 'https://ngrok.example/' });
    const second = candidate('cloudflare', { stages: [STARTING, STARTING], endpoint: 'https://node.example/' });
    const provider = new AutoTunnelProvider({
      candidates: [first.candidate, second.candidate],
      readinessTimeoutMs: 10,
      pollIntervalMs: 1,
    });

    await provider.start(await provider.setup(SETUP));

    const status = provider.getStatus();
    expect(status.connected).toBe(false);
    expect(status.running).toBe(false);
    expect(status.stage).toBe('failed');
    expect(status.error).toContain('no-tunnel-candidate-ready');
    expect(status.error).toContain('ngrok: token rejected');
    expect(status.error).toContain('cloudflare');
    expect(provider.getEndpoint()).toBeUndefined();
  });

  it('keeps a candidate that cannot even start from hiding the rest', async () => {
    const broken = candidate('ngrok', { stages: [STARTING], startError: new Error('binary-missing:ngrok:/nope') });
    const working = candidate('cloudflare', { stages: [READY], endpoint: 'https://node.example/' });
    const provider = new AutoTunnelProvider({
      candidates: [broken.candidate, working.candidate],
      readinessTimeoutMs: 200,
      pollIntervalMs: 1,
    });

    await provider.start(await provider.setup(SETUP));

    expect(provider.getStatus()).toMatchObject({ connected: true, stage: 'proxy-ready' });
    expect(provider.getAttempts()).toEqual(['ngrok: binary-missing:ngrok:/nope']);
    expect(broken.calls.stop).toBe(1);
  });

  it('reports a candidate whose preparation failed instead of dropping it silently', async () => {
    const unpreparable = candidate('cloudflare', { stages: [READY], setupError: new Error('cloudflared missing') });
    const provider = new AutoTunnelProvider({
      candidates: [unpreparable.candidate],
      readinessTimeoutMs: 20,
      pollIntervalMs: 1,
    });

    await provider.start(await provider.setup(SETUP));

    expect(unpreparable.calls.start).toBe(0);
    expect(provider.getStatus().error).toContain('cloudflared missing');
  });

  it('stops every candidate it started and forgets the winner', async () => {
    const blocked = candidate('ngrok', { stages: [FAILED] });
    const working = candidate('cloudflare', { stages: [READY], endpoint: 'https://node.example/' });
    const provider = new AutoTunnelProvider({
      candidates: [blocked.candidate, working.candidate],
      readinessTimeoutMs: 200,
      pollIntervalMs: 1,
    });

    await provider.start(await provider.setup(SETUP));
    expect(provider.getEndpoint()).toBe('https://node.example/');

    await provider.stop();

    expect(working.calls.stop).toBe(1);
    expect(provider.getEndpoint()).toBeUndefined();
    expect(provider.getStatus()).toMatchObject({ stage: 'stopped', connected: false });
  });
});
