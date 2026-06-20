import { describe, expect, it, vi } from 'vitest';
import { createP2PSignalingClient } from '../../../src/edge/reachability';

describe('P2P signaling client', () => {
  it('uses the reachability session API to create, read and update p2p candidates', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({
          kind: 'p2p',
          clientId: 'device-1',
          capabilities: ['udp-hole-punch'],
          candidates: [{ protocol: 'udp', host: '127.0.0.1', port: 41000 }],
        });
        return jsonResponse({
          sessionId: 'p2p_1',
          kind: 'p2p',
          nodeId: 'node-1',
          clientId: 'device-1',
          createdAt: '2026-06-20T00:00:00.000Z',
          expiresAt: '2026-06-20T00:05:00.000Z',
          nodeCandidates: [],
          signalingUrl: 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_1',
          capabilities: ['udp-hole-punch'],
          candidates: [],
        });
      }
      if (url.endsWith('/sessions') && init?.method === 'GET') {
        return jsonResponse({
          kind: 'p2p',
          sessions: [
            {
              sessionId: 'p2p_1',
              kind: 'p2p',
              nodeId: 'node-1',
              clientId: 'device-1',
              createdAt: '2026-06-20T00:00:00.000Z',
              expiresAt: '2026-06-20T00:05:00.000Z',
              nodeCandidates: [],
              signalingUrl: 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_1',
              capabilities: ['webrtc-datachannel'],
              candidates: [{ id: 'offer-1', role: 'client', sourceId: 'device-1', createdAt: '2026-06-20T00:00:00.000Z', url: 'webrtc://offer' }],
            },
          ],
        });
      }
      if (url.endsWith('/sessions/p2p_1') && init?.method === 'GET') {
        return jsonResponse({
          sessionId: 'p2p_1',
          kind: 'p2p',
          nodeId: 'node-1',
          clientId: 'device-1',
          createdAt: '2026-06-20T00:00:00.000Z',
          expiresAt: '2026-06-20T00:05:00.000Z',
          nodeCandidates: [],
          signalingUrl: 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_1',
          capabilities: ['udp-hole-punch'],
          candidates: [{ id: 'node-candidate', role: 'node', sourceId: 'node-1', createdAt: '2026-06-20T00:00:00.000Z', protocol: 'udp', host: '127.0.0.1', port: 41001 }],
        });
      }
      if (url.endsWith('/sessions/p2p_1/candidates') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({
          role: 'client',
          sourceId: 'device-1',
          candidates: [{ protocol: 'udp', host: '127.0.0.1', port: 41002 }],
        });
        return jsonResponse({
          sessionId: 'p2p_1',
          kind: 'p2p',
          nodeId: 'node-1',
          clientId: 'device-1',
          createdAt: '2026-06-20T00:00:00.000Z',
          expiresAt: '2026-06-20T00:05:00.000Z',
          nodeCandidates: [],
          signalingUrl: 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_1',
          capabilities: ['udp-hole-punch'],
          candidates: [],
        });
      }
      return new Response('not found', { status: 404 });
    });
    const client = createP2PSignalingClient({
      apiBaseUrl: 'https://api.example/',
      nodeId: 'node-1',
      token: 'service-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.createP2PSession({
      clientId: 'device-1',
      capabilities: ['udp-hole-punch'],
      candidates: [{ protocol: 'udp', host: '127.0.0.1', port: 41000 }],
    })).resolves.toMatchObject({ sessionId: 'p2p_1' });
    await expect(client.getP2PSession('p2p_1')).resolves.toMatchObject({
      candidates: [expect.objectContaining({ role: 'node', sourceId: 'node-1' })],
    });
    await expect(client.listP2PSessions()).resolves.toEqual([
      expect.objectContaining({
        sessionId: 'p2p_1',
        candidates: [expect.objectContaining({ id: 'offer-1', role: 'client' })],
      }),
    ]);
    await expect(client.addP2PCandidates('p2p_1', {
      role: 'client',
      sourceId: 'device-1',
      candidates: [{ protocol: 'udp', host: '127.0.0.1', port: 41002 }],
    })).resolves.toMatchObject({ sessionId: 'p2p_1' });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer service-token');
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    }
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
