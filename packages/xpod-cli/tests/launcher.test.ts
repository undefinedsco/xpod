import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { externalRuntimeLauncher } from '../src/launcher';

test('external launcher preserves arguments and paths and never retries a failed runtime', () => {
  const root = path.resolve('.test-data/xpod-cli/launcher');
  mkdirSync(root, { recursive: true });
  const work = mkdtempSync(path.join(root, "space ' install-"));
  const bin = path.join(work, 'bin');
  const tools = path.join(work, 'tools');
  mkdirSync(bin); mkdirSync(tools); mkdirSync(path.join(work, 'lib'));
  writeFileSync(path.join(bin, 'xpodcli'), externalRuntimeLauncher(), { mode: 0o755 });
  writeFileSync(path.join(work, 'lib/xpodcli.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));');
  symlinkSync('/usr/bin/dirname', path.join(tools, 'dirname'));
  symlinkSync('/usr/bin/readlink', path.join(tools, 'readlink'));
  const run = (entry = path.join(bin, 'xpodcli')) => spawnSync(entry, ["quote ' argument", '--version'], {
    cwd: '/tmp', env: { ...process.env, PATH: tools }, encoding: 'utf8',
  });
  try {
    const missing = run();
    expect(missing.status).toBe(127);
    expect(missing.stderr).toContain('installed Bun');
    symlinkSync(process.execPath, path.join(tools, 'node'));
    expect(JSON.parse(run().stdout)).toEqual(["quote ' argument", '--version']);
    symlinkSync(path.join(bin, 'xpodcli'), path.join(tools, 'absolute-cli'));
    symlinkSync('../bin/xpodcli', path.join(tools, 'relative-cli'));
    symlinkSync('relative-cli', path.join(tools, 'chained-cli'));
    for (const name of ['absolute-cli', 'relative-cli', 'chained-cli']) {
      const result = run(path.join(tools, name));
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(["quote ' argument", '--version']);
    }
    writeFileSync(path.join(tools, 'bun'), '#!/bin/sh\nexit 42\n', { mode: 0o755 });
    expect(run().status).toBe(42);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
