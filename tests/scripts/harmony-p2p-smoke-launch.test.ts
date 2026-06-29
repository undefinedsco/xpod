import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../..');

describe('Harmony P2P smoke launcher', () => {
  it('prints HDC install, aa start, hilog capture, and verifier commands in dry-run mode', async () => {
    const { stdout } = await execFileAsync('bun', [
      'scripts/harmony-p2p-smoke-launch.ts',
      '--dry-run',
      '--hap',
      '.artifacts/harmony-p2p-smoke/entry-default.hap',
      '--hdc',
      '/tmp/hdc',
      '--hdc-target',
      '62T0226101021775',
      '--bundle-name',
      'com.undefineds.xpod.p2psmoke',
      '--ability-name',
      'EntryAbility',
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
      'harmony-phone-1',
      '--resource-url',
      'https://node-0000.undefineds.co/alice/.data/harmony-p2p-smoke.txt',
    ], { cwd: root, timeout: 8_000 });

    expect(stdout).toContain('DRY RUN: Harmony real-network P2P acceptance');
    expect(stdout).toContain('/tmp/hdc -t 62T0226101021775 install .artifacts/harmony-p2p-smoke/entry-default.hap');
    expect(stdout).toContain('/tmp/hdc -t 62T0226101021775 hilog -r');
    expect(stdout).toContain('/tmp/hdc -t 62T0226101021775 shell aa start -b com.undefineds.xpod.p2psmoke -a EntryAbility');
    expect(stdout).toContain('--ps xpod.p2p.apiBaseUrl https://api.undefineds.co/');
    expect(stdout).toContain('--ps xpod.p2p.clientId harmony-phone-1');
    expect(stdout).toContain('/tmp/hdc -t 62T0226101021775 hilog -T XpodP2PSmoke');
    expect(stdout).toContain('node -r ts-node/register scripts/edge-node-p2p-accept-smoke.ts');
    expect(stdout).toContain('bun run smoke:p2p:realnet -- verify');
    expect(stdout).toContain('--require-put-status-2xx');
  });

  it('extracts RESULT_JSON from hilog output into a verifier file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'xpod-harmony-launch-'));
    const log = path.join(dir, 'hilog.txt');
    const result = path.join(dir, 'mobile-result.json');
    await writeFile(log, 'noise\n06-22 XpodP2PSmoke RESULT_JSON {"smokeOk":true,"route":{"kind":"p2p"},"connectorEvents":[{"type":"success"}],"clientAddress":"signal-observed","putStatus":201,"status":200}\n');

    await execFileAsync('bun', [
      'scripts/harmony-p2p-smoke-launch.ts',
      'extract-result',
      '--input',
      log,
      '--output',
      result,
    ], { cwd: root, timeout: 8_000 });

    const parsed = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(result, 'utf8')));
    expect(parsed).toEqual({
      smokeOk: true,
      route: { kind: 'p2p' },
      connectorEvents: [{ type: 'success' }],
      clientAddress: 'signal-observed',
      putStatus: 201,
      status: 200,
    });
  });
});
