import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../..');

describe('P2P real-network acceptance script', () => {
  it('prints paired node/client commands and fallback preservation caveats', async () => {
    const { stdout } = await execFileAsync('bun', [
      'scripts/p2p-realnet-acceptance.ts',
      'plan',
      '--api-base-url',
      'https://id.undefineds.co/',
      '--node-id',
      'node-1',
      '--node-token',
      'node-token',
      '--base-url',
      'https://node-1.undefineds.co/',
      '--target-base-url',
      'http://127.0.0.1:3000/',
      '--node-host',
      '198.51.100.10',
      '--client-host',
      '203.0.113.20',
      '--client-id',
      'phone-1',
      '--token',
      'service-token',
      '--resource-url',
      'https://node-1.undefineds.co/alice/a.txt',
      '--run-timeout-ms',
      '90000',
      '--connect-timeout-ms',
      '4000',
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
      '--winner-selection-window-ms',
      '50',
    ], { cwd: root, timeout: 8_000 });

    const result = JSON.parse(stdout) as {
      kind: string;
      node: { command: string[]; shell: string };
      client: { command: string[]; shell: string };
      routeFallbacksPreserved: string[];
    };
    expect(result.kind).toBe('raw-tcp-p2p-realnet-acceptance');
    expect(result.node.shell).toContain('smoke:p2p:node-accept');
    expect(result.client.shell).toContain('smoke:p2p:managed');
    expect(result.node.command).toContain('--require-accept');
    expect(result.client.command).toContain('--require-p2p');
    expect(result.routeFallbacksPreserved).toEqual(expect.arrayContaining([
      'Cloudflare Tunnel',
      'FRP/SakuraFRP',
    ]));
  });

  it('verifies saved node/client JSON outputs as one acceptance result', async () => {
    const { stdout } = await execFileAsync('bun', [
      'scripts/p2p-realnet-acceptance.ts',
      'verify',
      '--client-id',
      'phone-1',
      '--node-result',
      JSON.stringify({
        smokeOk: true,
        accepted: [{ sessionId: 'p2p_realnet', clientId: 'phone-1' }],
        routeFallbacksPreserved: ['Cloudflare Tunnel', 'FRP/SakuraFRP'],
      }),
      '--client-result',
      JSON.stringify({
        smokeOk: true,
        route: { kind: 'p2p', id: 'p2p-raw-tcp' },
        status: 200,
        connectorEvents: [{ type: 'success', localPort: 44000, remotePort: 44000 }],
      }),
    ], { cwd: root, timeout: 8_000 });

    const result = JSON.parse(stdout) as {
      smokeOk: boolean;
      checks: Array<{ name: string; ok: boolean }>;
    };
    expect(result.smokeOk).toBe(true);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'node accepted client', ok: true }),
      expect.objectContaining({ name: 'client selected p2p route', ok: true }),
      expect.objectContaining({ name: 'tunnel fallbacks preserved', ok: true }),
    ]));
  });
});
