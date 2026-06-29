import { describe, expect, it } from 'vitest';
import {
  createP2PRealnetAcceptancePlan,
  verifyP2PRealnetAcceptance,
} from '../../../src/edge/reachability/P2PRealnetAcceptance';

describe('P2P real-network acceptance helper', () => {
  it('generates paired node/client commands for an external non-browser P2P smoke', () => {
    const plan = createP2PRealnetAcceptancePlan({
      apiBaseUrl: 'https://id.undefineds.co/',
      nodeId: 'node-1',
      nodeToken: 'node-token',
      baseUrl: 'https://node-1.undefineds.co/',
      targetBaseUrl: 'http://127.0.0.1:3000/',
      clientId: 'phone-1',
      token: 'service-token',
      resourceUrl: 'https://node-1.undefineds.co/alice/a.txt',
      runTimeoutMs: 90_000,
      connectTimeoutMs: 4_000,
      waitTimeoutMs: 20_000,
      requestTimeoutMs: 5_000,
      numPorts: 2,
      basePort: 44_000,
      portRange: 20,
      winnerSelectionWindowMs: 50,
    });

    expect(plan.kind).toBe('raw-tcp-p2p-realnet-acceptance');
    expect(plan.node.command).toEqual([
      'node',
      '-r',
      'ts-node/register',
      'scripts/edge-node-p2p-accept-smoke.ts',
      '--signal-endpoint',
      'https://id.undefineds.co/v1/signal',
      '--node-id',
      'node-1',
      '--node-token',
      'node-token',
      '--base-url',
      'https://node-1.undefineds.co/',
      '--target-base-url',
      'http://127.0.0.1:3000/',
      '--connect-timeout-ms',
      '4000',
      '--winner-selection-window-ms',
      '50',
      '--run-timeout-ms',
      '90000',
      '--require-accept',
    ]);
    expect(plan.client.command).toEqual([
      'bun',
      'run',
      'smoke:p2p:managed',
      '--api-base-url',
      'https://id.undefineds.co/',
      '--node-id',
      'node-1',
      '--client-id',
      'phone-1',
      '--token',
      'service-token',
      '--resource-url',
      'https://node-1.undefineds.co/alice/a.txt',
      '--connect-timeout-ms',
      '4000',
      '--winner-selection-window-ms',
      '50',
      '--wait-timeout-ms',
      '20000',
      '--request-timeout-ms',
      '5000',
      '--num-ports',
      '2',
      '--base-port',
      '44000',
      '--port-range',
      '20',
      '--require-p2p',
    ]);
    expect(plan.mobile).toEqual({
      appLabel: 'LinX P2P Smoke',
      packageName: 'com.linxmobile.p2psmoke',
      fields: {
        idpUrl: 'https://id.undefineds.co/',
        storageUrl: 'https://node-1.undefineds.co/',
        clientId: 'phone-1',
        resourcePath: '/alice/a.txt',
      },
      description: expect.stringContaining('same clientId'),
    });
    expect(plan.mobile.fields).not.toHaveProperty('signalToken');
    expect(plan.routeFallbacksPreserved).toEqual([
      'Cloudflare Tunnel',
      'FRP/SakuraFRP',
    ]);
    expect(plan.successCriteria).toContain('node accepted at least one raw TCP P2P session for client phone-1');
    expect(plan.caveats.join('\n')).toContain('not prove browser P2P');
    expect(plan.caveats.join('\n')).toContain('signal injects the observed address');
    expect(plan.caveats.join('\n')).toContain('Mobile smoke evidence must still be verified with the same realnet verifier');
  });

  it('keeps mobile IDP separate when the signal API is on the api subdomain', () => {
    const plan = createP2PRealnetAcceptancePlan({
      apiBaseUrl: 'https://api.undefineds.co/',
      nodeId: 'node-1',
      nodeToken: 'node-token',
      baseUrl: 'https://node-1.undefineds.co/',
      targetBaseUrl: 'http://127.0.0.1:3000/',
      clientId: 'phone-1',
      resourceUrl: 'https://node-1.undefineds.co/alice/a.txt',
    });

    expect(plan.client.command).toContain('https://api.undefineds.co/');
    expect(plan.mobile.fields.idpUrl).toBe('https://id.undefineds.co/');
  });

  it('verifies matching node/client smoke JSON and requires preserved tunnel fallback evidence', () => {
    const verified = verifyP2PRealnetAcceptance({
      clientId: 'phone-1',
      expectedStatus: 200,
      nodeResult: {
        smokeOk: true,
        accepted: [
          {
            sessionId: 'p2p_realnet',
            clientId: 'phone-1',
            localCandidateCount: 1,
            remoteCandidateCount: 1,
            nodeAddress: 'signal-observed',
          },
        ],
        routeFallbacksPreserved: ['Cloudflare Tunnel', 'FRP/SakuraFRP'],
        caveats: ['Cloudflare Tunnel and FRP/SakuraFRP remain independent user-tunnel fallback routes.'],
      },
      clientResult: {
        smokeOk: true,
        route: { kind: 'p2p', id: 'p2p-raw-tcp' },
        status: 200,
        clientAddress: 'signal-observed',
        connectorEvents: [
          { type: 'attempt', localPort: 44000, remotePort: 44000 },
          { type: 'success', localPort: 44000, remotePort: 44000 },
        ],
      },
    });

    expect(verified.smokeOk).toBe(true);
    expect(verified.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'node accepted client', ok: true }),
      expect.objectContaining({ name: 'client selected p2p route', ok: true }),
      expect.objectContaining({ name: 'raw tcp connector succeeded', ok: true }),
      expect.objectContaining({ name: 'client address came from signal', ok: true }),
      expect.objectContaining({ name: 'node address came from signal', ok: true }),
      expect.objectContaining({ name: 'tunnel fallbacks preserved', ok: true }),
    ]));
  });

  it('fails verification when either peer used explicit address overrides instead of signal-observed enrichment', () => {
    const verified = verifyP2PRealnetAcceptance({
      clientId: 'phone-1',
      expectedStatus: 200,
      nodeResult: {
        smokeOk: true,
        accepted: [{ sessionId: 'p2p_realnet', clientId: 'phone-1', nodeAddress: 'explicit-host' }],
        routeFallbacksPreserved: ['Cloudflare Tunnel', 'FRP/SakuraFRP'],
      },
      clientResult: {
        smokeOk: true,
        route: { kind: 'p2p', id: 'p2p-raw-tcp' },
        status: 200,
        clientAddress: 'explicit-host',
        connectorEvents: [{ type: 'success', localPort: 44000, remotePort: 44000 }],
      },
    });

    expect(verified.smokeOk).toBe(false);
    expect(verified.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'client address came from signal',
        ok: false,
      }),
      expect.objectContaining({
        name: 'node address came from signal',
        ok: false,
      }),
    ]));
  });

  it('fails verification when mobile write status is missing or mismatched', () => {
    const verified = verifyP2PRealnetAcceptance({
      clientId: 'phone-1',
      expectedStatus: 200,
      requirePutStatus2xx: true,
      nodeResult: {
        smokeOk: true,
        accepted: [{ sessionId: 'p2p_realnet', clientId: 'phone-1', nodeAddress: 'signal-observed' }],
        routeFallbacksPreserved: ['Cloudflare Tunnel', 'FRP/SakuraFRP'],
      },
      clientResult: {
        smokeOk: true,
        route: { kind: 'p2p', id: 'p2p-raw-tcp' },
        putStatus: 403,
        status: 200,
        clientAddress: 'signal-observed',
        connectorEvents: [{ type: 'success', localPort: 44000, remotePort: 44000 }],
      },
    });

    expect(verified.smokeOk).toBe(false);
    expect(verified.checks).toContainEqual(expect.objectContaining({
      name: 'write http status is 2xx',
      ok: false,
    }));
  });

  it('fails verification when the client fell back to a non-P2P route', () => {
    const verified = verifyP2PRealnetAcceptance({
      clientId: 'phone-1',
      nodeResult: {
        smokeOk: true,
        accepted: [{ sessionId: 'p2p_realnet', clientId: 'phone-1', nodeAddress: 'signal-observed' }],
        routeFallbacksPreserved: ['Cloudflare Tunnel', 'FRP/SakuraFRP'],
      },
      clientResult: {
        smokeOk: true,
        route: { kind: 'user-tunnel', id: 'cloudflare' },
        status: 200,
        clientAddress: 'signal-observed',
        connectorEvents: [],
      },
    });

    expect(verified.smokeOk).toBe(false);
    expect(verified.checks).toContainEqual(expect.objectContaining({
      name: 'client selected p2p route',
      ok: false,
    }));
  });
});
