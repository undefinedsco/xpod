import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../..');

describe('ngrok tunnel smoke script', () => {
  it('has a package script for ngrok user-tunnel acceptance', async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['smoke:tunnel:ngrok']).toBe('bun scripts/ngrok-tunnel-smoke.ts');
  });

  it('prints a dry-run plan without requiring a live ngrok account', async () => {
    const { stdout } = await execFileAsync('bun', [
      'scripts/ngrok-tunnel-smoke.ts',
      '--dry-run',
      '--ngrok-url', 'https://ravioli-basics-throbbing.ngrok-free.dev',
      '--local-port', '3000',
    ], { cwd: root, timeout: 8_000 });

    const result = JSON.parse(stdout) as {
      kind: string;
      dryRun: boolean;
      provider: string;
      route: { canonicalUrl: string; kind: string; targetUrl: string };
      originUrl: string;
      caveats: string[];
    };
    expect(result.kind).toBe('ngrok-user-tunnel-smoke');
    expect(result.dryRun).toBe(true);
    expect(result.provider).toBe('ngrok');
    expect(result.originUrl).toBe('http://127.0.0.1:3000');
    expect(result.route).toMatchObject({
      canonicalUrl: 'about:blank',
      kind: 'user-tunnel',
      targetUrl: 'https://ravioli-basics-throbbing.ngrok-free.dev/',
    });
    expect(result.caveats.join('\n')).toContain('free ngrok dev domains are not canonical Solid browser origins');
  });

  it('ignores xpod-prefixed ngrok URL aliases in dry-run mode', async () => {
    const legacyNgrokUrl = `${'XPOD'}_${'NGROK'}_URL`;
    const { stdout } = await execFileAsync('bun', [
      'scripts/ngrok-tunnel-smoke.ts',
      '--dry-run',
      '--local-port', '3000',
    ], {
      cwd: root,
      timeout: 8_000,
      env: {
        ...process.env,
        NGROK_URL: '',
        [legacyNgrokUrl]: 'https://legacy.ngrok-free.dev',
      },
    });

    const result = JSON.parse(stdout) as {
      route: { targetUrl: string };
    };
    expect(result.route.targetUrl).toBe('');
  });

  it('marks missing ngrok authentication as an external acceptance blocker', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'xpod-fake-ngrok-'));
    const fakeNgrok = path.join(dir, 'ngrok');
    await writeFile(fakeNgrok, [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ lvl: "eror", err: "authentication failed: ERR_NGROK_4018" }));',
      'process.exit(1);',
      '',
    ].join('\n'));
    await chmod(fakeNgrok, 0o755);

    try {
      await execFileAsync('bun', [
        'scripts/ngrok-tunnel-smoke.ts',
        '--test-server',
        '--ngrok-bin', fakeNgrok,
        '--local-port', '35076',
        '--timeout-ms', '1000',
      ], { cwd: root, timeout: 8_000 });
      throw new Error('expected smoke command to fail');
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout ?? '';
      const result = JSON.parse(stdout) as {
        smokeOk: boolean;
        blockedBy?: string;
        nextAction?: string;
        error: string;
      };
      expect(result.smokeOk).toBe(false);
      expect(result.blockedBy).toBe('ngrok-auth');
      expect(result.nextAction).toContain('ngrok config add-authtoken');
      expect(result.error).toContain('ERR_NGROK_4018');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retries the public endpoint until the ngrok edge routes to the local server', async () => {
    let attempts = 0;
    const proxy = createServer((_, response) => {
      attempts += 1;
      if (attempts === 1) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('edge not ready');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    await listen(proxy);
    const proxyPort = (proxy.address() as AddressInfo).port;

    const dir = await mkdtemp(path.join(tmpdir(), 'xpod-fake-ngrok-'));
    const fakeNgrok = path.join(dir, 'ngrok');
    await writeFile(fakeNgrok, [
      '#!/usr/bin/env node',
      'const endpoint = process.env.XPOD_FAKE_NGROK_ENDPOINT;',
      'console.log(JSON.stringify({ lvl: "info", msg: "client session established" }));',
      'setTimeout(() => console.log(JSON.stringify({ lvl: "info", msg: "started tunnel", url: endpoint })), 10);',
      'setInterval(() => {}, 1000);',
      'process.on("SIGTERM", () => process.exit(0));',
      '',
    ].join('\n'));
    await chmod(fakeNgrok, 0o755);

    try {
      const { stdout } = await execFileAsync('bun', [
        'scripts/ngrok-tunnel-smoke.ts',
        '--ngrok-bin', fakeNgrok,
        '--local-port', '35077',
        '--timeout-ms', '5000',
      ], {
        cwd: root,
        timeout: 8_000,
        env: {
          ...process.env,
          XPOD_FAKE_NGROK_ENDPOINT: `http://127.0.0.1:${proxyPort}`,
        },
      });
      const result = JSON.parse(stdout) as { smokeOk: boolean; status: number };
      expect(result.smokeOk).toBe(true);
      expect(result.status).toBe(200);
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      await closeServer(proxy);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
