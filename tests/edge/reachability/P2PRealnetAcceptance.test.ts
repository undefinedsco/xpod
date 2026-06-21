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
      nodeHost: '198.51.100.10',
      clientHost: '203.0.113.20',
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
      'bun',
      'run',
      'smoke:p2p:node-accept',
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
      '--host',
      '198.51.100.10',
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
      '--host',
      '203.0.113.20',
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
    expect(plan.routeFallbacksPreserved).toEqual([
      'Cloudflare Tunnel',
      'FRP/SakuraFRP',
    ]);
    expect(plan.successCriteria).toContain('node accepted at least one raw TCP P2P session for client phone-1');
    expect(plan.caveats.join('\n')).toContain('not prove browser P2P');
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
          },
        ],
        routeFallbacksPreserved: ['Cloudflare Tunnel', 'FRP/SakuraFRP'],
        caveats: ['Cloudflare Tunnel and FRP/SakuraFRP remain independent user-tunnel fallback routes.'],
      },
      clientResult: {
        smokeOk: true,
        route: { kind: 'p2p', id: 'p2p-raw-tcp' },
        status: 200,
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
      expect.objectContaining({ name: 'tunnel fallbacks preserved', ok: true }),
    ]));
  });

  it('fails verification when the client fell back to a non-P2P route', () => {
    const verified = verifyP2PRealnetAcceptance({
      clientId: 'phone-1',
      nodeResult: {
        smokeOk: true,
        accepted: [{ sessionId: 'p2p_realnet', clientId: 'phone-1' }],
        routeFallbacksPreserved: ['Cloudflare Tunnel', 'FRP/SakuraFRP'],
      },
      clientResult: {
        smokeOk: true,
        route: { kind: 'user-tunnel', id: 'cloudflare' },
        status: 200,
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
