import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../..');

describe('P2P real-network acceptance script', () => {
  it('runs node accept smoke under Node.js so raw TCP localPort is honored', async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['smoke:p2p:node-accept']).toContain('node -r ts-node/register');
    expect(packageJson.scripts?.['smoke:p2p:node-accept']).not.toMatch(/^bun\s+scripts\/edge-node-p2p-accept-smoke\.ts/u);
  });

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
      mobile: { packageName: string; fields: Record<string, string> };
      routeFallbacksPreserved: string[];
      caveats: string[];
    };
    expect(result.kind).toBe('raw-tcp-p2p-realnet-acceptance');
    expect(result.node.shell).toContain('node');
    expect(result.node.shell).toContain('-r');
    expect(result.node.shell).toContain('ts-node/register');
    expect(result.node.shell).toContain('scripts/edge-node-p2p-accept-smoke.ts');
    expect(result.node.shell).not.toContain('bun run smoke:p2p:node-accept');
    expect(result.client.shell).toContain('smoke:p2p:managed');
    expect(result.mobile.packageName).toBe('com.linxmobile.p2psmoke');
    expect(result.mobile.fields).toMatchObject({
      idpUrl: 'https://id.undefineds.co/',
      storageUrl: 'https://node-1.undefineds.co/',
      clientId: 'phone-1',
      resourcePath: '/alice/a.txt',
    });
    expect(result.mobile.fields).not.toHaveProperty('signalToken');
    expect(result.caveats.join('\n')).toContain('Mobile smoke evidence must still be verified with the same realnet verifier');
    expect(result.node.command).toContain('--require-accept');
    expect(result.client.command).toContain('--require-p2p');
    expect(result.node.command).not.toContain('--host');
    expect(result.client.command).not.toContain('--host');
    expect(result.routeFallbacksPreserved).toEqual(expect.arrayContaining([
      'Cloudflare Tunnel',
      'FRP/SakuraFRP',
    ]));
  });

  it('requires mobile write status to be 2xx when requested', async () => {
    const { stdout } = await execFileAsync('bun', [
      'scripts/p2p-realnet-acceptance.ts',
      'verify',
      '--client-id',
      'phone-1',
      '--require-put-status-2xx',
      '--node-result',
      JSON.stringify({
        smokeOk: true,
        accepted: [{ sessionId: 'p2p_realnet', clientId: 'phone-1', nodeAddress: 'signal-observed' }],
        routeFallbacksPreserved: ['Cloudflare Tunnel', 'FRP/SakuraFRP'],
      }),
      '--client-result',
      JSON.stringify({
        smokeOk: true,
        route: { kind: 'p2p', id: 'p2p-raw-tcp' },
        putStatus: 201,
        status: 200,
        clientAddress: 'signal-observed',
        connectorEvents: [{ type: 'success', localPort: 44000, remotePort: 44000 }],
      }),
    ], { cwd: root, timeout: 8_000 });

    const result = JSON.parse(stdout) as {
      smokeOk: boolean;
      checks: Array<{ name: string; ok: boolean }>;
    };
    expect(result.smokeOk).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'write http status is 2xx',
      ok: true,
    }));
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
        accepted: [{ sessionId: 'p2p_realnet', clientId: 'phone-1', nodeAddress: 'signal-observed' }],
        routeFallbacksPreserved: ['Cloudflare Tunnel', 'FRP/SakuraFRP'],
      }),
      '--client-result',
      JSON.stringify({
        smokeOk: true,
        route: { kind: 'p2p', id: 'p2p-raw-tcp' },
        status: 200,
        clientAddress: 'signal-observed',
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
      expect.objectContaining({ name: 'client address came from signal', ok: true }),
      expect.objectContaining({ name: 'node address came from signal', ok: true }),
      expect.objectContaining({ name: 'tunnel fallbacks preserved', ok: true }),
    ]));
  });

  it('verifies node/client JSON result files without shell-inlining large payloads', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'xpod-p2p-realnet-'));
    const nodeResultPath = path.join(dir, 'node-result.json');
    const clientResultPath = path.join(dir, 'mobile-result.json');
    await writeFile(nodeResultPath, JSON.stringify({
      smokeOk: true,
      accepted: [{ sessionId: 'p2p_realnet', clientId: 'phone-1', nodeAddress: 'signal-observed' }],
      routeFallbacksPreserved: ['Cloudflare Tunnel', 'FRP/SakuraFRP'],
    }));
    await writeFile(clientResultPath, JSON.stringify({
      smokeOk: true,
      route: { kind: 'p2p', id: 'p2p-raw-tcp' },
      putStatus: 201,
      status: 200,
      clientAddress: 'signal-observed',
      connectorEvents: [{ type: 'success', localPort: 44000, remotePort: 44000 }],
    }));

    const { stdout } = await execFileAsync('bun', [
      'scripts/p2p-realnet-acceptance.ts',
      'verify',
      '--client-id',
      'phone-1',
      '--require-put-status-2xx',
      '--node-result-file',
      nodeResultPath,
      '--client-result-file',
      clientResultPath,
    ], { cwd: root, timeout: 8_000 });

    const result = JSON.parse(stdout) as {
      smokeOk: boolean;
      checks: Array<{ name: string; ok: boolean }>;
    };
    expect(result.smokeOk).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'write http status is 2xx',
      ok: true,
    }));
  });
});
