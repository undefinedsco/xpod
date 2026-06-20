import { describe, expect, it, vi } from 'vitest';
import type { AccessRoute, P2PHttpRequestFrame, P2PHttpResponseFrame } from '../../../src/edge/reachability';
import { createP2PDataPlaneFetch, createP2PDataPlaneHandler } from '../../../src/edge/reachability';

const p2pRoute: AccessRoute = {
  id: 'p2p-session-1',
  nodeId: 'node-1',
  canonicalUrl: 'https://node-1.pods.example/',
  kind: 'p2p',
  targetUrl: 'p2p://node-1/session-1',
  priority: 40,
  requiresManagedClient: true,
  visibility: 'authorized-client',
  health: 'healthy',
};

describe('P2P data plane HTTP framing', () => {
  it('sends canonical SP requests through the injected P2P transport instead of fetching the route target URL', async () => {
    const sentFrames: P2PHttpRequestFrame[] = [];
    const transport = {
      request: vi.fn(async (frame: P2PHttpRequestFrame): Promise<P2PHttpResponseFrame> => {
        sentFrames.push(frame);
        return {
          protocol: 'xpod-p2p-http/1',
          status: 201,
          statusText: 'Created',
          headers: [['content-type', 'text/plain'], ['etag', '"p2p"']],
          bodyBase64: Buffer.from('created over p2p').toString('base64'),
        };
      }),
    };
    const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport });

    const response = await fetchViaP2P('https://node-1.pods.example/alice/a.txt?version=1', {
      method: 'PUT',
      headers: {
        authorization: 'DPoP token',
        'content-type': 'text/plain',
      },
      body: 'hello from native client',
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('etag')).toBe('"p2p"');
    await expect(response.text()).resolves.toBe('created over p2p');
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(sentFrames[0]).toMatchObject({
      protocol: 'xpod-p2p-http/1',
      method: 'PUT',
      url: 'https://node-1.pods.example/alice/a.txt?version=1',
      bodyBase64: Buffer.from('hello from native client').toString('base64'),
    });
    expect(new Headers(sentFrames[0].headers).get('authorization')).toBe('DPoP token');
    expect(new Headers(sentFrames[0].headers).get('content-type')).toBe('text/plain');
  });

  it('handles P2P HTTP frames on the node side by forwarding to the local target while preserving canonical headers', async () => {
    const localFetch = vi.fn(async () => new Response('local css response', {
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'text/plain',
        etag: '"local"',
      },
    }));
    const handler = createP2PDataPlaneHandler({
      targetBaseUrl: 'http://127.0.0.1:5737/',
      fetchImpl: localFetch as typeof fetch,
    });

    const frame = await handler.handleRequest({
      protocol: 'xpod-p2p-http/1',
      method: 'GET',
      url: 'https://node-1.pods.example/alice/a.txt?version=2',
      headers: [['authorization', 'DPoP token']],
    });

    expect(localFetch).toHaveBeenCalledTimes(1);
    const [targetUrl, init] = localFetch.mock.calls[0];
    expect(targetUrl).toBe('http://127.0.0.1:5737/alice/a.txt?version=2');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('DPoP token');
    expect(headers.get('x-xpod-canonical-url')).toBe('https://node-1.pods.example/alice/a.txt?version=2');
    expect(headers.get('x-xpod-canonical-origin')).toBe('https://node-1.pods.example');
    expect(headers.get('x-xpod-canonical-host')).toBe('node-1.pods.example');
    expect(frame).toMatchObject({
      protocol: 'xpod-p2p-http/1',
      status: 200,
      statusText: 'OK',
      bodyBase64: Buffer.from('local css response').toString('base64'),
    });
    expect(new Headers(frame.headers).get('etag')).toBe('"local"');
  });

  it('round-trips a canonical fetch over an in-process P2P transport boundary', async () => {
    const localFetch = vi.fn(async () => new Response('pong from local node', { status: 202 }));
    const nodeHandler = createP2PDataPlaneHandler({
      targetBaseUrl: 'http://127.0.0.1:5737/',
      fetchImpl: localFetch as typeof fetch,
    });
    const transport = {
      request: (frame: P2PHttpRequestFrame) => nodeHandler.handleRequest(frame),
    };
    const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport });

    const response = await fetchViaP2P('https://node-1.pods.example/alice/ping.txt');

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe('pong from local node');
    expect(localFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:5737/alice/ping.txt',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
