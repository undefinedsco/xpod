import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MANIFEST_SCHEMA_VERSION,
  XPOD_CLI_PACKAGE,
  publicGateProblems,
  isPublicReleaseReady,
  sha256File,
  sha256Hex,
  type ManifestArtifact,
  type XpodCliManifest,
} from '../src/manifest';
import {
  ACCEPTANCE_REPORT_SCHEMA_VERSION,
  PROMOTION_EVIDENCE_SCHEMA_VERSION,
  SOURCE_DISTRIBUTION_NOTES,
  buildPromotionRecord,
  derivePromotedManifest,
  isPathWithin,
  manifestContentSha256,
  promotionPathOverlapProblems,
  validateAcceptanceReports,
  validatePromotionEvidence,
  type PromotionEvidence,
} from '../src/promotion';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const tempRoot = path.join(repo, '.test-data', 'xpod-cli-promotion');
mkdirSync(tempRoot, { recursive: true });
const work = mkdtempSync(path.join(tempRoot, 'case-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const PLATFORM = 'darwin-arm64';
const SOURCE_SHA = 'a'.repeat(40);
const sha = (c: string): string => c.repeat(64);
const reviewSha = (c: string): string => c.repeat(64);

function artifact(
  name: string,
  kind: ManifestArtifact['kind'],
  relPath: string,
  digest: string,
  license: ManifestArtifact['license'],
): ManifestArtifact {
  return { name, kind, path: relPath, sha256: digest, sizeBytes: 64, included: true, license };
}

function candidateManifest(): XpodCliManifest {
  const pending = (spdx: string | null): ManifestArtifact['license'] => ({ spdx, status: 'pending', source: 'build output pending review' });
  const artifacts: ManifestArtifact[] = [
    artifact('xpodcli', 'cli', 'lib/xpodcli.mjs', sha('2'), pending(null)),
    artifact('xpodcli-launcher', 'cli', 'bin/xpodcli', sha('3'), pending('MIT')),
    artifact('agentfs-pod', 'native-helper', 'helper/agentfs-pod', sha('1'), pending('MIT')),
    artifact('native-declaration:index.json', 'notice', 'licenses/native/declarations/index.json', sha('4'), pending(null)),
    artifact('application-source.json', 'source', 'sources/application-source.json', sha('5'), pending(null)),
    artifact('application-source.tar.gz', 'source', 'sources/application-source.tar.gz', sha('6'), pending(null)),
    artifact('native-source.json', 'source', 'sources/native-source.json', sha('7'), pending(null)),
    artifact('native-source-build.json', 'source', 'sources/native-source-build.json', sha('8'), pending(null)),
    artifact('native-source.tar.gz', 'source', 'sources/native-source.tar.gz', sha('9'), pending(null)),
  ];
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    package: XPOD_CLI_PACKAGE,
    version: '0.1.0-preview.1',
    channel: 'preview',
    platform: PLATFORM,
    distribution: 'external-runtime',
    sourceSHA: SOURCE_SHA,
    dirtyTreeHash: null,
    source: { mode: 'release', commit: SOURCE_SHA, dirty: false },
    selectedEnginePin: {
      engine: 'agentfs',
      repository: 'https://github.com/tursodatabase/agentfs',
      commit: 'b'.repeat(40),
      sdkLicenseStatus: 'verified',
      cliLicenseStatus: 'verified',
      rootLicensePresent: false,
      licenseEvidence: { path: 'licenses/native/declarations/index.json', sha256: sha('4') },
    },
    artifacts,
    validationState: 'install-verified',
    generatedAt: '2026-10-02T00:00:00.000Z',
    notes: [ 'preview candidate' ],
  };
}

function byPath(manifest: XpodCliManifest, relative: string): ManifestArtifact {
  return manifest.artifacts.find((entry) => entry.path === relative)!;
}

function byName(manifest: XpodCliManifest, name: string): ManifestArtifact {
  return manifest.artifacts.find((entry) => entry.name === name)!;
}

function validEvidence(manifest: XpodCliManifest): PromotionEvidence {
  return {
    schemaVersion: PROMOTION_EVIDENCE_SCHEMA_VERSION,
    candidate: {
      manifestSha256: manifestContentSha256(manifest),
      platform: manifest.platform,
      sourceSHA: manifest.sourceSHA!,
      engine: {
        engine: manifest.selectedEnginePin.engine,
        repository: manifest.selectedEnginePin.repository,
        commit: manifest.selectedEnginePin.commit,
      },
    },
    reviews: manifest.artifacts.filter((entry) => entry.included).map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      path: entry.path!,
      sha256: entry.sha256!,
      // Mixed/assembled artifacts stay null; no blanket MIT labels.
      spdx: entry.kind === 'source' || entry.kind === 'native-helper' ? null : (entry.name.includes('launcher') ? 'MIT' : null),
      status: 'verified' as const,
      provenance: `reviewed actual ${entry.kind} bytes of ${entry.name}`,
    })),
    nativeTest: {
      target: manifest.platform,
      receiptSha256: byPath(manifest, 'sources/native-source-build.json').sha256!,
      sourceKitSha256: byPath(manifest, 'sources/native-source.json').sha256!,
      helperSha256: byName(manifest, 'agentfs-pod').sha256!,
      compiler: { toolchain: 'nightly-2025-01-01', cargoSha256: sha('c'), rustcSha256: sha('d') },
      testsPassed: true,
      testsFailed: 0,
      testsIgnored: 0,
    },
    installedAcceptance: {
      target: manifest.platform,
      backend: 'nfs',
      executedOnTarget: true,
      cliSha256: byName(manifest, 'xpodcli').sha256!,
      launcherSha256: byName(manifest, 'xpodcli-launcher').sha256!,
      helperSha256: byName(manifest, 'agentfs-pod').sha256!,
      reportSha256: reviewSha('e'),
      realMountScenariosPassed: 2,
      mountScenariosFailed: 0,
      informationalSkips: 1,
      lifecycleProven: true,
      cleanedOwnedResources: true,
    },
    gatewayAcceptance: {
      target: manifest.platform,
      sourceSHA: manifest.sourceSHA!,
      proofKind: 'live-gateway',
      canonicalPodWrite: true,
      storageBindingValidated: true,
      success: true,
      sanitized: true,
      reportSha256: reviewSha('f'),
    },
    notes: [ 'structured, fixture-free acceptance' ],
  };
}

function problemsFor(mutate: (evidence: PromotionEvidence, manifest: XpodCliManifest) => void): string[] {
  const manifest = candidateManifest();
  const evidence = validEvidence(manifest);
  mutate(evidence, manifest);
  return validatePromotionEvidence({ manifest, manifestSha256: manifestContentSha256(manifest), evidence });
}

describe('validatePromotionEvidence', () => {
  test('accepts a complete normalized proof and derives a public-ready promoted manifest', () => {
    const manifest = candidateManifest();
    const evidence = validEvidence(manifest);
    expect(validatePromotionEvidence({ manifest, manifestSha256: manifestContentSha256(manifest), evidence })).toEqual([]);

    const promoted = derivePromotedManifest(manifest, evidence);
    expect(publicGateProblems(promoted)).toEqual([]);
    expect(isPublicReleaseReady(promoted)).toBe(true);
    for (const note of SOURCE_DISTRIBUTION_NOTES) expect(promoted.notes).toContain(note);
    expect(promoted.channel).toBe('preview');
    expect(promoted.validationState).toBe('full-verified');
    for (const entry of promoted.artifacts.filter((item) => item.included)) {
      expect(entry.license.status).toBe('verified');
    }
    // The original candidate is untouched and still blocked by the ordinary gate.
    expect(publicGateProblems(manifest).length > 0).toBe(true);
    expect(byName(manifest, 'agentfs-pod').license.status).toBe('pending');
  });

  test('rejects dirty/local source identities and mismatched source provenance', () => {
    const manifest = candidateManifest();
    manifest.source = { mode: 'local-preview', commit: SOURCE_SHA, dirty: true };
    manifest.dirtyTreeHash = sha('d');
    manifest.channel = 'local-preview';
    const dirtyEvidence = validEvidence(manifest);
    const dirty = validatePromotionEvidence({ manifest, manifestSha256: manifestContentSha256(manifest), evidence: dirtyEvidence });
    expect(dirty.some((problem) => problem.includes('dirty'))).toBe(true);
    expect(dirty.some((problem) => problem.includes('local-preview'))).toBe(true);
    expect(dirty.some((problem) => problem.includes('dirtyTreeHash'))).toBe(true);

    expect(problemsFor((evidence) => { evidence.candidate.sourceSHA = '0'.repeat(40); })
      .some((problem) => problem.includes('sourceSHA'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.candidate.manifestSha256 = sha('0'); })
      .some((problem) => problem.includes('manifest hash'))).toBe(true);
  });

  test('rejects wrong target and wrong engine pin', () => {
    expect(problemsFor((evidence) => { evidence.candidate.engine.commit = '0'.repeat(40); })
      .some((problem) => problem.includes('engine pin'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.nativeTest.target = 'linux-arm64'; })
      .some((problem) => problem.includes('native test target'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.installedAcceptance.target = 'linux-arm64'; })
      .some((problem) => problem.includes('installed acceptance target'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.gatewayAcceptance.target = 'linux-arm64'; })
      .some((problem) => problem.includes('gateway acceptance target'))).toBe(true);
  });

  test('rejects payload drift, incomplete, duplicate and unexpected reviews', () => {
    expect(problemsFor((evidence) => { evidence.reviews[0].sha256 = sha('0'); })
      .some((problem) => problem.includes('reviewed bytes changed'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.reviews.splice(2, 1); })
      .some((problem) => problem.includes('missing review'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.reviews.push({ ...evidence.reviews[0] }); })
      .some((problem) => problem.includes('duplicate review'))).toBe(true);
    expect(problemsFor((evidence) => {
      evidence.reviews.push({ ...evidence.reviews[0], name: 'ghost-artifact', path: 'ghost' });
    }).some((problem) => problem.includes('unexpected review'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.reviews[0].provenance = ''; })
      .some((problem) => problem.includes('provenance'))).toBe(true);
  });

  test('rejects untested or mismatched native receipts', () => {
    expect(problemsFor((evidence) => { evidence.nativeTest.testsPassed = false; })
      .some((problem) => problem.includes('native tests did not all pass'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.nativeTest.testsFailed = 1; })
      .some((problem) => problem.includes('native tests did not all pass'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.nativeTest.receiptSha256 = sha('0'); })
      .some((problem) => problem.includes('receipt does not match'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.nativeTest.sourceKitSha256 = sha('0'); })
      .some((problem) => problem.includes('source kit does not match'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.nativeTest.helperSha256 = sha('0'); })
      .some((problem) => problem.includes('helper does not match'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.nativeTest.compiler.toolchain = 'stable'; })
      .some((problem) => problem.includes('compiler identity'))).toBe(true);
  });

  test('rejects stale mounted artifact hashes and unproven target execution', () => {
    expect(problemsFor((evidence) => { evidence.installedAcceptance.cliSha256 = sha('0'); })
      .some((problem) => problem.includes('installed acceptance CLI hash'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.installedAcceptance.launcherSha256 = sha('0'); })
      .some((problem) => problem.includes('launcher hash'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.installedAcceptance.helperSha256 = sha('0'); })
      .some((problem) => problem.includes('helper hash'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.installedAcceptance.executedOnTarget = false; })
      .some((problem) => problem.includes('not executed on the target'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.installedAcceptance.realMountScenariosPassed = 0; })
      .some((problem) => problem.includes('real mount scenarios'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.installedAcceptance.cleanedOwnedResources = false; })
      .some((problem) => problem.includes('cleaned owned resources'))).toBe(true);
  });

  test('rejects fixture-only, unsanitized or missing live Gateway proof', () => {
    expect(problemsFor((evidence) => { (evidence.gatewayAcceptance as { proofKind: string }).proofKind = 'fixture'; })
      .some((problem) => problem.includes('live-gateway'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.gatewayAcceptance.sanitized = false; })
      .some((problem) => problem.includes('not sanitized'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.gatewayAcceptance.canonicalPodWrite = false; })
      .some((problem) => problem.includes('canonical Pod write'))).toBe(true);
    expect(problemsFor((evidence) => { evidence.gatewayAcceptance.sourceSHA = '0'.repeat(40); })
      .some((problem) => problem.includes('gateway acceptance source provenance'))).toBe(true);
    const missing = problemsFor((evidence) => { delete (evidence as Partial<PromotionEvidence>).gatewayAcceptance; });
    expect(missing.some((problem) => problem.includes('gatewayAcceptance'))).toBe(true);
  });

  test('derives without a review fails closed', () => {
    const manifest = candidateManifest();
    const evidence = validEvidence(manifest);
    evidence.reviews.splice(0, 1);
    expect(() => derivePromotedManifest(manifest, evidence)).toThrow('without a review');
  });

  test('builds a sanitized hash-bound promotion record', () => {
    const manifest = candidateManifest();
    const evidence = validEvidence(manifest);
    const promoted = derivePromotedManifest(manifest, evidence);
    const record = buildPromotionRecord({
      candidateManifestSha256: manifestContentSha256(manifest),
      promotedManifest: promoted,
      evidence,
      evidenceSha256: sha('a'),
      publicGateProblems: [],
      gatewayIdentity: { url: 'https://gateway.example', serverIdentity: 'gateway-rc-1' },
      promotedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(record.sanitized).toBe(true);
    for (const note of SOURCE_DISTRIBUTION_NOTES) expect(record.notes).toContain(note);
    expect(record.publicReleaseReady).toBe(true);
    expect(record.promotedManifestSha256).toBe(manifestContentSha256(promoted));
    expect(record.candidateManifestSha256).toBe(manifestContentSha256(manifest));
    expect(record.gatewayAcceptance.gateway).toEqual({ url: 'https://gateway.example', serverIdentity: 'gateway-rc-1' });
    expect(JSON.stringify(record)).not.toContain('secret');
  });
});

function acceptanceReport(manifest: XpodCliManifest, evidence: PromotionEvidence): Record<string, unknown> {
  return {
    schemaVersion: ACCEPTANCE_REPORT_SCHEMA_VERSION,
    sourceSHA: manifest.sourceSHA,
    installedAcceptance: {
      target: manifest.platform,
      backend: 'nfs',
      executedOnTarget: true,
      client: {
        cliSha256: evidence.installedAcceptance.cliSha256,
        launcherSha256: evidence.installedAcceptance.launcherSha256,
        helperSha256: evidence.installedAcceptance.helperSha256,
      },
      lifecycle: {
        realMountScenariosPassed: evidence.installedAcceptance.realMountScenariosPassed,
        mountScenariosFailed: 0,
        informationalSkips: evidence.installedAcceptance.informationalSkips,
        lifecycleProven: true,
        cleanedOwnedResources: true,
      },
    },
    gatewayAcceptance: {
      target: manifest.platform,
      proofKind: 'live-gateway',
      sourceSHA: manifest.sourceSHA,
      canonicalPodWrite: true,
      storageBindingValidated: true,
      success: true,
      sanitized: true,
      gateway: { url: 'https://gateway.example', serverIdentity: 'gateway-rc-1' },
    },
  };
}

function reportBytes(report: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function bindReportHashes(evidence: PromotionEvidence, hash: string): void {
  evidence.installedAcceptance.reportSha256 = hash;
  evidence.gatewayAcceptance.reportSha256 = hash;
}

/** Validate a report whose bytes are re-bound to the (mutated) report content. */
function reportProblemsFor(mutate: (report: any, evidence: PromotionEvidence) => void = () => undefined): string[] {
  const manifest = candidateManifest();
  const evidence = validEvidence(manifest);
  const report = acceptanceReport(manifest, evidence) as any;
  mutate(report, evidence);
  const hash = sha256Hex(reportBytes(report));
  bindReportHashes(evidence, hash);
  return validateAcceptanceReports({
    manifest,
    evidence,
    installedReport: report,
    installedReportSha256: hash,
    gatewayReport: report,
    gatewayReportSha256: hash,
  });
}

describe('acceptance reports (explicit sanitized bytes, same file may serve both inputs)', () => {
  test('accepts a report that binds the candidate and evidence facts', () => {
    const manifest = candidateManifest();
    const evidence = validEvidence(manifest);
    const report = acceptanceReport(manifest, evidence);
    const hash = sha256Hex(reportBytes(report));
    bindReportHashes(evidence, hash);
    expect(validateAcceptanceReports({
      manifest,
      evidence,
      installedReport: report,
      installedReportSha256: hash,
      gatewayReport: report,
      gatewayReportSha256: hash,
    })).toEqual([]);
  });

  test('rejects absent, non-object, stale and mismatched-hash reports', () => {
    const manifest = candidateManifest();
    const evidence = validEvidence(manifest);
    const report = acceptanceReport(manifest, evidence);
    const hash = sha256Hex(reportBytes(report));
    bindReportHashes(evidence, hash);

    expect(validateAcceptanceReports({
      manifest, evidence, installedReport: null, installedReportSha256: hash,
      gatewayReport: report, gatewayReportSha256: hash,
    }).some((problem) => problem.includes('not an object'))).toBe(true);

    expect(validateAcceptanceReports({
      manifest, evidence, installedReport: report, installedReportSha256: sha('0'),
      gatewayReport: report, gatewayReportSha256: hash,
    }).some((problem) => problem.includes('stale or wrong file'))).toBe(true);

    expect(validateAcceptanceReports({
      manifest, evidence, installedReport: report, installedReportSha256: hash,
      gatewayReport: report, gatewayReportSha256: sha('0'),
    }).some((problem) => problem.includes('stale or wrong file'))).toBe(true);
  });

  test('rejects missing sections, wrong client identity and unbound source', () => {
    expect(reportProblemsFor((report) => { delete report.installedAcceptance; })
      .some((problem) => problem.includes('lacks its installedAcceptance facts'))).toBe(true);
    expect(reportProblemsFor((report) => { delete report.gatewayAcceptance; })
      .some((problem) => problem.includes('lacks its gatewayAcceptance facts'))).toBe(true);
    expect(reportProblemsFor((report) => { report.installedAcceptance.client.cliSha256 = sha('0'); })
      .some((problem) => problem.includes('cliSha256 does not match'))).toBe(true);
    expect(reportProblemsFor((report) => { report.sourceSHA = '0'.repeat(40); })
      .some((problem) => problem.includes('does not bind the candidate client source'))).toBe(true);
    expect(reportProblemsFor((report) => { report.gatewayAcceptance.sourceSHA = '0'.repeat(40); })
      .some((problem) => problem.includes('does not bind the candidate client source'))).toBe(true);
    expect(reportProblemsFor((report) => { report.installedAcceptance.target = 'linux-arm64'; })
      .some((problem) => problem.includes('target does not match the candidate platform'))).toBe(true);
  });

  test('rejects fixture gateway proof and unproven lifecycle/live facts', () => {
    expect(reportProblemsFor((report) => { report.gatewayAcceptance.proofKind = 'fixture'; })
      .some((problem) => problem.includes('fixtures are rejected'))).toBe(true);
    expect(reportProblemsFor((report) => { report.gatewayAcceptance.canonicalPodWrite = false; })
      .some((problem) => problem.includes('canonical Pod write'))).toBe(true);
    expect(reportProblemsFor((report) => { report.gatewayAcceptance.storageBindingValidated = false; })
      .some((problem) => problem.includes('storage binding'))).toBe(true);
    expect(reportProblemsFor((report) => { report.gatewayAcceptance.sanitized = false; })
      .some((problem) => problem.includes('not sanitized'))).toBe(true);
    expect(reportProblemsFor((report) => { report.installedAcceptance.lifecycle.lifecycleProven = false; })
      .some((problem) => problem.includes('mounting/lifecycle'))).toBe(true);
    expect(reportProblemsFor((report) => { report.installedAcceptance.lifecycle.cleanedOwnedResources = false; })
      .some((problem) => problem.includes('cleaned owned resources'))).toBe(true);
    expect(reportProblemsFor((report) => { report.installedAcceptance.lifecycle.realMountScenariosPassed = 0; })
      .some((problem) => problem.includes('real mount scenarios'))).toBe(true);
    expect(reportProblemsFor((report) => { report.installedAcceptance.lifecycle.mountScenariosFailed = 1; })
      .some((problem) => problem.includes('failed mount scenarios'))).toBe(true);
  });
});

describe('promotion output overlap', () => {
  test('rejects nested/equal output and an existing target, including a symlink alias', () => {
    const nested = promotionPathOverlapProblems({
      candidate: '/tmp/case/candidate',
      installDir: '/tmp/case/candidate/install',
      out: '/tmp/case/candidate',
      targetRoot: '/tmp/case/candidate/darwin-arm64',
      targetRootExists: false,
    });
    expect(nested.some((problem) => problem.includes('overlaps the candidate'))).toBe(true);

    const archive = promotionPathOverlapProblems({
      candidate: '/tmp/case/xpod.tar.gz',
      installDir: '/tmp/case/extract/install',
      archive: '/tmp/case/xpod.tar.gz',
      out: '/tmp/case',
      targetRoot: '/tmp/case/darwin-arm64',
      targetRootExists: false,
    });
    expect(archive.some((problem) => problem.includes('candidate archive'))).toBe(true);

    const existing = promotionPathOverlapProblems({
      candidate: '/tmp/case/candidate',
      installDir: '/tmp/case/candidate',
      out: '/tmp/out',
      targetRoot: '/tmp/out/darwin-arm64',
      targetRootExists: true,
    });
    expect(existing.some((problem) => problem.includes('existing output target'))).toBe(true);

    const resolveAlias = (target: string): string | null => {
      if (target === '/alias' || target.startsWith('/alias/')) {
        return `/real/proj/candidate${target.slice('/alias'.length)}`;
      }
      return target.startsWith('/real') ? target : null;
    };
    const linked = promotionPathOverlapProblems({
      candidate: '/real/proj/candidate',
      installDir: '/real/proj/candidate',
      out: '/alias',
      targetRoot: '/alias/darwin-arm64',
      targetRootExists: false,
    }, resolveAlias);
    expect(linked.some((problem) => problem.includes('overlaps the candidate'))).toBe(true);

    expect(isPathWithin('/a/b', '/a')).toBe(true);
    expect(isPathWithin('/a', '/a/b')).toBe(false);
  });

  test('promote.ts refuses an overlapping --out and preserves the candidate bytes', () => {
    const script = path.join(repo, 'packages/xpod-cli/scripts/promote.ts');
    const caseDir = path.join(work, 'promote-overlap');
    const candidate = path.join(caseDir, 'candidate');
    mkdirSync(candidate, { recursive: true });
    const sentinel = Buffer.from('{"platform":"darwin-arm64"}\n', 'utf8');
    writeFileSync(path.join(candidate, 'manifest.json'), sentinel);
    const run = spawnSync(process.execPath, [
      script,
      '--candidate', candidate,
      '--evidence', path.join(caseDir, 'evidence.json'),
      '--installed-report', path.join(caseDir, 'installed.json'),
      '--gateway-report', path.join(caseDir, 'gateway.json'),
      '--out', candidate,
    ], { encoding: 'utf8', timeout: 30_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('output-overlap');
    expect(readFileSync(path.join(candidate, 'manifest.json'))).toEqual(sentinel);
    expect(existsSync(path.join(candidate, 'darwin-arm64'))).toBe(false);
  });

  test('promote.ts refuses an existing output target instead of deleting it', () => {
    const script = path.join(repo, 'packages/xpod-cli/scripts/promote.ts');
    const caseDir = path.join(work, 'promote-existing');
    const candidate = path.join(caseDir, 'candidate');
    mkdirSync(candidate, { recursive: true });
    writeFileSync(path.join(candidate, 'manifest.json'), '{"platform":"darwin-arm64"}\n');
    const outRoot = path.join(caseDir, 'out');
    const existingTarget = path.join(outRoot, 'darwin-arm64');
    mkdirSync(existingTarget, { recursive: true });
    const sentinel = Buffer.from('DO NOT DELETE\n', 'utf8');
    writeFileSync(path.join(existingTarget, 'sentinel.txt'), sentinel);
    const run = spawnSync(process.execPath, [
      script,
      '--candidate', candidate,
      '--evidence', path.join(caseDir, 'evidence.json'),
      '--installed-report', path.join(caseDir, 'installed.json'),
      '--gateway-report', path.join(caseDir, 'gateway.json'),
      '--out', outRoot,
    ], { encoding: 'utf8', timeout: 30_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('existing output target');
    expect(readFileSync(path.join(existingTarget, 'sentinel.txt'))).toEqual(sentinel);
  });
});

describe('ordinary build verification', () => {
  test('--public verification still blocks a candidate with pending licenses', () => {
    const install = path.join(work, 'ordinary-install');
    mkdirSync(path.join(install, 'bin'), { recursive: true });
    mkdirSync(path.join(install, 'lib'), { recursive: true });
    writeFileSync(path.join(install, 'lib/xpodcli.mjs'), '// cli fixture\n');
    writeFileSync(path.join(install, 'bin/xpodcli'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const pending = { spdx: null, status: 'pending' as const, source: 'build output pending review' };
    const manifest: XpodCliManifest = {
      ...candidateManifest(),
      selectedEnginePin: { ...candidateManifest().selectedEnginePin, licenseEvidence: undefined },
      artifacts: [
        { name: 'xpodcli', kind: 'cli', path: 'lib/xpodcli.mjs', included: true,
          sha256: sha256File(path.join(install, 'lib/xpodcli.mjs')), sizeBytes: statSync(path.join(install, 'lib/xpodcli.mjs')).size, license: pending },
        { name: 'xpodcli-launcher', kind: 'cli', path: 'bin/xpodcli', included: true,
          sha256: sha256File(path.join(install, 'bin/xpodcli')), sizeBytes: statSync(path.join(install, 'bin/xpodcli')).size, license: { ...pending, spdx: 'MIT' } },
        { name: 'agentfs-pod', kind: 'native-helper', path: null, sha256: null, sizeBytes: null, included: false,
          license: { ...pending, spdx: 'MIT' }, unavailableReason: 'cli-only fixture' },
      ],
      validationState: 'install-verified',
    };
    writeFileSync(path.join(install, 'manifest.json'), JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [
      path.join(repo, 'packages/xpod-cli/scripts/verify-install.ts'), '--dir', install, '--skip-exec', '--public',
    ], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as { checks: { name: string; ok: boolean }[] };
    const gate = report.checks.find((check) => check.name === 'public gate passes');
    expect(gate?.ok).toBe(false);
  });
});
