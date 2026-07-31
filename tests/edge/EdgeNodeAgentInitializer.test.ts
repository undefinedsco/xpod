import { beforeEach, describe, expect, it, vi } from 'vitest';

const startMock = vi.hoisted(() => vi.fn(async () => undefined));
const stopMock = vi.hoisted(() => vi.fn());
const certificateRuntimeMock = vi.hoisted(() => ({
  readCertificateStatus: vi.fn(async () => ({
    status: 'valid',
    expiresAt: '2026-10-31T00:00:00.000Z',
  })),
  renewCertificate: vi.fn(async () => undefined),
}));

vi.mock('../../src/edge/EdgeNodeAgent', () => ({
  EdgeNodeAgent: vi.fn(() => ({
    start: startMock,
    stop: stopMock,
    getCertificateRuntime: vi.fn(() => certificateRuntimeMock),
  })),
}));

import { EdgeNodeAgentInitializer } from '../../src/edge/EdgeNodeAgentInitializer';
import {
  getEdgeNodeCertificateCapabilityBridge,
  resolveEdgeNodeCertificateCapabilityBridgeId,
} from '../../src/edge/EdgeNodeCertificateCapabilityBridge';

describe('EdgeNodeAgentInitializer', () => {
  beforeEach(() => {
    startMock.mockClear();
    stopMock.mockClear();
    certificateRuntimeMock.readCertificateStatus.mockClear();
    certificateRuntimeMock.renewCertificate.mockClear();
    getEdgeNodeCertificateCapabilityBridge('node:node-1').clearSource();
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
      p2pLabel: 'xpod-p2p-http',
      p2pAcceptIntervalMs: '1500',
      p2pConnectTimeoutMs: '7000',
      p2pWinnerSelectionWindowMs: '50',
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
        label: 'xpod-p2p-http',
        acceptIntervalMs: 1_500,
        connectTimeoutMs: 7_000,
        winnerSelectionWindowMs: 50,
      }),
    }));
  });

  it('publishes and clears the active agent certificate capability bridge', async () => {
    const initializer = new EdgeNodeAgentInitializer({
      enabled: true,
      signalEndpoint: 'https://cluster.example/api/signal',
      nodeId: 'node-1',
      nodeToken: 'node-token',
      certificateBridgeId: resolveEdgeNodeCertificateCapabilityBridgeId({ nodeId: 'node-1' }),
    });
    const bridge = getEdgeNodeCertificateCapabilityBridge('node:node-1');

    await initializer.handle();
    await expect(bridge.readCertificateStatus()).resolves.toMatchObject({
      supported: true,
      status: 'valid',
      expiresAt: '2026-10-31T00:00:00.000Z',
    });

    await bridge.renewCertificate();
    expect(certificateRuntimeMock.renewCertificate).toHaveBeenCalledTimes(1);

    initializer.stop();
    await expect(bridge.readCertificateStatus()).resolves.toEqual({
      supported: false,
      status: 'unsupported',
    });
  });
});
