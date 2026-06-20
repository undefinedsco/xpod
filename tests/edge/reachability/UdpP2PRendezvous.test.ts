import { describe, expect, it, vi } from 'vitest';
import type { AccessRoute } from '../../../src/edge/reachability';
import {
  createP2PDataPlaneFetch,
  createP2PDataPlaneHandler,
  createUdpP2PDataPlaneServer,
  createUdpP2PDataPlaneTransport,
  createUdpP2PRendezvousPeer,
} from '../../../src/edge/reachability';

const p2pRoute: AccessRoute = {
  id: 'udp-rendezvous-session-1',
  nodeId: 'node-1',
  canonicalUrl: 'https://node-1.pods.example/',
  kind: 'p2p',
  targetUrl: 'udp://127.0.0.1:0',
  priority: 40,
  requiresManagedClient: true,
  visibility: 'authorized-client',
  health: 'healthy',
};

describe('UDP P2P rendezvous', () => {
  it('uses exchanged UDP candidates to establish a same-socket Solid HTTP data plane', async () => {
    const localFetch = vi.fn(async () => new Response('rendezvous response', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    const handler = createP2PDataPlaneHandler({
      targetBaseUrl: 'http://127.0.0.1:5737/',
      fetchImpl: localFetch as typeof fetch,
    });

    const nodePeer = createUdpP2PRendezvousPeer({
      sessionId: 'p2p-session-1',
      role: 'node',
      sourceId: 'node-1',
      host: '127.0.0.1',
      publicHost: '127.0.0.1',
    });
    const clientPeer = createUdpP2PRendezvousPeer({
      sessionId: 'p2p-session-1',
      role: 'client',
      sourceId: 'device-1',
      host: '127.0.0.1',
      publicHost: '127.0.0.1',
    });

    await nodePeer.listen(0);
    await clientPeer.listen(0);
    const nodeServer = createUdpP2PDataPlaneServer({
      handler,
      socket: nodePeer.socket(),
    });
    await nodeServer.listen();

    try {
      const [clientConnection, nodeConnection] = await Promise.all([
        clientPeer.connect([nodePeer.candidate()], { timeoutMs: 1_000, intervalMs: 10 }),
        nodePeer.connect([clientPeer.candidate()], { timeoutMs: 1_000, intervalMs: 10 }),
      ]);

      expect(clientConnection.remoteCandidate).toMatchObject({
        role: 'node',
        sourceId: 'node-1',
        protocol: 'udp',
        host: '127.0.0.1',
      });
      expect(nodeConnection.remoteCandidate).toMatchObject({
        role: 'client',
        sourceId: 'device-1',
        protocol: 'udp',
        host: '127.0.0.1',
      });

      const transport = createUdpP2PDataPlaneTransport({
        socket: clientPeer.socket(),
        remoteHost: clientConnection.remoteHost,
        remotePort: clientConnection.remotePort,
        timeoutMs: 1_000,
      });
      const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport });
      const response = await fetchViaP2P('https://node-1.pods.example/alice/rendezvous.txt', {
        method: 'PUT',
        headers: { authorization: 'DPoP token', 'content-type': 'text/plain' },
        body: 'rendezvous body',
      });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('rendezvous response');
      expect(localFetch).toHaveBeenCalledTimes(1);
      const [targetUrl, init] = localFetch.mock.calls[0];
      expect(targetUrl).toBe('http://127.0.0.1:5737/alice/rendezvous.txt');
      expect(new Headers(init.headers).get('x-xpod-canonical-url')).toBe('https://node-1.pods.example/alice/rendezvous.txt');
      transport.close();
    } finally {
      await nodeServer.close();
      await clientPeer.close();
      await nodePeer.close();
    }
  });
});
