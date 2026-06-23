import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../..');

describe('Android real-network P2P smoke orchestrator', () => {
  it('prints node, mobile capture, and verifier commands in dry-run mode', async () => {
    const { stdout } = await execFileAsync('bun', [
      'scripts/p2p-android-realnet-smoke.ts',
      '--dry-run',
      '--linx-mobile-root',
      '/Users/ganlu/develop/linx-mobile',
      '--api-base-url',
      'https://api.undefineds.co/',
      '--node-id',
      'node-0000',
      '--node-token',
      'node-token',
      '--base-url',
      'https://node-0000.undefineds.co/',
      '--target-base-url',
      'http://127.0.0.1:3000/',
      '--client-id',
      'phone-1',
      '--resource-url',
      'https://node-0000.undefineds.co/alice/.data/linx-mobile-p2p-smoke.txt',
      '--adb',
      '/opt/homebrew/bin/adb',
      '--adb-server-port',
      '5041',
    ], { cwd: root, timeout: 8_000 });

    expect(stdout).toContain('DRY RUN: Android real-network P2P acceptance');
    expect(stdout).toContain('node-result.json');
    expect(stdout).toContain('mobile-result.json');
    expect(stdout).toContain('bun run smoke:p2p:node-accept');
    expect(stdout).toContain('--settle-after-accept-ms 1000');
    expect(stdout).toContain('--require-accept --settle-after-accept-ms 1000 > ');
    expect(stdout).not.toContain("'>'");
    expect(stdout).toContain('npm run p2p:android:launch --');
    expect(stdout).toContain('--capture-result');
    expect(stdout).toContain('bun run smoke:p2p:realnet -- verify');
    expect(stdout).toContain('--node-result-file');
    expect(stdout).toContain('--client-result-file');
    expect(stdout).toContain('--require-put-status-2xx');
    expect(stdout).toContain('--expected-status 200');
  });


  it('passes Harmony hdc transport options through to the mobile launcher', async () => {
    const { stdout } = await execFileAsync('bun', [
      'scripts/p2p-android-realnet-smoke.ts',
      '--dry-run',
      '--linx-mobile-root',
      '/Users/ganlu/develop/linx-mobile',
      '--api-base-url',
      'https://api.undefineds.co/',
      '--node-id',
      'node-0000',
      '--node-token',
      'node-token',
      '--base-url',
      'https://node-0000.undefineds.co/',
      '--target-base-url',
      'http://127.0.0.1:3000/',
      '--client-id',
      'phone-hdc',
      '--resource-url',
      'https://node-0000.undefineds.co/alice/.data/linx-mobile-p2p-smoke.txt',
      '--transport',
      'hdc',
      '--hdc',
      '/tmp/hdc',
      '--hdc-target',
      '62T0226101021775',
    ], { cwd: root, timeout: 8_000 });

    expect(stdout).toContain('npm run p2p:android:launch --');
    expect(stdout).toContain('--transport hdc');
    expect(stdout).toContain('--hdc /tmp/hdc');
    expect(stdout).toContain('--hdc-target 62T0226101021775');
    expect(stdout).not.toContain('--adb ');
  });

  it('captures node accept stdout into node-result.json instead of discarding it', async () => {
    const source = await readFile(path.join(root, 'scripts/p2p-android-realnet-smoke.ts'), 'utf8');

    expect(source).toContain("stdio: outputFile ? ['ignore', 'pipe', 'inherit'] : 'inherit'");
    expect(source).toContain("child.stdout?.setEncoding('utf8')");
  });

  it('drains the node accept process promise after stopping it on mobile failure', async () => {
    const source = await readFile(path.join(root, 'scripts/p2p-android-realnet-smoke.ts'), 'utf8');

    expect(source).toContain('await nodeProcess.catch(() => undefined);');
  });

  it('is exposed through the package smoke script', async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['smoke:p2p:android-realnet'])
      .toBe('bun scripts/p2p-android-realnet-smoke.ts');
  });
});
