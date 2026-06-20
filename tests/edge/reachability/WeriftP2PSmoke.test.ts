import { describe, expect, it, vi } from 'vitest';
import {
  parseWeriftP2PSmokeArgs,
  runWeriftP2PSmoke,
  type WeriftP2PSmokeCreateClient,
} from '../../../src/edge/reachability/WeriftP2PSmoke';

describe('werift P2P smoke CLI helpers', () => {
  it('parses canonical Solid HTTP request options from CLI flags and env', () => {
    const options = parseWeriftP2PSmokeArgs([
      '--method', 'PUT',
      '--header', 'authorization: DPoP access-token',
      '--header', 'content-type: text/plain',
      '--body', 'hello through p2p',
      '--expect-status', '201',
      '--timeout-ms', '9000',
      '--poll-interval-ms', '25',
      '--transport-timeout-ms', '3000',
      '--ice-servers', '[{"urls":"stun:stun.example:3478"}]',
    ], {
      XPOD_P2P_API_BASE_URL: 'https://id.undefineds.co/',
      XPOD_P2P_NODE_ID: 'node-0000',
      XPOD_P2P_TOKEN: 'managed-token',
      XPOD_P2P_SOURCE_ID: 'desktop-1',
      XPOD_P2P_URL: 'https://node-0000.undefineds.co/alice/a.txt',
    });

    expect(options).toMatchObject({
      apiBaseUrl: 'https://id.undefineds.co/',
      nodeId: 'node-0000',
      token: 'managed-token',
      sourceId: 'desktop-1',
      url: 'https://node-0000.undefineds.co/alice/a.txt',
      method: 'PUT',
      body: 'hello through p2p',
      expectStatus: 201,
      timeoutMs: 9000,
      pollIntervalMs: 25,
      transportTimeoutMs: 3000,
    });
    expect(options.headers).toEqual([
      ['authorization', 'DPoP access-token'],
      ['content-type', 'text/plain'],
    ]);
    expect(options.peerConfig?.iceServers).toEqual([{ urls: 'stun:stun.example:3478' }]);
  });

  it('parses optional Solid client credentials for private Pod smoke requests', () => {
    const options = parseWeriftP2PSmokeArgs([], {
      XPOD_P2P_API_BASE_URL: 'https://id.undefineds.co/',
      XPOD_P2P_NODE_ID: 'node-0000',
      XPOD_P2P_SOURCE_ID: 'desktop-1',
      XPOD_P2P_URL: 'https://node-0000.undefineds.co/alice/private.txt',
      XPOD_P2P_SOLID_OIDC_ISSUER: 'https://id.undefineds.co/',
      XPOD_P2P_SOLID_CLIENT_ID: 'solid-client-id',
      XPOD_P2P_SOLID_CLIENT_SECRET: 'solid-client-secret',
      XPOD_P2P_SOLID_TOKEN_TYPE: 'DPoP',
    });

    expect(options.solidAuth).toEqual({
      oidcIssuer: 'https://id.undefineds.co/',
      clientId: 'solid-client-id',
      clientSecret: 'solid-client-secret',
      tokenType: 'DPoP',
    });
  });

  it('parses relay-only ICE transport policy for TURN fallback verification', () => {
    const fromEnv = parseWeriftP2PSmokeArgs([], {
      XPOD_P2P_API_BASE_URL: 'https://id.undefineds.co/',
      XPOD_P2P_NODE_ID: 'node-0000',
      XPOD_P2P_SOURCE_ID: 'desktop-1',
      XPOD_P2P_URL: 'https://node-0000.undefineds.co/alice/private.txt',
      XPOD_P2P_ICE_TRANSPORT_POLICY: 'relay',
    });
    const fromFlag = parseWeriftP2PSmokeArgs([
      '--ice-transport-policy', 'relay',
    ], {
      XPOD_P2P_API_BASE_URL: 'https://id.undefineds.co/',
      XPOD_P2P_NODE_ID: 'node-0000',
      XPOD_P2P_SOURCE_ID: 'desktop-1',
      XPOD_P2P_URL: 'https://node-0000.undefineds.co/alice/private.txt',
    });

    expect(fromEnv.peerConfig?.iceTransportPolicy).toBe('relay');
    expect(fromFlag.peerConfig?.iceTransportPolicy).toBe('relay');
  });

  it('creates a non-browser werift P2P client and fetches the canonical Solid URL as HTTP', async () => {
    const close = vi.fn(async () => undefined);
    const p2pFetch = vi.fn(async () => new Response('created through p2p', {
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'text/plain' },
    }));
    const createClient = vi.fn<WeriftP2PSmokeCreateClient>(async () => ({
      session: { sessionId: 'p2p_live' } as any,
      route: {
        id: 'p2p-werift-datachannel',
        nodeId: 'node-0000',
        canonicalUrl: 'https://node-0000.undefineds.co/',
        kind: 'p2p',
        targetUrl: 'webrtc://signaling/node-0000',
        priority: 10,
        requiresManagedClient: true,
        visibility: 'authorized-client',
        health: 'unknown',
      },
      fetch: p2pFetch,
      close,
    }));

    const result = await runWeriftP2PSmoke({
      apiBaseUrl: 'https://id.undefineds.co/',
      nodeId: 'node-0000',
      token: 'managed-token',
      sourceId: 'desktop-1',
      url: 'https://node-0000.undefineds.co/alice/a.txt',
      method: 'PUT',
      headers: [['authorization', 'DPoP access-token']],
      body: 'hello through p2p',
      expectStatus: 201,
      timeoutMs: 9000,
      pollIntervalMs: 25,
      transportTimeoutMs: 3000,
    }, { createClient });

    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      apiBaseUrl: 'https://id.undefineds.co/',
      nodeId: 'node-0000',
      token: 'managed-token',
      sourceId: 'desktop-1',
      capabilities: ['webrtc-datachannel'],
      timeoutMs: 9000,
      pollIntervalMs: 25,
      transportTimeoutMs: 3000,
    }));
    expect(p2pFetch).toHaveBeenCalledWith('https://node-0000.undefineds.co/alice/a.txt', {
      method: 'PUT',
      headers: [['authorization', 'DPoP access-token']],
      body: 'hello through p2p',
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      sessionId: 'p2p_live',
      routeKind: 'p2p',
      routeTargetUrl: 'webrtc://signaling/node-0000',
      status: 201,
      statusText: 'Created',
      bodyText: 'created through p2p',
    });
  });

  it('wraps the P2P fetch with Solid client-credentials authentication when configured', async () => {
    const closeClient = vi.fn(async () => undefined);
    const closeAuth = vi.fn(async () => undefined);
    const p2pFetch = vi.fn(async () => new Response('raw p2p should be auth-wrapped', { status: 599 }));
    const authenticatedFetch = vi.fn(async () => new Response('private over authenticated p2p', { status: 200 }));
    const createAuthenticatedFetch = vi.fn(async () => ({
      fetch: authenticatedFetch as typeof fetch,
      webId: 'https://id.undefineds.co/alice/profile/card#me',
      close: closeAuth,
    }));
    const createClient = vi.fn<WeriftP2PSmokeCreateClient>(async () => ({
      session: { sessionId: 'p2p_private' } as any,
      route: {
        id: 'p2p-werift-datachannel',
        nodeId: 'node-0000',
        canonicalUrl: 'https://node-0000.undefineds.co/',
        kind: 'p2p',
        targetUrl: 'webrtc://signaling/node-0000',
        priority: 10,
        requiresManagedClient: true,
        visibility: 'authorized-client',
        health: 'unknown',
      },
      fetch: p2pFetch,
      close: closeClient,
    }));

    const result = await runWeriftP2PSmoke({
      apiBaseUrl: 'https://id.undefineds.co/',
      nodeId: 'node-0000',
      sourceId: 'desktop-1',
      url: 'https://node-0000.undefineds.co/alice/private.txt',
      method: 'GET',
      solidAuth: {
        oidcIssuer: 'https://id.undefineds.co/',
        clientId: 'solid-client-id',
        clientSecret: 'solid-client-secret',
        tokenType: 'DPoP',
      },
      expectStatus: 200,
    }, { createClient, createAuthenticatedFetch });

    expect(createAuthenticatedFetch).toHaveBeenCalledWith({
      oidcIssuer: 'https://id.undefineds.co/',
      clientId: 'solid-client-id',
      clientSecret: 'solid-client-secret',
      tokenType: 'DPoP',
      fetchImpl: p2pFetch,
    });
    expect(authenticatedFetch).toHaveBeenCalledWith('https://node-0000.undefineds.co/alice/private.txt', {
      method: 'GET',
      headers: [],
      body: undefined,
    });
    expect(p2pFetch).not.toHaveBeenCalled();
    expect(closeAuth).toHaveBeenCalledTimes(1);
    expect(closeClient).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      sessionId: 'p2p_private',
      authWebId: 'https://id.undefineds.co/alice/profile/card#me',
      status: 200,
      bodyText: 'private over authenticated p2p',
    });
  });

  it('fails the smoke when the P2P HTTP response status does not match the expectation', async () => {
    const close = vi.fn(async () => undefined);
    const createClient = vi.fn<WeriftP2PSmokeCreateClient>(async () => ({
      session: { sessionId: 'p2p_live' } as any,
      route: {
        id: 'p2p-werift-datachannel',
        nodeId: 'node-0000',
        canonicalUrl: 'https://node-0000.undefineds.co/',
        kind: 'p2p',
        targetUrl: 'webrtc://signaling/node-0000',
        priority: 10,
        requiresManagedClient: true,
        visibility: 'authorized-client',
        health: 'unknown',
      },
      fetch: vi.fn(async () => new Response('unauthorized', { status: 401 })),
      close,
    }));

    await expect(runWeriftP2PSmoke({
      apiBaseUrl: 'https://id.undefineds.co/',
      nodeId: 'node-0000',
      sourceId: 'desktop-1',
      url: 'https://node-0000.undefineds.co/alice/a.txt',
      expectStatus: 200,
    }, { createClient })).rejects.toThrow('Expected P2P HTTP status 200, got 401');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
