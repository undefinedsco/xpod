import { beforeEach, describe, expect, it, vi } from 'vitest';

const startMock = vi.hoisted(() => vi.fn(async () => undefined));
const stopMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/edge/EdgeNodeAgent', () => ({
  EdgeNodeAgent: vi.fn(() => ({
    start: startMock,
    stop: stopMock,
  })),
}));

import { EdgeNodeAgentInitializer } from '../../src/edge/EdgeNodeAgentInitializer';

describe('EdgeNodeAgentInitializer', () => {
  beforeEach(() => {
    startMock.mockClear();
    stopMock.mockClear();
  });

  it('maps flat initializer P2P options into EdgeNodeAgent p2p lifecycle options', async () => {
    const initializer = new EdgeNodeAgentInitializer({
      enabled: true,
      signalEndpoint: 'https://cluster.example/api/signal',
      nodeId: 'node-1',
      nodeToken: 'node-token',
      baseUrl: 'http://127.0.0.1:3000/',
      intervalMs: '5000',
      p2pEnabled: 'true',
      p2pTargetBaseUrl: 'http://127.0.0.1:3000/',
      p2pApiBaseUrl: 'https://cluster.example/',
      p2pPollIntervalMs: '1000',
      p2pSignalingPollIntervalMs: '50',
      p2pTimeoutMs: '3000',
    });

    await initializer.handle();

    expect(startMock).toHaveBeenCalledWith(expect.objectContaining({
      signalEndpoint: 'https://cluster.example/api/signal',
      nodeId: 'node-1',
      nodeToken: 'node-token',
      intervalMs: 5_000,
      p2p: expect.objectContaining({
        enabled: true,
        targetBaseUrl: 'http://127.0.0.1:3000/',
        apiBaseUrl: 'https://cluster.example/',
        pollIntervalMs: 1_000,
        signalingPollIntervalMs: 50,
        timeoutMs: 3_000,
      }),
    }));
  });
});
