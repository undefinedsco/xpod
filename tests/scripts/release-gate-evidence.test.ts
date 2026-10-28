import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../..');
const script = path.join(repoRoot, 'scripts/release-gate-evidence.cjs');
const { PACKAGES } = require('../../scripts/workspace-package-consumer.cjs') as { PACKAGES: string[] };
const { loadQleverSourceConformance, loadWorkspacePackageNames } = require('../../scripts/release-gate-evidence.cjs') as {
  loadQleverSourceConformance: () => {
    repository: string;
    commit: string;
    patchSeriesSha256: string;
    adapterAbiVersion: number;
    physicalBackendAbiVersion: number;
  };
  loadWorkspacePackageNames: () => string[];
};

const conformance = loadQleverSourceConformance();
// Repository rule: test data lives under .test-data, never the OS temp dir or
// repo root. Remove only this run's directory so parallel runs keep their parent.
const suiteRoot = path.join(repoRoot, '.test-data/release-gate-evidence');
const tempRoot = (() => {
  mkdirSync(suiteRoot, { recursive: true });
  return mkdtempSync(path.join(suiteRoot, 'suite-'));
})();
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sha512 = (bytes: Buffer) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

function run(args: string[]): string {
  return execFileSync(process.execPath, [ script, ...args ], { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ] });
}

function expectFailure(args: string[]): void {
  let error: any;
  try {
    run(args);
  } catch (caught) {
    error = caught;
  }
  expect(error, `expected a non-zero exit for: ${args.join(' ')}`).toBeDefined();
  expect(error.status).not.toBe(0);
}

function readChecks(file: string): Record<string, string> {
  return JSON.parse(readFileSync(file, 'utf8'));
}

interface QleverArchive {
  archive: string;
  runtime: Buffer;
  manifest: any;
  manifestBytes: Buffer;
}

function makeQleverArchive(label: string, options: {
  platform?: string;
  adapterAbiVersion?: number;
  physicalBackendAbiVersion?: number;
  commit?: string;
  patchSeriesSha256?: string;
  declaredRuntimeSha256?: string;
} = {}): QleverArchive {
  const root = mkdtempSync(path.join(tempRoot, `qlever-${label}-`));
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  const runtime = Buffer.from(`native-runtime-bytes-${label}\n`);
  writeFileSync(path.join(root, 'bin/xpod_qlever_local_runtime'), runtime);
  const manifest = {
    schemaVersion: 1,
    adapterAbiVersion: options.adapterAbiVersion ?? conformance.adapterAbiVersion,
    physicalBackendAbiVersion: options.physicalBackendAbiVersion ?? conformance.physicalBackendAbiVersion,
    qlever: {
      repository: conformance.repository,
      commit: options.commit ?? conformance.commit,
      patchSeriesSha256: options.patchSeriesSha256 ?? conformance.patchSeriesSha256,
    },
    build: {
      source: 'native-platform-build',
      platform: options.platform ?? 'macos-arm64',
      entrypoint: 'qlever/scripts/build-macos-local-runtime.sh',
    },
    artifacts: [ {
      path: 'bin/xpod_qlever_local_runtime',
      sha256: options.declaredRuntimeSha256 ?? sha256(runtime),
      size: runtime.length,
    } ],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(root, 'manifest.json'), manifestBytes);
  const archive = path.join(tempRoot, `qlever-local-runtime-${label}.tar.gz`);
  execFileSync('tar', [ '-czf', archive, '-C', root, '.' ]);
  return { archive, runtime, manifest, manifestBytes };
}

// Hand-craft evidence that matches an archive byte-for-byte (even when the
// archive is internally consistent but violates the source ABI/pin contract).
function craftQleverEvidence(archive: QleverArchive, sourceSha: string, outFile: string): string {
  const archiveBytes = readFileSync(archive.archive);
  writeFileSync(outFile, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'qlever-local-acceptance',
    ok: true,
    sourceSha,
    platform: 'macos-arm64',
    smoke: { command: 'test', completed: true },
    archive: { name: path.basename(archive.archive), sha256: sha256(archiveBytes), size: archiveBytes.length },
    runtime: { member: 'bin/xpod_qlever_local_runtime', sha256: sha256(archive.runtime), size: archive.runtime.length },
    manifest: {
      sha256: sha256(archive.manifestBytes),
      adapterAbiVersion: archive.manifest.adapterAbiVersion,
      physicalBackendAbiVersion: archive.manifest.physicalBackendAbiVersion,
      platform: archive.manifest.build.platform,
      qlever: { ...archive.manifest.qlever },
    },
  }, null, 2)}\n`);
  return outFile;
}

interface GateRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Execute the exact multi-line command the workflow step runs (including its
// shell continuations) instead of a hand-copied argument list.
function workflowGateCommand(step: { run?: string } | undefined, command: string): string {
  const lines = (step?.run ?? '').split('\n');
  const start = lines.findIndex(line => line.includes(`scripts/release-gate-evidence.cjs ${command}`));
  expect(start, `workflow step must run ${command}`).toBeGreaterThanOrEqual(0);
  const block: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    block.push(lines[index]);
    if (!lines[index].trimEnd().endsWith('\\')) break;
  }
  return block.join('\n');
}

function runGate(script: string, env: Record<string, string>): GateRun {
  const result = spawnSync('/bin/bash', [ '-c', `set -euo pipefail\n${script}` ], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// Stage an existing archive under the cache root layout the workflow reuses:
// the archive takes the producer's canonical basename and its evidence sits
// beside it, exactly as the upload/cache step would restore it.
function stageCachedRuntime(archive: QleverArchive, target: string): { runtimeRoot: string; archive: QleverArchive } {
  const runtimeRoot = mkdtempSync(path.join(tempRoot, `cache-${target}-`));
  const staged = path.join(runtimeRoot, `qlever-local-runtime-${target}.tar.gz`);
  renameSync(archive.archive, staged);
  return { runtimeRoot, archive: { ...archive, archive: staged } };
}

describe('qlever-local gate evidence', () => {
  it('binds explicit Linux target evidence and rejects verification under a different target', () => {
    const archive = makeQleverArchive('linux-target', { platform: 'linux-x64' });
    const out = path.join(tempRoot, 'qlever-linux.json');
    run([ 'create-qlever-local', '--source-sha', 'a'.repeat(40), '--archive', archive.archive, '--abi-platform', 'linux-x64', '--out', out ]);
    const evidence = JSON.parse(readFileSync(out, 'utf8'));
    expect(evidence.platform).toBe('linux-x64');
    expect(evidence.manifest.platform).toBe('linux-x64');
    const checks = path.join(tempRoot, 'qlever-linux-checks.json');
    run([ 'verify-qlever-local', '--evidence', out, '--source-sha', 'a'.repeat(40), '--expected-archive', archive.archive, '--abi-platform', 'linux-x64', '--checks-out', checks ]);
    expect(readChecks(checks)).toEqual({ 'qlever-local': 'passed' });
    expectFailure([ 'verify-qlever-local', '--evidence', out, '--source-sha', 'a'.repeat(40), '--expected-archive', archive.archive ]);
    expectFailure([ 'verify-qlever-local', '--evidence', out, '--source-sha', 'a'.repeat(40), '--expected-archive', archive.archive, '--abi-platform', 'linux-arm64' ]);
    evidence.manifest.platform = 'linux-arm64';
    const crossManifest = path.join(tempRoot, 'qlever-linux-cross-manifest.json');
    writeFileSync(crossManifest, JSON.stringify(evidence));
    expectFailure([ 'verify-qlever-local', '--evidence', crossManifest, '--source-sha', 'a'.repeat(40), '--expected-archive', archive.archive, '--abi-platform', 'linux-x64' ]);
  });

  it('binds a source-conformant runtime archive and verifies it against the downloaded bytes', () => {
    const archive = makeQleverArchive('valid');
    const out = path.join(tempRoot, 'qlever-valid.json');
    run([ 'create-qlever-local', '--source-sha', 'a'.repeat(40), '--archive', archive.archive, '--abi-platform', 'macos-arm64', '--out', out ]);
    const evidence = JSON.parse(readFileSync(out, 'utf8'));
    expect(evidence).toMatchObject({ kind: 'qlever-local-acceptance', ok: true, sourceSha: 'a'.repeat(40) });
    expect(evidence.manifest.adapterAbiVersion).toBe(conformance.adapterAbiVersion);

    const checks = path.join(tempRoot, 'qlever-valid-checks.json');
    run([ 'verify-qlever-local', '--evidence', out, '--source-sha', 'a'.repeat(40), '--expected-archive', archive.archive, '--checks-out', checks ]);
    expect(readChecks(checks)).toEqual({ 'qlever-local': 'passed' });
  });

  it('rejects a self-consistent archive whose ABI or QLever pin does not match the checked-out source', () => {
    const wrongAbi = makeQleverArchive('wrong-abi', {
      adapterAbiVersion: conformance.adapterAbiVersion + 1,
      physicalBackendAbiVersion: conformance.physicalBackendAbiVersion + 1,
    });
    expectFailure([ 'create-qlever-local', '--source-sha', 'a'.repeat(40), '--archive', wrongAbi.archive, '--out', path.join(tempRoot, 'wrong-abi-create.json') ]);
    const wrongAbiEvidence = craftQleverEvidence(wrongAbi, 'a'.repeat(40), path.join(tempRoot, 'wrong-abi-evidence.json'));
    expectFailure([ 'verify-qlever-local', '--evidence', wrongAbiEvidence, '--source-sha', 'a'.repeat(40), '--expected-archive', wrongAbi.archive ]);

    const wrongPin = makeQleverArchive('wrong-pin', { commit: 'f'.repeat(40), patchSeriesSha256: 'e'.repeat(64) });
    expectFailure([ 'create-qlever-local', '--source-sha', 'a'.repeat(40), '--archive', wrongPin.archive, '--out', path.join(tempRoot, 'wrong-pin-create.json') ]);
    const wrongPinEvidence = craftQleverEvidence(wrongPin, 'a'.repeat(40), path.join(tempRoot, 'wrong-pin-evidence.json'));
    expectFailure([ 'verify-qlever-local', '--evidence', wrongPinEvidence, '--source-sha', 'a'.repeat(40), '--expected-archive', wrongPin.archive ]);
  });

  it('rejects a manifest whose declared runtime digest disagrees with the real runtime bytes', () => {
    const archive = makeQleverArchive('manifest-digest', { declaredRuntimeSha256: 'f'.repeat(64) });
    // create refuses it, so hand-craft evidence that still matches the archive outer bytes.
    expectFailure([ 'create-qlever-local', '--source-sha', 'a'.repeat(40), '--archive', archive.archive, '--out', path.join(tempRoot, 'manifest-digest-create.json') ]);
    const evidence = craftQleverEvidence(archive, 'a'.repeat(40), path.join(tempRoot, 'manifest-digest-evidence.json'));
    expectFailure([ 'verify-qlever-local', '--evidence', evidence, '--source-sha', 'a'.repeat(40), '--expected-archive', archive.archive ]);
  });

  it('fails closed on wrong SHA, tampered archive, foreign platform and missing evidence', () => {
    const archive = makeQleverArchive('base');
    const out = path.join(tempRoot, 'qlever-base.json');
    run([ 'create-qlever-local', '--source-sha', 'a'.repeat(40), '--archive', archive.archive, '--out', out ]);
    expectFailure([ 'verify-qlever-local', '--evidence', out, '--source-sha', 'd'.repeat(40), '--expected-archive', archive.archive ]);

    const tampered = path.join(tempRoot, 'qlever-tampered.tar.gz');
    writeFileSync(tampered, Buffer.concat([ readFileSync(archive.archive), Buffer.from('x') ]));
    expectFailure([ 'verify-qlever-local', '--evidence', out, '--source-sha', 'a'.repeat(40), '--expected-archive', tampered ]);
    expectFailure([ 'verify-qlever-local', '--evidence', path.join(tempRoot, 'missing.json'), '--source-sha', 'a'.repeat(40), '--expected-archive', archive.archive ]);

    const foreign = makeQleverArchive('foreign', { platform: 'linux-x64' });
    expectFailure([ 'create-qlever-local', '--source-sha', 'a'.repeat(40), '--archive', foreign.archive, '--out', path.join(tempRoot, 'foreign.json') ]);
  });

  // The cached reuse step must verify the evidence against the same resolved
  // macOS target its producer wrote, for both architectures the catalog
  // supports. These execute the real workflow command against real archives.
  it('executes the cached-verification workflow command for the resolved x64 and arm64 targets', () => {
    const workflow = parseDocument(readFileSync(path.join(repoRoot,
      '.github/workflows/build-qlever-macos-runtime.yml'), 'utf8')).toJSON();
    const reuse = workflow.jobs.build.steps.find((step: { name?: string }) =>
      step.name === 'Verify and smoke the reused native runtime');
    const command = workflowGateCommand(reuse, 'verify-qlever-local');
    const sourceSha = 'b'.repeat(40);
    for (const [ target, platform ] of [
      [ 'darwin-x64', 'macos-x64' ],
      [ 'darwin-arm64', 'macos-arm64' ],
    ] as const) {
      const archive = makeQleverArchive(`cache-${target}`, { platform });
      const staged = stageCachedRuntime(archive, target);
      try {
        const evidence = path.join(staged.runtimeRoot, 'qlever-local-acceptance.json');
        run([ 'create-qlever-local', '--source-sha', sourceSha, '--archive', staged.archive.archive,
          '--abi-platform', platform, '--out', evidence ]);
        const resolved = command
          .replaceAll('${{ needs.resolve.outputs.target }}', target)
          .replaceAll('${{ needs.resolve.outputs.arch }}', platform.slice('macos-'.length));
        const passed = runGate(`prior_source=${sourceSha}\n${resolved}`, { RUNTIME_ROOT: staged.runtimeRoot });
        expect(passed.status, `${target} verification command`).toBe(0);
        expect(passed.stderr).not.toContain('[release-gate-evidence]');
        expect(JSON.parse(passed.stdout.trim())).toEqual({ valid: true, 'qlever-local': 'passed' });
      } finally {
        rmSync(staged.runtimeRoot, { recursive: true, force: true });
      }
    }
  });

  // A cached x64 runtime verified against the defaulted arm64 expectation must
  // still be refused: passing the resolved target must not weaken the check.
  it('refuses a cached x64 runtime when the workflow command expects arm64', () => {
    const workflow = parseDocument(readFileSync(path.join(repoRoot,
      '.github/workflows/build-qlever-macos-runtime.yml'), 'utf8')).toJSON();
    const reuse = workflow.jobs.build.steps.find((step: { name?: string }) =>
      step.name === 'Verify and smoke the reused native runtime');
    const command = workflowGateCommand(reuse, 'verify-qlever-local');
    const sourceSha = 'b'.repeat(40);
    const staged = stageCachedRuntime(makeQleverArchive('cache-x64-refused', { platform: 'macos-x64' }), 'darwin-x64');
    try {
      run([ 'create-qlever-local', '--source-sha', sourceSha, '--archive', staged.archive.archive,
        '--abi-platform', 'macos-x64', '--out', path.join(staged.runtimeRoot, 'qlever-local-acceptance.json') ]);
      const wrong = command
        .replaceAll('${{ needs.resolve.outputs.target }}', 'darwin-x64')
        .replaceAll('${{ needs.resolve.outputs.arch }}', 'arm64');
      const refused = runGate(`prior_source=${sourceSha}\n${wrong}`, { RUNTIME_ROOT: staged.runtimeRoot });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain('evidence platform must be macos-arm64');
      expect(refused.stdout).not.toContain('passed');
    } finally {
      rmSync(staged.runtimeRoot, { recursive: true, force: true });
    }
  });
});

interface PackageFixture {
  sourceSha: string;
  archiveDir: string;
  workspaceEvidence: string;
  unified: string;
  createArgs: string[];
}

function makePackageFixture(label: string, options: {
  workspaceOk?: boolean;
  workspaceSourceSha?: string;
  dropWorkspaceFile?: boolean;
  tamperWorkspaceHash?: boolean;
  packIntegrityMismatch?: boolean;
  directoryPackageNames?: boolean;
} = {}): PackageFixture {
  const sourceSha = 'c'.repeat(40);
  const root = mkdtempSync(path.join(tempRoot, `consumer-${label}-`));
  const packDir = path.join(root, 'pack');
  mkdirSync(packDir, { recursive: true });
  const rootName = 'undefineds.co-xpod-0.4.22.tgz';
  const rootBytes = Buffer.from('packed-root-tarball');
  writeFileSync(path.join(packDir, rootName), rootBytes);
  const integrity = sha512(rootBytes);
  const packJson = path.join(packDir, 'pack.json');
  writeFileSync(packJson, JSON.stringify([ {
    filename: rootName,
    name: '@undefineds.co/xpod',
    version: '0.4.22',
    integrity: options.packIntegrityMismatch ? `sha512-${'a'.repeat(86)}==` : integrity,
    size: rootBytes.length,
  } ]));

  const resultPath = path.join(root, 'result.json');
  writeFileSync(resultPath, JSON.stringify({ name: '@undefineds.co/xpod', version: '0.4.22', integrity, passed: true }));

  const archiveDir = path.join(root, 'package-consumer-archive');
  const workspaceDir = path.join(archiveDir, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  // Mirror the real producer: `packageName` is the scoped npm name and `name`
  // is the tarball basename, not the `packages/<dir>` workspace directory.
  const packages = (options.directoryPackageNames ? PACKAGES : loadWorkspacePackageNames()).map((packageName) => {
    const name = `${packageName.replace('@', '').replace('/', '-')}-0.1.0.tgz`;
    const bytes = Buffer.from(`workspace-${packageName}`);
    writeFileSync(path.join(workspaceDir, name), bytes);
    return { packageName, name, sha256: sha256(bytes), size: bytes.length };
  });
  const workspaceEvidencePath = path.join(root, 'workspace-consumer-evidence.json');
  writeFileSync(workspaceEvidencePath, JSON.stringify({
    schemaVersion: 1,
    kind: 'workspace-consumer-acceptance',
    ok: options.workspaceOk ?? true,
    sourceSha: options.workspaceSourceSha ?? sourceSha,
    packages: options.tamperWorkspaceHash ? [ { ...packages[0], sha256: 'f'.repeat(64) }, ...packages.slice(1) ] : packages,
  }, null, 2));
  if (options.dropWorkspaceFile) rmSync(path.join(workspaceDir, packages[0].name));

  const unified = path.join(root, 'package-consumer-evidence.json');
  const createArgs = [
    'create-package-consumers',
    '--source-sha', sourceSha,
    '--pack-json', packJson,
    '--node-result', resultPath,
    '--bun-result', resultPath,
    '--workspace-evidence', workspaceEvidencePath,
    '--archive-dir', archiveDir,
    '--out', unified,
  ];
  return { sourceSha, archiveDir, workspaceEvidence: workspaceEvidencePath, unified, createArgs };
}

describe('package-consumers gate evidence', () => {
  it('binds the exact consumed workspace tarballs and the real root consumers', () => {
    const fixture = makePackageFixture('valid');
    run(fixture.createArgs);
    const evidence = JSON.parse(readFileSync(fixture.unified, 'utf8'));
    expect(evidence.workspaceResult).toMatchObject({ kind: 'workspace-consumer-acceptance', ok: true, sourceSha: fixture.sourceSha });
    expect(evidence.workspaceArchives).toHaveLength(PACKAGES.length);

    const checks = path.join(tempRoot, 'consumer-valid-checks.json');
    run([ 'verify-package-consumers', '--evidence', fixture.unified, '--source-sha', fixture.sourceSha, '--archive-dir', fixture.archiveDir, '--checks-out', checks ]);
    expect(readChecks(checks)).toEqual({ 'package-consumers': 'passed' });
  });

  it('requires the scoped package names the producer emits, not workspace directory names', () => {
    const names = loadWorkspacePackageNames();
    expect(names).toHaveLength(PACKAGES.length);
    expect(names).toContain('@undefineds.co/solid-sdk');
    expectFailure(makePackageFixture('directory-names', { directoryPackageNames: true }).createArgs);
  });

  it('refuses to emit evidence when the real workspace consumer failed, is mismatched or lost bytes', () => {
    expectFailure(makePackageFixture('ws-failed', { workspaceOk: false }).createArgs);
    expectFailure(makePackageFixture('ws-sha', { workspaceSourceSha: 'd'.repeat(40) }).createArgs);
    expectFailure(makePackageFixture('ws-drop', { dropWorkspaceFile: true }).createArgs);
    expectFailure(makePackageFixture('ws-hash', { tamperWorkspaceHash: true }).createArgs);
    expectFailure(makePackageFixture('pack-mismatch', { packIntegrityMismatch: true }).createArgs);
  });

  it('verifier rejects a failed or missing workspace result and a substituted workspace archive', () => {
    const fixture = makePackageFixture('negatives');
    run(fixture.createArgs);

    const failedResult = path.join(tempRoot, 'failed-workspace-result.json');
    const failedEvidence = JSON.parse(readFileSync(fixture.unified, 'utf8'));
    failedEvidence.workspaceResult.ok = false;
    writeFileSync(failedResult, JSON.stringify(failedEvidence));
    expectFailure([ 'verify-package-consumers', '--evidence', failedResult, '--source-sha', fixture.sourceSha, '--archive-dir', fixture.archiveDir ]);

    const missingResult = path.join(tempRoot, 'missing-workspace-result.json');
    const missingEvidence = JSON.parse(readFileSync(fixture.unified, 'utf8'));
    delete missingEvidence.workspaceResult;
    writeFileSync(missingResult, JSON.stringify(missingEvidence));
    expectFailure([ 'verify-package-consumers', '--evidence', missingResult, '--source-sha', fixture.sourceSha, '--archive-dir', fixture.archiveDir ]);

    const substituted = makePackageFixture('substituted');
    run(substituted.createArgs);
    const substitutedEvidence = JSON.parse(readFileSync(substituted.unified, 'utf8'));
    const victim = path.join(substituted.archiveDir, 'workspace', substitutedEvidence.workspaceArchives[0].name);
    writeFileSync(victim, Buffer.from('substituted-workspace-bytes'));
    expectFailure([ 'verify-package-consumers', '--evidence', substituted.unified, '--source-sha', substituted.sourceSha, '--archive-dir', substituted.archiveDir ]);
  });
});
