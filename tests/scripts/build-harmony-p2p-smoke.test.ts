import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../..');

describe('Harmony P2P smoke build script', () => {
  it('is exposed as a package script', async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.['build:harmony:p2p-smoke']).toBe('node scripts/build-harmony-p2p-smoke.cjs');
  });


  it('infers the embedded Command Line Tools SDK root from XPOD_HVIGOR_CLI', async () => {
    const tempRoot = path.join(root, '.test-data', 'harmony-build-script', `clt-${Date.now()}`);
    const hvigorw = path.join(tempRoot, 'command-line-tools', 'bin', 'hvigorw');
    const sdkRoot = path.join(tempRoot, 'command-line-tools', 'sdk');
    await import('node:fs/promises').then(async fs => {
      await fs.mkdir(path.dirname(hvigorw), { recursive: true });
      await fs.mkdir(path.join(sdkRoot, 'default'), { recursive: true });
      await fs.writeFile(hvigorw, '#!/usr/bin/env bash\nexit 0\n');
      await fs.chmod(hvigorw, 0o755);
      await fs.writeFile(path.join(sdkRoot, 'default', 'sdk-pkg.json'), '{}');
    });

    const { stdout, stderr } = await execFileAsync('node', [
      'scripts/build-harmony-p2p-smoke.cjs',
      '--doctor',
    ], {
      cwd: root,
      timeout: 8_000,
      env: { ...process.env, DEVECO_SDK_HOME: '', XPOD_HVIGOR_CLI: hvigorw },
    });

    const output = `${stdout}\n${stderr}`;
    expect(output).toContain(`hvigor: ${hvigorw}`);
    expect(output).toContain(`DEVECO_SDK_HOME: ${sdkRoot}`);
  });

  it('prints a precise environment diagnosis when SDK/Hvigor inputs are missing', async () => {
    const { stdout, stderr } = await execFileAsync('node', [
      'scripts/build-harmony-p2p-smoke.cjs',
      '--doctor',
    ], {
      cwd: root,
      timeout: 8_000,
      env: { ...process.env, DEVECO_SDK_HOME: '', XPOD_HVIGOR_CLI: '' },
    });

    const output = `${stdout}\n${stderr}`;
    expect(output).toContain('Harmony P2P smoke build doctor');
    expect(output).toContain('project: harmony/p2p-smoke');
    expect(output).toContain('java:');
    expect(output).toContain('hvigor:');
    expect(output).toContain('DEVECO_SDK_HOME: missing');
  });
});
