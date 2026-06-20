import { describe, expect, it, vi } from 'vitest';
import type { AccessRoute } from '../../../src/edge/reachability';
import {
  createP2PDataPlaneFetch,
  createP2PDataPlaneHandler,
  createUdpP2PDataPlaneServer,
  createUdpP2PDataPlaneTransport,
} from '../../../src/edge/reachability';

const p2pRoute: AccessRoute = {
  id: 'udp-p2p-session-1',
  nodeId: 'node-1',
  canonicalUrl: 'https://node-1.pods.example/',
  kind: 'p2p',
  targetUrl: 'udp://127.0.0.1:0',
  priority: 40,
  requiresManagedClient: true,
  visibility: 'authorized-client',
  health: 'healthy',
};

describe('UDP P2P data plane transport', () => {
  it('carries a canonical Solid HTTP request over real UDP sockets to a local node handler', async () => {
    const localFetch = vi.fn(async () => new Response('udp p2p response', {
      status: 206,
      statusText: 'Partial Content',
      headers: { 'content-type': 'text/plain' },
    }));
    const handler = createP2PDataPlaneHandler({
      targetBaseUrl: 'http://127.0.0.1:5737/',
      fetchImpl: localFetch as typeof fetch,
    });
    const server = createUdpP2PDataPlaneServer({ handler, host: '127.0.0.1' });
    await server.listen(0);
    const address = server.address();
    const transport = createUdpP2PDataPlaneTransport({
      remoteHost: address.address,
      remotePort: address.port,
      timeoutMs: 1_000,
    });

    try {
      const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport });
      const response = await fetchViaP2P('https://node-1.pods.example/alice/udp.txt?via=p2p', {
        method: 'PUT',
        headers: { 'content-type': 'text/plain', authorization: 'DPoP token' },
        body: 'udp body',
      });

      expect(response.status).toBe(206);
      expect(response.statusText).toBe('Partial Content');
      await expect(response.text()).resolves.toBe('udp p2p response');
      expect(localFetch).toHaveBeenCalledTimes(1);
      const [targetUrl, init] = localFetch.mock.calls[0];
      expect(targetUrl).toBe('http://127.0.0.1:5737/alice/udp.txt?via=p2p');
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe('DPoP token');
      expect(headers.get('x-xpod-canonical-url')).toBe('https://node-1.pods.example/alice/udp.txt?via=p2p');
    } finally {
      transport.close();
      await server.close();
    }
  });

  it('fragments and reassembles Solid HTTP frames that exceed the UDP datagram limit', async () => {
    const requestBody = 'request-fragment-'.repeat(500);
    const responseBody = 'response-fragment-'.repeat(600);
    const localFetch = vi.fn(async (url, init) => {
      await expect(new Response(init?.body).text()).resolves.toBe(requestBody);
      return new Response(responseBody, {
        status: 207,
        statusText: 'Multi-Status',
        headers: { 'content-type': 'text/plain' },
      });
    });
    const handler = createP2PDataPlaneHandler({
      targetBaseUrl: 'http://127.0.0.1:5737/',
      fetchImpl: localFetch as typeof fetch,
    });
    const server = createUdpP2PDataPlaneServer({
      handler,
      host: '127.0.0.1',
      maxDatagramBytes: 700,
    });
    await server.listen(0);
    const address = server.address();
    const transport = createUdpP2PDataPlaneTransport({
      remoteHost: address.address,
      remotePort: address.port,
      timeoutMs: 1_000,
      maxDatagramBytes: 700,
      randomId: () => 'fragmented',
    });

    try {
      const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport });
      const response = await fetchViaP2P('https://node-1.pods.example/alice/large.txt', {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: requestBody,
      });

      expect(response.status).toBe(207);
      expect(response.statusText).toBe('Multi-Status');
      await expect(response.text()).resolves.toBe(responseBody);
      expect(localFetch).toHaveBeenCalledTimes(1);
    } finally {
      transport.close();
      await server.close();
    }
  });

});
