import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_SCHEMA_VERSION, XPOD_CLI_PACKAGE, XPOD_CLI_VERSION, sha256File, type XpodCliManifest } from '../src/manifest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const tempRoot = path.join(repo, '.test-data', 'xpod-cli-verifier');
mkdirSync(tempRoot, { recursive: true });
const work = mkdtempSync(path.join(tempRoot, 'missing-runtime-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

test('rejects a bundled helper whose dynamic runtime is unavailable', () => {
  const install = path.join(work, 'install');
  mkdirSync(path.join(install, 'bin'), { recursive: true });
  mkdirSync(path.join(install, 'helper'), { recursive: true });
  writeFileSync(path.join(install, 'bin/xpodcli'), `#!/bin/sh
case "$1" in
  --version) echo '${XPOD_CLI_VERSION}';;
  --help) printf 'Xpod CLI\n  xpodcli auth\n  xpodcli agent-fs\n';;
  *) echo '{"ok":true,"data":{"helperPresent":true}}';;
esac
`, { mode: 0o755 });
  // Reproduce the ELF loader failure without requiring a foreign architecture
  // or changing the host's installed libraries.
  writeFileSync(path.join(install, 'helper/agentfs-pod'), `#!/bin/sh
echo 'error while loading shared libraries: libssl.so.3: cannot open shared object file' >&2
exit 127
`, { mode: 0o755 });
  const manifest: XpodCliManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    package: XPOD_CLI_PACKAGE,
    version: XPOD_CLI_VERSION,
    platform: `${process.platform}-${process.arch}`,
    channel: 'local-preview',
    sourceSHA: 'a'.repeat(40),
    dirtyTreeHash: 'b'.repeat(64),
    source: { mode: 'local-preview', commit: 'a'.repeat(40), dirty: true },
    selectedEnginePin: {
      engine: 'agentfs', repository: 'https://github.com/tursodatabase/agentfs', commit: 'c'.repeat(40),
      sdkLicenseStatus: 'verified', cliLicenseStatus: 'pending', rootLicensePresent: false,
    },
    artifacts: [ ['xpodcli', 'cli', 'bin/xpodcli'], ['agentfs-pod', 'native-helper', 'helper/agentfs-pod'] ].map(([name, kind, rel]) => ({
      name, kind: kind as 'cli' | 'native-helper', path: rel, included: true,
      sha256: sha256File(path.join(install, rel)), sizeBytes: statSync(path.join(install, rel)).size,
      license: { spdx: null, status: 'pending' as const, source: 'test fixture' },
    })),
    validationState: 'install-verified', generatedAt: new Date().toISOString(), notes: [],
  };
  writeFileSync(path.join(install, 'manifest.json'), JSON.stringify(manifest));
  const verify = spawnSync(process.execPath, [ path.join(repo, 'packages/xpod-cli/scripts/verify-install.ts'), '--dir', install ], {
    encoding: 'utf8', timeout: 10_000,
  });
  const report = JSON.parse(verify.stdout) as { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] };
  expect(verify.status).toBe(1);
  expect(report.ok).toBe(false);
  expect(report.checks.find((check) => check.name === 'status helperPresent matches bundle')?.ok).toBe(true);
  const execution = report.checks.find((check) => check.name === 'native helper executes');
  expect(execution?.ok).toBe(false);
  expect(execution?.detail).toContain('libssl.so.3');
});
