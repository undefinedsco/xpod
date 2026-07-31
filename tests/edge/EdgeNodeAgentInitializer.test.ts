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
const certificateRuntimeQueue = vi.hoisted(() => [] as Array<typeof certificateRuntimeMock>);

vi.mock('../../src/edge/EdgeNodeAgent', () => ({
  EdgeNodeAgent: vi.fn(() => {
    const runtime = certificateRuntimeQueue.shift() ?? certificateRuntimeMock;
    return {
      start: startMock,
      stop: stopMock,
      getCertificateRuntime: vi.fn(() => runtime),
    };
  }),
}));

import { EdgeNodeAgentInitializer } from '../../src/edge/EdgeNodeAgentInitializer';
import {
  getEdgeNodeCertificateCapabilityBridge,
  hasEdgeNodeCertificateCapabilityBridge,
  resolveEdgeNodeCertificateCapabilityBridgeId,
} from '../../src/edge/EdgeNodeCertificateCapabilityBridge';

describe('EdgeNodeAgentInitializer', () => {
  beforeEach(() => {
    startMock.mockClear();
    stopMock.mockClear();
    certificateRuntimeQueue.length = 0;
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

  it('does not let an old initializer stop clear a newer source for the same bridge id', async () => {
    const oldRuntime = {
      readCertificateStatus: vi.fn(async () => ({ status: 'renewal_due', expiresAt: '2026-09-01T00:00:00.000Z' })),
      renewCertificate: vi.fn(async () => undefined),
    };
    const newRuntime = {
      readCertificateStatus: vi.fn(async () => ({ status: 'valid', expiresAt: '2026-12-01T00:00:00.000Z' })),
      renewCertificate: vi.fn(async () => undefined),
    };
    certificateRuntimeQueue.push(oldRuntime, newRuntime);
    const bridgeId = resolveEdgeNodeCertificateCapabilityBridgeId({ nodeId: 'node-1' });
    const oldInitializer = new EdgeNodeAgentInitializer({
      enabled: true,
      signalEndpoint: 'https://cluster.example/api/signal',
      nodeId: 'node-1',
      nodeToken: 'old-token',
      certificateBridgeId: bridgeId,
    });
    const newInitializer = new EdgeNodeAgentInitializer({
      enabled: true,
      signalEndpoint: 'https://cluster.example/api/signal',
      nodeId: 'node-1',
      nodeToken: 'new-token',
      certificateBridgeId: bridgeId,
    });
    const bridge = getEdgeNodeCertificateCapabilityBridge('node:node-1');

    await oldInitializer.handle();
    await newInitializer.handle();
    await expect(bridge.readCertificateStatus()).resolves.toMatchObject({
      status: 'valid',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });

    oldInitializer.stop();
    await expect(bridge.readCertificateStatus()).resolves.toMatchObject({
      status: 'valid',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });

    newInitializer.stop();
    await expect(bridge.readCertificateStatus()).resolves.toEqual({
      supported: false,
      status: 'unsupported',
    });
  });

  it('removes an idle bridge from the global map after its source and consumer leases are released', async () => {
    const id = 'node:cleanup';
    expect(hasEdgeNodeCertificateCapabilityBridge(id)).toBe(false);
    const bridge = getEdgeNodeCertificateCapabilityBridge(id);
    const releaseConsumer = bridge.retain();
    const releaseSource = bridge.setSource(() => certificateRuntimeMock);

    expect(hasEdgeNodeCertificateCapabilityBridge(id)).toBe(true);
    releaseSource();
    expect(hasEdgeNodeCertificateCapabilityBridge(id)).toBe(true);

    releaseConsumer();
    expect(hasEdgeNodeCertificateCapabilityBridge(id)).toBe(false);
  });
});
