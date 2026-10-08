import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_SCHEMA_VERSION, XPOD_CLI_PACKAGE, XPOD_CLI_VERSION, sha256File, type XpodCliManifest } from '../src/manifest';
import { copyNativeDeclarations } from '../src/native-declarations';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const tempRoot = path.join(repo, '.test-data', 'xpod-cli-verifier');
mkdirSync(tempRoot, { recursive: true });
const work = mkdtempSync(path.join(tempRoot, 'missing-runtime-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

test('rejects a bundled helper whose dynamic runtime is unavailable', () => {
  const install = path.join(work, 'install');
  mkdirSync(path.join(install, 'bin'), { recursive: true });
  mkdirSync(path.join(install, 'helper'), { recursive: true });
  mkdirSync(path.join(install, 'lib'), { recursive: true });
  writeFileSync(path.join(install, 'lib/xpodcli.mjs'), '// fixture payload\n');
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
    schemaVersion: MANIFEST_SCHEMA_VERSION, distribution: 'external-runtime',
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
    artifacts: [ ['xpodcli', 'cli', 'lib/xpodcli.mjs'], ['xpodcli-launcher', 'cli', 'bin/xpodcli'], ['agentfs-pod', 'native-helper', 'helper/agentfs-pod'] ].map(([name, kind, rel]) => ({
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
  const marker = path.join(work, 'must-not-execute');
  writeFileSync(path.join(install, 'bin/xpodcli'), `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o755 });
  const launcher = manifest.artifacts.find((entry) => entry.name === 'xpodcli-launcher')!;
  launcher.sha256 = sha256File(path.join(install, 'bin/xpodcli'));
  launcher.sizeBytes = statSync(path.join(install, 'bin/xpodcli')).size;
  const valid = JSON.parse(JSON.stringify(manifest)) as XpodCliManifest;
  for (const fault of ['missing-launcher', 'payload-hash', 'launcher-hash']) {
    const invalid = JSON.parse(JSON.stringify(valid)) as XpodCliManifest;
    if (fault === 'missing-launcher') invalid.artifacts = invalid.artifacts.filter((entry) => entry.name !== 'xpodcli-launcher');
    else invalid.artifacts.find((entry) => entry.name === (fault === 'payload-hash' ? 'xpodcli' : 'xpodcli-launcher'))!.sha256 = '0'.repeat(64);
    writeFileSync(path.join(install, 'manifest.json'), JSON.stringify(invalid));
    const rejected = spawnSync(process.execPath, [path.join(repo, 'packages/xpod-cli/scripts/verify-install.ts'), '--dir', install], {
      encoding: 'utf8', timeout: 10_000,
    });
    expect(rejected.status).toBe(1);
    expect(JSON.parse(rejected.stdout).checks.some((check: { name: string }) => check.name === 'xpodcli --version exit 0')).toBe(false);
    expect(existsSync(marker)).toBe(false);
  }
});

test('checks source-bound engine material and refuses unmanifested objects despite a valid index hash', () => {
  const install = path.join(work, 'evidence-install');
  const destination = path.join(install, 'licenses/native/declarations');
  const source = path.join(repo, 'packages/xpod-cli/licenses/native/declarations');
  const index = JSON.parse(readFileSync(path.join(source, 'index.json'), 'utf8'));
  const files = copyNativeDeclarations(source, destination, index.engine);
  const manifest: XpodCliManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION, distribution: 'external-runtime', package: XPOD_CLI_PACKAGE, version: XPOD_CLI_VERSION,
    platform: 'darwin-arm64', channel: 'local-preview', sourceSHA: 'a'.repeat(40), dirtyTreeHash: null,
    source: { mode: 'local-preview', commit: 'a'.repeat(40), dirty: false },
    selectedEnginePin: { ...index.engine, sdkLicenseStatus: 'verified', cliLicenseStatus: 'verified', rootLicensePresent: false,
      licenseEvidence: { path: 'licenses/native/declarations/index.json', sha256: sha256File(path.join(destination, 'index.json')) } },
    artifacts: files.map((file) => ({
      name: file, kind: 'notice', path: `licenses/native/declarations/${file}`, included: true,
      sha256: sha256File(path.join(destination, file)), sizeBytes: statSync(path.join(destination, file)).size,
      license: { spdx: null, status: 'verified', source: 'test declarations' },
    })),
    validationState: 'unverified', generatedAt: new Date().toISOString(), notes: [],
  };
  mkdirSync(path.join(install, 'bin'), { recursive: true });
  mkdirSync(path.join(install, 'lib'), { recursive: true });
  for (const [name, relative] of [['xpodcli', 'lib/xpodcli.mjs'], ['xpodcli-launcher', 'bin/xpodcli']]) {
    writeFileSync(path.join(install, relative), '// not executed in material-only validation\n');
    manifest.artifacts.unshift({ name, kind: 'cli', path: relative, included: true,
      sha256: sha256File(path.join(install, relative)), sizeBytes: statSync(path.join(install, relative)).size,
      license: { spdx: 'MIT', status: 'verified', source: 'test fixture' } });
  }
  const verifyEvidence = (): { status: number | null; ok: boolean; detail: string } => {
    writeFileSync(path.join(install, 'manifest.json'), JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [path.join(repo, 'packages/xpod-cli/scripts/verify-install.ts'), '--dir', install, '--skip-exec'], {
      encoding: 'utf8', timeout: 10_000,
    });
    const report = JSON.parse(result.stdout) as { checks: { name: string; ok: boolean; detail: string }[] };
    const check = report.checks.find((entry) => entry.name === 'selected engine license evidence');
    return { status: result.status, ok: check?.ok ?? false, detail: check?.detail ?? '' };
  };
  expect(verifyEvidence().ok).toBe(true);
  manifest.artifacts.pop();
  const absent = verifyEvidence();
  expect(absent.ok).toBe(false);
  expect(absent.status).toBe(1);
  expect(absent.detail).toContain('missing from manifest');
  manifest.selectedEnginePin.commit = 'b'.repeat(40);
  expect(verifyEvidence().detail).toContain('engine pin');
});
