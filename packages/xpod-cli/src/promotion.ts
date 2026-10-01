/**
 * Evidence-bound promotion of an Xpod CLI install candidate.
 *
 * An ordinary build deliberately stops at a pending candidate
 * (`publicReleaseReady=false`, licenses `pending`, `install-verified`). Promotion
 * is a separate, explicit step: it takes an existing candidate plus structured
 * acceptance/review evidence and derives a promoted manifest only when the
 * evidence binds the candidate manifest hash and every reviewed artifact hash
 * and carries native test, installed-target and live Gateway/canonical Pod
 * acceptance. Nothing here flips release flags implicitly or edits a build.
 *
 * `validatePromotionEvidence` and `derivePromotedManifest` are pure (no I/O) so
 * the complete-public-client contract can be regression-tested directly.
 * `scripts/promote.ts` owns the filesystem orchestration and reuses the
 * existing post-install/source/hash and native-receipt validators.
 */
import { sha256Hex, validateManifest, type ArtifactKind, type XpodCliManifest } from './manifest';

export const PROMOTION_EVIDENCE_SCHEMA_VERSION = 1;

/** Explicit review of one actual artifact's bytes and recorded provenance. */
export interface ArtifactReview {
  name: string;
  kind: ArtifactKind;
  path: string;
  sha256: string;
  /** SPDX id, or null for mixed/assembled artifacts; never invented. */
  spdx: string | null;
  status: 'verified';
  /** Where the review claim came from; required, not inferred from packaging. */
  provenance: string;
}

/** Actual matching tested native build receipt and its identities. */
export interface NativeTestProof {
  target: string;
  receiptSha256: string;
  sourceKitSha256: string;
  helperSha256: string;
  compiler: { toolchain: string; cargoSha256: string; rustcSha256: string };
  testsPassed: boolean;
  testsFailed: number;
  testsIgnored: number;
}

/** Installed target acceptance: real mounting/lifecycle and cleaned resources. */
export interface InstalledAcceptanceProof {
  target: string;
  backend: 'fuse' | 'nfs';
  executedOnTarget: boolean;
  cliSha256: string;
  launcherSha256: string;
  helperSha256: string;
  reportSha256: string;
  realMountScenariosPassed: number;
  mountScenariosFailed: number;
  informationalSkips: number;
  lifecycleProven: boolean;
  cleanedOwnedResources: boolean;
}

/** Live Xpod Gateway + canonical Pod acceptance, distinct from record fixtures. */
export interface GatewayAcceptanceProof {
  target: string;
  sourceSHA: string;
  proofKind: 'live-gateway';
  canonicalPodWrite: boolean;
  storageBindingValidated: boolean;
  success: boolean;
  /** True only when secrets and raw private logs are excluded from the record. */
  sanitized: boolean;
  reportSha256: string;
}

export interface PromotionEvidence {
  schemaVersion: number;
  candidate: {
    manifestSha256: string;
    platform: string;
    sourceSHA: string;
    engine: { engine: string; repository: string; commit: string };
  };
  reviews: ArtifactReview[];
  nativeTest: NativeTestProof;
  installedAcceptance: InstalledAcceptanceProof;
  gatewayAcceptance: GatewayAcceptanceProof;
  notes: string[];
}

/** Sanitized, hash-bound record explaining a promotion. Contains no raw logs. */
export interface PromotionRecord {
  schemaVersion: number;
  promotedAt: string;
  candidateManifestSha256: string;
  promotedManifestSha256: string;
  evidenceSha256: string;
  platform: string;
  version: string;
  sourceSHA: string;
  engine: { engine: string; repository: string; commit: string };
  publicReleaseReady: boolean;
  publicGateProblems: string[];
  nativeTest: {
    target: string; helperSha256: string; sourceKitSha256: string; receiptSha256: string;
    testsPassed: boolean; compiler: NativeTestProof['compiler'];
  };
  installedAcceptance: {
    target: string; backend: string; cliSha256: string; launcherSha256: string; helperSha256: string;
    reportSha256: string; realMountScenariosPassed: number; informationalSkips: number;
  };
  gatewayAcceptance: {
    target: string; sourceSHA: string; proofKind: string; reportSha256: string;
    canonicalPodWrite: boolean; storageBindingValidated: boolean;
  };
  sanitized: true;
  notes: string[];
}

const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function isCommit(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_RE.test(value);
}

/** Canonical manifest hash. Matches the exact bytes written by the builder. */
export function manifestContentSha256(manifest: XpodCliManifest): string {
  return sha256Hex(JSON.stringify(manifest, null, 2) + '\n');
}

function artifactSha(artifacts: XpodCliManifest['artifacts'], path: string): string | null {
  return artifacts.find((artifact) => artifact.included && artifact.path === path)?.sha256 ?? null;
}

function artifactNameSha(artifacts: XpodCliManifest['artifacts'], name: string): string | null {
  return artifacts.find((artifact) => artifact.included && artifact.name === name)?.sha256 ?? null;
}

/**
 * Pure validation of promotion evidence against a candidate manifest.
 * Returns the reasons promotion must NOT proceed (empty = valid). Fails closed:
 * any missing review, duplicate/unexpected entry, changed byte, dirty source,
 * wrong target/engine, untested native receipt, stale mounted hash or
 * fixture-only Gateway proof is reported.
 */
export function validatePromotionEvidence(input: {
  manifest: XpodCliManifest;
  manifestSha256: string;
  evidence: unknown;
}): string[] {
  const problems: string[] = [];
  const manifest = input.manifest;
  problems.push(...validateManifest(manifest));

  const evidence = input.evidence as Partial<PromotionEvidence> | null;
  if (typeof evidence !== 'object' || evidence === null) {
    return [ 'promotion evidence is not an object' ];
  }
  if (evidence.schemaVersion !== PROMOTION_EVIDENCE_SCHEMA_VERSION) {
    problems.push(`promotion evidence schemaVersion must be ${PROMOTION_EVIDENCE_SCHEMA_VERSION}`);
  }

  // The candidate itself must already be a clean, exact-commit external-runtime
  // client. Dirty/local/unknown identities cannot be promoted.
  if (manifest.distribution !== 'external-runtime') {
    problems.push('candidate distribution must be external-runtime');
  }
  if (manifest.channel !== 'preview') {
    problems.push('candidate channel must be preview for promotion');
  }
  if (manifest.source.mode !== 'release') {
    problems.push('candidate source.mode must be release (clean exact commit), not local-preview');
  }
  if (manifest.source.dirty) {
    problems.push('candidate source tree is dirty');
  }
  if (manifest.dirtyTreeHash !== null) {
    problems.push('candidate dirtyTreeHash must be null for a release');
  }
  if (!isCommit(manifest.sourceSHA)) {
    problems.push('candidate sourceSHA must be an exact 40-hex commit');
  } else if (manifest.source.commit !== manifest.sourceSHA) {
    problems.push('candidate source.commit must equal sourceSHA');
  }

  const candidate = evidence.candidate as PromotionEvidence['candidate'] | undefined;
  if (typeof candidate !== 'object' || candidate === null) {
    problems.push('evidence.candidate is required');
  } else {
    if (candidate.manifestSha256 !== input.manifestSha256) {
      problems.push('evidence candidate manifest hash does not match the candidate manifest');
    }
    if (candidate.platform !== manifest.platform) {
      problems.push('evidence candidate platform does not match the manifest platform');
    }
    if (!isCommit(candidate.sourceSHA) || candidate.sourceSHA !== manifest.sourceSHA) {
      problems.push('evidence candidate sourceSHA does not match the manifest source identity');
    }
    const pin = manifest.selectedEnginePin;
    if (typeof candidate.engine !== 'object' || candidate.engine === null ||
      candidate.engine.engine !== pin.engine || candidate.engine.repository !== pin.repository || candidate.engine.commit !== pin.commit) {
      problems.push('evidence engine pin does not match the manifest selectedEnginePin');
    }
  }

  const included = manifest.artifacts.filter((artifact) => artifact.included);
  const reviews = evidence.reviews as ArtifactReview[] | undefined;
  if (!Array.isArray(reviews) || reviews.length === 0) {
    problems.push('evidence.reviews must be a non-empty array');
  } else {
    const byName = new Map<string, ArtifactReview>();
    const seenPaths = new Set<string>();
    for (const review of reviews) {
      if (typeof review !== 'object' || review === null) {
        problems.push('review entry is not an object');
        continue;
      }
      if (!isNonEmptyString(review.name)) {
        problems.push('review entry lacks a name');
        continue;
      }
      if (byName.has(review.name)) {
        problems.push(`duplicate review for artifact ${review.name}`);
        continue;
      }
      if (!isNonEmptyString(review.path)) {
        problems.push(`review ${review.name} lacks a path`);
      } else if (seenPaths.has(review.path)) {
        problems.push(`duplicate review path ${review.path}`);
      } else {
        seenPaths.add(review.path);
      }
      if (!isSha256(review.sha256)) {
        problems.push(`review ${review.name} sha256 must be 64-hex`);
      }
      if (review.status !== 'verified') {
        problems.push(`review ${review.name} must have status verified`);
      }
      if (!isNonEmptyString(review.provenance)) {
        problems.push(`review ${review.name} requires recorded provenance`);
      }
      if (review.spdx !== null && typeof review.spdx !== 'string') {
        problems.push(`review ${review.name} spdx must be an SPDX string or null`);
      }
      byName.set(review.name, review);
    }
    for (const artifact of included) {
      const review = byName.get(artifact.name);
      if (!review) {
        problems.push(`missing review for included artifact ${artifact.name}`);
        continue;
      }
      if (review.kind !== artifact.kind) {
        problems.push(`review kind mismatch for artifact ${artifact.name}`);
      }
      if (review.path !== artifact.path) {
        problems.push(`review path mismatch for artifact ${artifact.name}`);
      }
      if (review.sha256 !== artifact.sha256) {
        problems.push(`reviewed bytes changed for artifact ${artifact.name}`);
      }
    }
    const includedNames = new Set(included.map((artifact) => artifact.name));
    for (const name of byName.keys()) {
      if (!includedNames.has(name)) {
        problems.push(`unexpected review for unknown artifact ${name}`);
      }
    }
  }

  // The complete public client requires the real helper and full source material.
  if (!included.some((artifact) => artifact.name === 'agentfs-pod' && artifact.kind === 'native-helper')) {
    problems.push('candidate lacks an included native-helper agentfs-pod');
  }
  for (const file of ['application-source.json', 'application-source.tar.gz', 'native-source.json', 'native-source-build.json', 'native-source.tar.gz']) {
    if (!included.some((artifact) => artifact.kind === 'source' && artifact.path === `sources/${file}`)) {
      problems.push(`candidate lacks included source material sources/${file}`);
    }
  }

  const nativeTest = evidence.nativeTest as NativeTestProof | undefined;
  if (typeof nativeTest !== 'object' || nativeTest === null) {
    problems.push('evidence.nativeTest (matching tested native build receipt) is required');
  } else {
    if (nativeTest.target !== manifest.platform) {
      problems.push('native test target does not match the candidate platform');
    }
    if (!isSha256(nativeTest.receiptSha256) || nativeTest.receiptSha256 !== artifactSha(included, 'sources/native-source-build.json')) {
      problems.push('native test receipt does not match the candidate build receipt bytes');
    }
    if (!isSha256(nativeTest.sourceKitSha256) || nativeTest.sourceKitSha256 !== artifactSha(included, 'sources/native-source.json')) {
      problems.push('native test source kit does not match the candidate source kit bytes');
    }
    if (!isSha256(nativeTest.helperSha256) || nativeTest.helperSha256 !== artifactNameSha(included, 'agentfs-pod')) {
      problems.push('native test helper does not match the candidate helper bytes');
    }
    if (nativeTest.testsPassed !== true || nativeTest.testsFailed !== 0) {
      problems.push('native tests did not all pass (testsPassed/testsFailed)');
    }
    if (typeof nativeTest.testsIgnored !== 'number' || !Number.isSafeInteger(nativeTest.testsIgnored) || nativeTest.testsIgnored < 0) {
      problems.push('native test testsIgnored must be a non-negative integer');
    }
    const compiler = nativeTest.compiler;
    if (typeof compiler !== 'object' || compiler === null || !/^nightly-\d{4}-\d{2}-\d{2}$/.test(compiler.toolchain) ||
      !isSha256(compiler.cargoSha256) || !isSha256(compiler.rustcSha256)) {
      problems.push('native compiler identity is missing or invalid');
    }
  }

  const installed = evidence.installedAcceptance as InstalledAcceptanceProof | undefined;
  if (typeof installed !== 'object' || installed === null) {
    problems.push('evidence.installedAcceptance is required');
  } else {
    if (installed.target !== manifest.platform) {
      problems.push('installed acceptance target does not match the candidate platform');
    }
    if (installed.backend !== 'fuse' && installed.backend !== 'nfs') {
      problems.push('installed acceptance backend must be fuse or nfs');
    }
    if (installed.executedOnTarget !== true) {
      problems.push('installed acceptance was not executed on the target (host execution alone does not qualify)');
    }
    if (!isSha256(installed.cliSha256) || installed.cliSha256 !== artifactNameSha(included, 'xpodcli')) {
      problems.push('installed acceptance CLI hash does not match the candidate CLI bytes');
    }
    if (!isSha256(installed.launcherSha256) || installed.launcherSha256 !== artifactNameSha(included, 'xpodcli-launcher')) {
      problems.push('installed acceptance launcher hash does not match the candidate launcher bytes');
    }
    if (!isSha256(installed.helperSha256) || installed.helperSha256 !== artifactNameSha(included, 'agentfs-pod')) {
      problems.push('installed acceptance helper hash does not match the candidate helper bytes');
    }
    if (!isSha256(installed.reportSha256)) {
      problems.push('installed acceptance reportSha256 must be 64-hex');
    }
    if (!Number.isSafeInteger(installed.realMountScenariosPassed) || installed.realMountScenariosPassed < 1 || installed.mountScenariosFailed !== 0) {
      problems.push('installed acceptance lacks passing real mount scenarios');
    }
    if (!Number.isSafeInteger(installed.informationalSkips) || installed.informationalSkips < 0) {
      problems.push('installed acceptance informationalSkips must be a non-negative integer');
    }
    if (installed.lifecycleProven !== true) {
      problems.push('installed acceptance does not prove real mounting/lifecycle');
    }
    if (installed.cleanedOwnedResources !== true) {
      problems.push('installed acceptance does not prove cleaned owned resources');
    }
  }

  const gateway = evidence.gatewayAcceptance as GatewayAcceptanceProof | undefined;
  if (typeof gateway !== 'object' || gateway === null) {
    problems.push('evidence.gatewayAcceptance (live Xpod Gateway/canonical Pod proof) is required');
  } else {
    if (gateway.proofKind !== 'live-gateway') {
      problems.push('gateway acceptance must be live-gateway proof, not a fixture/recording');
    }
    if (gateway.target !== manifest.platform) {
      problems.push('gateway acceptance target does not match the candidate platform');
    }
    if (gateway.sourceSHA !== manifest.sourceSHA) {
      problems.push('gateway acceptance source provenance does not match the candidate source');
    }
    if (!isSha256(gateway.reportSha256)) {
      problems.push('gateway acceptance reportSha256 must be 64-hex');
    }
    if (gateway.canonicalPodWrite !== true) {
      problems.push('gateway acceptance does not prove a canonical Pod write');
    }
    if (gateway.storageBindingValidated !== true) {
      problems.push('gateway acceptance does not validate canonical storage binding');
    }
    if (gateway.success !== true) {
      problems.push('gateway acceptance did not succeed');
    }
    if (gateway.sanitized !== true) {
      problems.push('gateway acceptance record is not sanitized (secrets/raw logs)');
    }
  }

  return [ ...new Set(problems) ];
}

/**
 * Derive the promoted manifest from a validated candidate + evidence. Only
 * explicit per-artifact reviews and a successful gateway acceptance can raise
 * license statuses and reach full-verified; readiness is then computed by
 * `publicGateProblems` on the result.
 */
export function derivePromotedManifest(manifest: XpodCliManifest, evidence: PromotionEvidence): XpodCliManifest {
  const reviews = new Map(evidence.reviews.map((review) => [ review.name, review ]));
  return {
    ...manifest,
    channel: 'preview',
    dirtyTreeHash: null,
    source: { mode: 'release', commit: manifest.sourceSHA, dirty: false },
    selectedEnginePin: {
      ...manifest.selectedEnginePin,
      sdkLicenseStatus: 'verified',
      cliLicenseStatus: 'verified',
    },
    artifacts: manifest.artifacts.map((artifact) => {
      if (!artifact.included) {
        return artifact;
      }
      const review = reviews.get(artifact.name);
      if (!review) {
        throw new Error(`Cannot derive promoted manifest without a review for ${artifact.name}`);
      }
      return { ...artifact, license: { spdx: review.spdx, status: 'verified' as const, source: review.provenance } };
    }),
    validationState: 'full-verified',
    generatedAt: new Date().toISOString(),
    notes: [
      ...manifest.notes,
      `Promoted from candidate manifest ${evidence.candidate.manifestSha256} via explicit evidence-bound review.`,
      ...evidence.notes,
    ],
  };
}

/** Build the sanitized, hash-bound acceptance record that explains a promotion. */
export function buildPromotionRecord(input: {
  candidateManifestSha256: string;
  promotedManifest: XpodCliManifest;
  evidence: PromotionEvidence;
  evidenceSha256: string;
  publicGateProblems: string[];
  promotedAt?: string;
}): PromotionRecord {
  const { evidence } = input;
  return {
    schemaVersion: 1,
    promotedAt: input.promotedAt ?? new Date().toISOString(),
    candidateManifestSha256: input.candidateManifestSha256,
    promotedManifestSha256: manifestContentSha256(input.promotedManifest),
    evidenceSha256: input.evidenceSha256,
    platform: input.promotedManifest.platform,
    version: input.promotedManifest.version,
    sourceSHA: input.promotedManifest.sourceSHA as string,
    engine: { ...evidence.candidate.engine },
    publicReleaseReady: input.publicGateProblems.length === 0,
    publicGateProblems: input.publicGateProblems,
    nativeTest: {
      target: evidence.nativeTest.target,
      helperSha256: evidence.nativeTest.helperSha256,
      sourceKitSha256: evidence.nativeTest.sourceKitSha256,
      receiptSha256: evidence.nativeTest.receiptSha256,
      testsPassed: evidence.nativeTest.testsPassed,
      compiler: { ...evidence.nativeTest.compiler },
    },
    installedAcceptance: {
      target: evidence.installedAcceptance.target,
      backend: evidence.installedAcceptance.backend,
      cliSha256: evidence.installedAcceptance.cliSha256,
      launcherSha256: evidence.installedAcceptance.launcherSha256,
      helperSha256: evidence.installedAcceptance.helperSha256,
      reportSha256: evidence.installedAcceptance.reportSha256,
      realMountScenariosPassed: evidence.installedAcceptance.realMountScenariosPassed,
      informationalSkips: evidence.installedAcceptance.informationalSkips,
    },
    gatewayAcceptance: {
      target: evidence.gatewayAcceptance.target,
      sourceSHA: evidence.gatewayAcceptance.sourceSHA,
      proofKind: evidence.gatewayAcceptance.proofKind,
      reportSha256: evidence.gatewayAcceptance.reportSha256,
      canonicalPodWrite: evidence.gatewayAcceptance.canonicalPodWrite,
      storageBindingValidated: evidence.gatewayAcceptance.storageBindingValidated,
    },
    sanitized: true,
    notes: [ ...evidence.notes ],
  };
}
