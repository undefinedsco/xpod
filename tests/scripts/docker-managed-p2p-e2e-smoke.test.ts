import { execFile } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../..');

describe('Docker managed-client P2P E2E smoke script', () => {
  it('documents the Docker bridge boundary and signal-observed address contract', async () => {
    const { stdout } = await execFileAsync('bun', [
      'scripts/docker-managed-p2p-e2e-smoke.ts',
      '--help',
    ], { cwd: root, timeout: 5_000 });

    expect(stdout).toContain('docker compose');
    expect(stdout).toContain('signal-observed');
    expect(stdout).toContain('Docker bridge');
    expect(stdout).toContain('starts a signal fixture container');
    expect(stdout).toContain('runs node and managed-client smoke containers');
    expect(stdout).not.toContain('starts a host signal API');
    expect(stdout).not.toContain('starts a host target HTTP server');
    expect(stdout).toContain('does not prove real cross-NAT');
    expect(stdout).toContain('Cloudflare Tunnel');
    expect(stdout).toContain('FRP/SakuraFRP');
  });

  it('exposes the Docker E2E smoke through the package script', async () => {
    const packageJson = await import(`${root}/package.json`);

    expect(packageJson.default.scripts['smoke:p2p:docker-e2e']).toBe('bun scripts/docker-managed-p2p-e2e-smoke.ts');
  });

  it('verifies Docker node/client JSON evidence as one smoke verdict', async () => {
    const { stdout } = await execFileAsync('bun', [
      'scripts/docker-managed-p2p-e2e-smoke.ts',
      'verify',
      '--client-id',
      'docker-client-1',
      '--expected-body',
      'docker p2p response',
      '--node-result',
      JSON.stringify({
        smokeOk: true,
        clientId: 'docker-client-1',
        accepted: [{
          sessionId: 'p2p_docker',
          clientId: 'docker-client-1',
          nodeAddress: 'signal-observed',
          clientAddress: 'signal-observed',
        }],
        targetRequests: [{ url: '/alice/docker-p2p.txt' }],
        evidence: {
          networkBoundary: 'docker-bridge',
          dataPlane: 'docker-bridge-tcp-listener',
          nodeAddress: 'signal-observed',
        },
        routeFallbacksPreserved: ['Cloudflare Tunnel', 'FRP/SakuraFRP'],
      }),
      '--client-result',
      JSON.stringify({
        smokeOk: true,
        ok: true,
        route: { kind: 'p2p', id: 'p2p-raw-tcp' },
        status: 200,
        body: 'docker p2p response',
        clientAddress: 'signal-observed',
        connectorEvents: [{
          type: 'success',
          localAddress: 'signal-observed',
          remoteAddress: 'signal-observed',
          localPort: 41000,
          remotePort: 42000,
        }],
        evidence: {
          networkBoundary: 'docker-bridge',
          dataPlane: 'docker-bridge-tcp-listener',
        },
      }),
    ], { cwd: root, timeout: 5_000 });

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
      expect.objectContaining({ name: 'docker bridge data plane used', ok: true }),
      expect.objectContaining({ name: 'tunnel fallbacks preserved', ok: true }),
    ]));
  });

  it('does not miss node runner output when the node container exits before the client command returns', async () => {
    const fakeDockerDir = await mkdtemp(path.join(tmpdir(), 'xpod-fake-docker-'));
    const fakeDocker = path.join(fakeDockerDir, 'docker');
    await writeFile(fakeDocker, `#!/usr/bin/env node
const args = process.argv.slice(2);
const text = args.join(' ');
if (args[0] === 'network' || args[0] === 'rm') process.exit(0);
if (args[0] !== 'run') process.exit(0);
if (text.includes('docker-p2p-signal-fixture.ts')) {
  console.log(JSON.stringify({ ready: true, signalUrl: 'http://signal:8080/', targetUrl: 'http://signal:8081/' }));
  process.exit(0);
}
if (text.includes('/routes')) process.exit(0);
if (text.includes('docker-p2p-node-listener-smoke.ts')) {
  console.log(JSON.stringify({
    smokeOk: true,
    accepted: [{
      sessionId: 'p2p_fast_node',
      clientId: 'early-client',
      nodeAddress: 'signal-observed',
      clientAddress: 'signal-observed'
    }],
    evidence: { networkBoundary: 'docker-bridge', dataPlane: 'docker-bridge-tcp-listener', nodeAddress: 'signal-observed' },
    routeFallbacksPreserved: ['Cloudflare Tunnel', 'FRP/SakuraFRP']
  }, null, 2));
  process.exit(0);
}
if (text.includes('managed-client-p2p-smoke.ts')) {
  setTimeout(() => {
    console.log(JSON.stringify({
      ok: true,
      smokeOk: true,
      route: { kind: 'p2p' },
      status: 200,
      body: 'docker p2p e2e response',
      clientAddress: 'signal-observed',
      connectorEvents: [{ type: 'success', localAddress: 'signal-observed', remoteAddress: 'signal-observed', remotePort: 41000 }],
      evidence: { networkBoundary: 'docker-bridge', dataPlane: 'docker-bridge-tcp-listener' }
    }));
  }, 150);
  return;
}
if (text.includes('__fixture/requests')) {
  console.log(JSON.stringify({ requests: [{ method: 'GET', url: '/alice/docker-p2p-e2e.txt?version=1', headers: {} }] }));
  process.exit(0);
}
process.exit(0);
`);
    await chmod(fakeDocker, 0o755);

    const { stdout } = await execFileAsync('bun', [
      'scripts/docker-managed-p2p-e2e-smoke.ts',
      '--project-name',
      'fake-early-node',
      '--client-id',
      'early-client',
      '--node-run-timeout-ms',
      '250',
      '--wait-timeout-ms',
      '250',
      '--request-timeout-ms',
      '250',
    ], {
      cwd: root,
      timeout: 5_000,
      env: { ...process.env, PATH: `${fakeDockerDir}${path.delimiter}${process.env.PATH ?? ''}` },
    });

    const result = JSON.parse(stdout) as {
      smokeOk: boolean;
      nodeResult?: { smokeOk?: boolean };
    };
    expect(result.smokeOk).toBe(true);
    expect(result.nodeResult?.smokeOk).toBe(true);
  });
});
