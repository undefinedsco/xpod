import { describe, expect, it, vi } from 'vitest';
import type { AccessRoute } from '../../../src/edge/reachability';
import {
  createP2PDataPlaneFetch,
  createP2PDataPlaneHandler,
  createWeriftDataChannelPair,
  createWeriftDataChannelP2PServer,
  createWeriftDataChannelP2PTransport,
} from '../../../src/edge/reachability';

const p2pRoute: AccessRoute = {
  id: 'werift-p2p-session-1',
  nodeId: 'node-1',
  canonicalUrl: 'https://node-1.pods.example/',
  kind: 'p2p',
  targetUrl: 'webrtc://signaling-session/p2p_1',
  priority: 40,
  requiresManagedClient: true,
  visibility: 'authorized-client',
  health: 'healthy',
};

describe('werift DataChannel P2P data plane transport', () => {
  it('carries canonical Solid HTTP frames over a non-browser reliable DataChannel', async () => {
    const requestBody = 'node-datachannel-request-'.repeat(300);
    const responseBody = 'node-datachannel-response-'.repeat(350);
    const pair = await createWeriftDataChannelPair({
      label: 'xpod-p2p-http',
      openTimeoutMs: 3_000,
      peerConfig: {
        iceServers: [],
        iceAdditionalHostAddresses: ['127.0.0.1'],
      },
    });
    const localFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      await expect(new Response(init?.body).text()).resolves.toBe(requestBody);
      return new Response(responseBody, {
        status: 208,
        statusText: 'Already Reported',
        headers: { 'content-type': 'text/plain', etag: '"werift"' },
      });
    });
    const server = createWeriftDataChannelP2PServer({
      channel: pair.nodeChannel,
      handler: createP2PDataPlaneHandler({
        targetBaseUrl: 'http://127.0.0.1:5737/',
        fetchImpl: localFetch as typeof fetch,
      }),
    });
    const transport = createWeriftDataChannelP2PTransport({
      channel: pair.clientChannel,
      timeoutMs: 2_000,
      randomId: () => 'werift-request',
    });

    try {
      const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport });
      const response = await fetchViaP2P('https://node-1.pods.example/alice/datachannel.txt?via=werift', {
        method: 'PUT',
        headers: { authorization: 'DPoP token', 'content-type': 'text/plain' },
        body: requestBody,
      });

      expect(response.status).toBe(208);
      expect(response.statusText).toBe('Already Reported');
      expect(response.headers.get('etag')).toBe('"werift"');
      await expect(response.text()).resolves.toBe(responseBody);
      expect(localFetch).toHaveBeenCalledTimes(1);
      const [targetUrl, init] = localFetch.mock.calls[0];
      expect(targetUrl).toBe('http://127.0.0.1:5737/alice/datachannel.txt?via=werift');
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe('DPoP token');
      expect(headers.get('x-xpod-canonical-url')).toBe('https://node-1.pods.example/alice/datachannel.txt?via=werift');
    } finally {
      transport.close();
      server.close();
      await pair.close();
    }
  });
});
