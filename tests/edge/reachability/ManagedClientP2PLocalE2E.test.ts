import { describe, expect, it } from 'vitest';
import { runLocalManagedClientP2PE2ESmoke } from '../../../src/test-utils/local-managed-client-p2p-e2e-smoke';

describe('managed-client P2P local E2E smoke', () => {
  it('runs route discovery, session exchange, node accept loop, and canonical fetch through local P2P signaling', async () => {
    const result = await runLocalManagedClientP2PE2ESmoke({
      nodeName: 'local-p2p-node',
      clientId: 'managed-client-1',
      baseStorageDomain: 'pods.example',
      resourcePath: '/alice/local-p2p-e2e.txt?version=1',
      targetBody: 'local p2p e2e response',
      p2pHost: '127.0.0.1',
      routeWaitTimeoutMs: 2_000,
      pollIntervalMs: 10,
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
    });

    expect(result.smoke.ok).toBe(true);
    expect(result.smoke.route).toEqual(expect.objectContaining({
      kind: 'p2p',
      requiresManagedClient: true,
    }));
    expect(result.smoke.status).toBe(200);
    expect(result.smoke.body).toBe('local p2p e2e response');
    expect(result.p2pAttempts.client).toEqual([
      expect.objectContaining({
        local: expect.objectContaining({ sourceId: 'managed-client-1', port: result.plan.ports[0] }),
        remote: expect.objectContaining({ sourceId: result.nodeId, port: result.plan.ports[0] }),
      }),
    ]);
    expect(result.p2pAttempts.node).toEqual([
      expect.objectContaining({
        local: expect.objectContaining({ sourceId: result.nodeId, port: result.plan.ports[0] }),
        remote: expect.objectContaining({ sourceId: 'managed-client-1', port: result.plan.ports[0] }),
      }),
    ]);
    expect(result.targetRequests).toEqual([
      expect.objectContaining({
        url: '/alice/local-p2p-e2e.txt?version=1',
        headers: expect.objectContaining({
          'x-xpod-canonical-url': result.resourceUrl,
          'x-xpod-canonical-origin': new URL(result.resourceUrl).origin,
          'x-xpod-canonical-host': new URL(result.resourceUrl).host,
        }),
      }),
    ]);
  }, 15_000);

  it('can run through real local TCP sockets without socket injection', async () => {
    const result = await runLocalManagedClientP2PE2ESmoke({
      nodeName: 'local-p2p-node-real-tcp',
      clientId: 'managed-client-real-tcp',
      baseStorageDomain: 'pods.example',
      resourcePath: '/alice/local-p2p-real-tcp.txt?version=1',
      targetBody: 'local real tcp p2p response',
      p2pHost: '127.0.0.1',
      socketMode: 'real-tcp-listener',
      routeWaitTimeoutMs: 5_000,
      pollIntervalMs: 10,
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
    });

    expect(result.smokeOk).toBe(true);
    expect(result.evidence.dataPlane).toBe('real-local-tcp-listener');
    expect(result.connectorEvents.client.map((event) => event.type)).toEqual(
      expect.arrayContaining(['attempt', 'success']),
    );
    expect(result.connectorEvents.node).toEqual([]);
    expect(result.p2pAttempts.client).toEqual([
      expect.objectContaining({
        local: expect.objectContaining({
          sourceId: 'managed-client-real-tcp',
          port: result.clientPlan.ports[0],
        }),
        remote: expect.objectContaining({
          sourceId: result.nodeId,
          port: result.nodePlan.ports[0],
        }),
      }),
    ]);
    expect(result.clientPlan.ports[0]).not.toBe(result.nodePlan.ports[0]);
    expect(result.p2pAttempts.node).toEqual([]);
    expect(result.targetRequests).toEqual([
      expect.objectContaining({
        url: '/alice/local-p2p-real-tcp.txt?version=1',
      }),
    ]);
    expect(result.smoke.body).toBe('local real tcp p2p response');
  }, 15_000);


  it('uses signal-observed address for port-only managed client candidates', async () => {
    const result = await runLocalManagedClientP2PE2ESmoke({
      nodeName: 'local-p2p-node-observed-client',
      clientId: 'managed-client-observed',
      baseStorageDomain: 'pods.example',
      resourcePath: '/alice/local-p2p-observed-client.txt?version=1',
      targetBody: 'local observed client address response',
      p2pHost: '127.0.0.1',
      advertiseClientHost: false,
      socketMode: 'real-tcp-listener',
      routeWaitTimeoutMs: 5_000,
      pollIntervalMs: 10,
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
    });

    expect(result.smokeOk).toBe(true);
    expect(result.evidence.clientAddress).toBe('signal-observed');
    expect(result.p2pAttempts.client).toEqual([
      expect.objectContaining({
        local: expect.objectContaining({
          sourceId: 'managed-client-observed',
          address: '127.0.0.1',
          port: result.clientPlan.ports[0],
        }),
      }),
    ]);
    expect(result.p2pAttempts.client[0].local.host).toBeUndefined();
    expect(result.p2pAttempts.client[0].local.url).toBeUndefined();
    expect(result.smoke.body).toBe('local observed client address response');
  }, 15_000);

  it('uses signal-observed addresses for both managed client and node candidates', async () => {
    const result = await runLocalManagedClientP2PE2ESmoke({
      nodeName: 'local-p2p-node-observed-peers',
      clientId: 'managed-client-observed-peers',
      baseStorageDomain: 'pods.example',
      resourcePath: '/alice/local-p2p-observed-peers.txt?version=1',
      targetBody: 'local observed peer addresses response',
      p2pHost: '127.0.0.1',
      advertiseClientHost: false,
      advertiseNodeHost: false,
      socketMode: 'real-tcp-listener',
      routeWaitTimeoutMs: 5_000,
      pollIntervalMs: 10,
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
    });

    expect(result.smokeOk).toBe(true);
    expect(result.evidence.clientAddress).toBe('signal-observed');
    expect(result.evidence.nodeAddress).toBe('signal-observed');
    expect(result.p2pAttempts.client).toEqual([
      expect.objectContaining({
        local: expect.objectContaining({
          sourceId: 'managed-client-observed-peers',
          address: '127.0.0.1',
          port: result.clientPlan.ports[0],
        }),
        remote: expect.objectContaining({
          sourceId: result.nodeId,
          address: '127.0.0.1',
          port: result.nodePlan.ports[0],
        }),
      }),
    ]);
    expect(result.p2pAttempts.client[0].local.host).toBeUndefined();
    expect(result.p2pAttempts.client[0].local.url).toBeUndefined();
    expect(result.p2pAttempts.client[0].remote.host).toBeUndefined();
    expect(result.p2pAttempts.client[0].remote.url).toBeUndefined();
    expect(result.smoke.body).toBe('local observed peer addresses response');
  }, 15_000);

});
