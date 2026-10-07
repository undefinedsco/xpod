import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
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
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'xpod-gate-evidence-'));
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

describe('qlever-local gate evidence', () => {
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
