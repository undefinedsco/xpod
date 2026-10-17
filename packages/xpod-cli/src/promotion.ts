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
import path from 'node:path';
import { sha256Hex, validateManifest, type ArtifactKind, type XpodCliManifest } from './manifest';

// Original header copied byte-for-byte from Google's win_minmax_bsd.c/.h,
// verified at the hashes recorded in the source-kit distribution notice below.
// String-array joining preserves the upstream spaces and real newline bytes.
export const GOOGLE_WIN_MINMAX_BSD_NOTICE = [
  '/*',
  ' * Copyright 2017, Google Inc.',
  ' *',
  ' * Use of this source code is governed by the following BSD-style license:',
  ' * ',
  ' * Redistribution and use in source and binary forms, with or without',
  ' * modification, are permitted provided that the following conditions are',
  ' * met:',
  ' * ',
  ' *    * Redistributions of source code must retain the above copyright',
  ' * notice, this list of conditions and the following disclaimer.',
  ' *    * Redistributions in binary form must reproduce the above',
  ' * copyright notice, this list of conditions and the following disclaimer',
  ' * in the documentation and/or other materials provided with the',
  ' * distribution.',
  ' * ',
  ' *    * Neither the name of Google Inc. nor the names of its',
  ' * contributors may be used to endorse or promote products derived from',
  ' * this software without specific prior written permission.',
  ' * ',
  ' * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS',
  ' * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT',
  ' * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR',
  ' * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT',
  ' * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,',
  ' * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT',
  ' * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,',
  ' * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY',
  ' * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT',
  ' * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE',
  ' * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.',
  ' */',
  '',
].join('\n');

export const SOURCE_KIT_GOOGLE_NOTICE = `## Supplemental source-kit notice: quinn-proto 0.11.19
The native source kit includes vendor/quinn-proto-0.11.19/src/congestion/bbr/min_max.rs
(SHA-256 06eb1be36b8700cc4b8a2df07a3d87253f0ef8184cec670928ebd27ecebda935),
which attributes its MinMax adaptation to Google's BSD source. This source-kit
inventory does not establish that this crate is linked into a target helper.
Original source: https://groups.google.com/g/bbr-dev/c/3RTgkzi5ZD8
Original C: https://groups.google.com/group/bbr-dev/attach/551100fa5f1ca/win_minmax_bsd.c?part=0.2
C SHA-256: 716fc41ef670545738bbe33697a87e88e934d46a9bc1678b61178769e26691aa
H SHA-256: 82244db5f9d39036ad90f256f5bea459bbee83cfffc1988fff8f1fbec9114aa4
The original copyright, conditions and disclaimer follow verbatim:
` + GOOGLE_WIN_MINMAX_BSD_NOTICE;

export const CLIUI_MODIFICATION_NOTICE = `## Modification notice: cliui 8.0.1 Artistic-2.0 file
cliui's build/lib/string-utils.js adapts npm/cli's ansi-trim.js from commit
4c65cd952bc8627811735bea76b9b110cc4fc80e into stripAnsi/wrap helpers for ESM
and Deno. This distribution uses that adapted file and Bun transforms its
module syntax and layout when bundling the client as lib/xpodcli.mjs.
The application source kit preserves the exact input files and build recipe.
The original npm copyright and file-level notice are preserved at
licenses/javascript/objects/b3eb9d2e054a43a3064af17332fb1839a7dadb205c5371af4789616afb1a117f.txt;
the original Artistic License 2.0 text is preserved at
licenses/javascript/objects/7610d223851f421d315df5e77974f1c68a04b97e02060e5bbbcf13d95e3ca257.txt.
This modification notice covers the adaptation and distribution's bundling;
it does not relabel the whole cliui package or the complete client.
`;

export const SOURCE_DISTRIBUTION_NOTES = [SOURCE_KIT_GOOGLE_NOTICE, CLIUI_MODIFICATION_NOTICE] as const;

export const PROMOTION_EVIDENCE_SCHEMA_VERSION = 1;
export const ACCEPTANCE_REPORT_SCHEMA_VERSION = 1;

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

/**
 * Sanitized facts a real installed-target acceptance run must report. These are
 * the report bytes whose hash the evidence binds; the validator re-checks the
 * facts here so a stale or fabricated file cannot stand in for a real run.
 */
export interface InstalledAcceptanceReport {
  target: string;
  backend: 'fuse' | 'nfs';
  executedOnTarget: boolean;
  client: { cliSha256: string; launcherSha256: string; helperSha256: string };
  lifecycle: {
    realMountScenariosPassed: number;
    mountScenariosFailed: number;
    informationalSkips: number;
    lifecycleProven: boolean;
    cleanedOwnedResources: boolean;
  };
}

/**
 * Sanitized facts a live Gateway/canonical-Pod run must report.
 *
 * `sourceSHA` is the *client* candidate source that produced the acceptance and
 * is bound to the candidate. The independently deployed Gateway identity is
 * recorded under `gateway` when available and is deliberately never required to
 * equal the client source SHA.
 */
export interface GatewayAcceptanceReport {
  target: string;
  proofKind: 'live-gateway';
  sourceSHA: string;
  canonicalPodWrite: boolean;
  storageBindingValidated: boolean;
  success: boolean;
  sanitized: boolean;
  gateway?: { url?: string; serverIdentity?: string };
}

/**
 * The single small acceptance-report contract. One real run may emit one file
 * containing both sections; separate files with one section each are also
 * accepted. Fixtures are rejected by the `live-gateway` proof kind.
 */
export interface AcceptanceReportDocument {
  schemaVersion: number;
  sourceSHA: string;
  installedAcceptance?: InstalledAcceptanceReport;
  gatewayAcceptance?: GatewayAcceptanceReport;
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
    /** Actual deployed Gateway identity when available; never the client SHA. */
    gateway?: { url?: string; serverIdentity?: string };
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
 * Validate the explicit sanitized acceptance report files against the candidate
 * manifest and the evidence that binds their bytes.
 *
 * The caller supplies the parsed report documents plus the sha256 of their raw
 * bytes. This function only checks the facts: report bytes -> evidence hash ->
 * candidate manifest identity/artifacts. A stale file (hash mismatch), an
 * absent section, a fabricated identity, a fixture proof kind or a non-passing
 * lifecycle/Gateway fact is rejected.
 */
export function validateAcceptanceReports(input: {
  manifest: XpodCliManifest;
  evidence: PromotionEvidence;
  installedReport: unknown;
  installedReportSha256: string;
  gatewayReport: unknown;
  gatewayReportSha256: string;
}): string[] {
  const problems: string[] = [];
  const { manifest, evidence } = input;

  if (!isSha256(input.installedReportSha256)) {
    problems.push('installed acceptance report bytes must be 64-hex hashed');
  } else if (input.installedReportSha256 !== evidence.installedAcceptance.reportSha256) {
    problems.push('installed acceptance report bytes do not match evidence.installedAcceptance.reportSha256 (stale or wrong file)');
  }
  if (!isSha256(input.gatewayReportSha256)) {
    problems.push('gateway acceptance report bytes must be 64-hex hashed');
  } else if (input.gatewayReportSha256 !== evidence.gatewayAcceptance.reportSha256) {
    problems.push('gateway acceptance report bytes do not match evidence.gatewayAcceptance.reportSha256 (stale or wrong file)');
  }

  const installedDoc = acceptanceReportDocument(input.installedReport, 'installed', problems);
  if (installedDoc) {
    checkReportSource(installedDoc, manifest, 'installed', problems);
    const section = installedDoc.installedAcceptance;
    if (typeof section !== 'object' || section === null) {
      problems.push('installed acceptance report lacks its installedAcceptance facts');
    } else {
      checkInstalledReportFacts(section, manifest, evidence, problems);
    }
  }

  const gatewayDoc = acceptanceReportDocument(input.gatewayReport, 'gateway', problems);
  if (gatewayDoc) {
    checkReportSource(gatewayDoc, manifest, 'gateway', problems);
    const section = gatewayDoc.gatewayAcceptance;
    if (typeof section !== 'object' || section === null) {
      problems.push('gateway acceptance report lacks its gatewayAcceptance facts');
    } else {
      checkGatewayReportFacts(section, manifest, evidence, problems);
    }
  }

  return [ ...new Set(problems) ];
}

function acceptanceReportDocument(raw: unknown, label: string, problems: string[]): AcceptanceReportDocument | null {
  if (typeof raw !== 'object' || raw === null) {
    problems.push(`${label} acceptance report is not an object`);
    return null;
  }
  const document = raw as Partial<AcceptanceReportDocument>;
  if (document.schemaVersion !== ACCEPTANCE_REPORT_SCHEMA_VERSION) {
    problems.push(`${label} acceptance report schemaVersion must be ${ACCEPTANCE_REPORT_SCHEMA_VERSION}`);
  }
  return document as AcceptanceReportDocument;
}

function checkReportSource(document: AcceptanceReportDocument, manifest: XpodCliManifest, label: string, problems: string[]): void {
  if (!isCommit(document.sourceSHA) || document.sourceSHA !== manifest.sourceSHA) {
    problems.push(`${label} acceptance report sourceSHA does not bind the candidate client source`);
  }
}

function checkInstalledReportFacts(
  section: InstalledAcceptanceReport,
  manifest: XpodCliManifest,
  evidence: PromotionEvidence,
  problems: string[],
): void {
  const installed = evidence.installedAcceptance;
  if (section.target !== manifest.platform) {
    problems.push('installed acceptance report target does not match the candidate platform');
  }
  if (section.backend !== 'fuse' && section.backend !== 'nfs') {
    problems.push('installed acceptance report backend must be fuse or nfs');
  }
  if (section.executedOnTarget !== true) {
    problems.push('installed acceptance report does not prove target execution');
  }
  const client = section.client;
  if (typeof client !== 'object' || client === null) {
    problems.push('installed acceptance report lacks its client identity');
  } else {
    for (const [ field, expected ] of [
      [ 'cliSha256', installed.cliSha256 ],
      [ 'launcherSha256', installed.launcherSha256 ],
      [ 'helperSha256', installed.helperSha256 ],
    ] as const) {
      if (!isSha256(client[field]) || client[field] !== expected) {
        problems.push(`installed acceptance report ${field} does not match the reviewed artifact identity`);
      }
    }
  }
  const lifecycle = section.lifecycle;
  if (typeof lifecycle !== 'object' || lifecycle === null) {
    problems.push('installed acceptance report lacks its lifecycle facts');
    return;
  }
  if (!Number.isSafeInteger(lifecycle.realMountScenariosPassed) || lifecycle.realMountScenariosPassed < 1 ||
    lifecycle.realMountScenariosPassed !== installed.realMountScenariosPassed) {
    problems.push('installed acceptance report does not record passing real mount scenarios');
  }
  if (lifecycle.mountScenariosFailed !== 0) {
    problems.push('installed acceptance report records failed mount scenarios');
  }
  if (!Number.isSafeInteger(lifecycle.informationalSkips) || lifecycle.informationalSkips < 0 ||
    lifecycle.informationalSkips !== installed.informationalSkips) {
    problems.push('installed acceptance report informationalSkips does not match the evidence');
  }
  if (lifecycle.lifecycleProven !== true) {
    problems.push('installed acceptance report does not prove real mounting/lifecycle');
  }
  if (lifecycle.cleanedOwnedResources !== true) {
    problems.push('installed acceptance report does not prove cleaned owned resources');
  }
}

function checkGatewayReportFacts(
  section: GatewayAcceptanceReport,
  manifest: XpodCliManifest,
  evidence: PromotionEvidence,
  problems: string[],
): void {
  const gateway = evidence.gatewayAcceptance;
  if (section.target !== manifest.platform) {
    problems.push('gateway acceptance report target does not match the candidate platform');
  }
  if (!isCommit(section.sourceSHA) || section.sourceSHA !== manifest.sourceSHA) {
    problems.push('gateway acceptance report sourceSHA does not bind the candidate client source');
  }
  if (section.proofKind !== 'live-gateway') {
    problems.push('gateway acceptance report is not a live-gateway proof (fixtures are rejected)');
  }
  if (section.canonicalPodWrite !== true || gateway.canonicalPodWrite !== true) {
    problems.push('gateway acceptance report does not prove a canonical Pod write');
  }
  if (section.storageBindingValidated !== true || gateway.storageBindingValidated !== true) {
    problems.push('gateway acceptance report does not validate canonical storage binding');
  }
  if (section.success !== true || gateway.success !== true) {
    problems.push('gateway acceptance report did not succeed');
  }
  if (section.sanitized !== true || gateway.sanitized !== true) {
    problems.push('gateway acceptance report is not sanitized (secrets/raw logs)');
  }
  if (section.gateway !== undefined) {
    const identity = section.gateway;
    if (typeof identity !== 'object' || identity === null) {
      problems.push('gateway acceptance report gateway identity must be an object when present');
    } else {
      for (const value of [ identity.url, identity.serverIdentity ]) {
        if (value !== undefined && !isNonEmptyString(value)) {
          problems.push('gateway acceptance report gateway identity fields must be non-empty strings');
        }
      }
    }
  }
}

/** True when `child` is `parent` itself or nested within it. */
export function isPathWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export interface PromotionPathPlan {
  candidate: string;
  installDir: string;
  archive?: string;
  out: string;
  targetRoot: string;
  targetRootExists: boolean;
}

/**
 * Reject candidate/install/archive versus output overlap (including symlink
 * aliases, via the injected `realpath`) before any output mutation, and refuse
 * an already-existing output target instead of silently deleting it.
 */
export function promotionPathOverlapProblems(
  plan: PromotionPathPlan,
  realpath: (target: string) => string | null = () => null,
): string[] {
  const problems: string[] = [];
  const resolve = (target: string): string => path.resolve(realpath(target) ?? target);
  const candidate = resolve(plan.candidate);
  const installDir = resolve(plan.installDir);
  const archive = plan.archive ? resolve(plan.archive) : undefined;
  const out = resolve(plan.out);
  const targetRoot = resolve(plan.targetRoot);
  const overlaps = (a: string, b: string): boolean => isPathWithin(a, b) || isPathWithin(b, a);

  if (plan.targetRootExists) {
    problems.push(`refusing to overwrite existing output target ${plan.targetRoot}`);
  }

  const inputs: { label: string; value: string }[] = [
    { label: 'candidate', value: candidate },
    ...(installDir === candidate ? [] : [ { label: 'candidate install dir', value: installDir } ]),
    ...(archive ? [ { label: 'candidate archive', value: archive } ] : []),
  ];
  for (const inputPath of inputs) {
    if (overlaps(targetRoot, inputPath.value)) {
      problems.push(`output target ${plan.targetRoot} overlaps the ${inputPath.label}`);
    }
    if (overlaps(out, inputPath.value)) {
      problems.push(`--out ${plan.out} overlaps the ${inputPath.label}`);
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
      ...SOURCE_DISTRIBUTION_NOTES,
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
  gatewayIdentity?: { url?: string; serverIdentity?: string };
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
      ...(input.gatewayIdentity ? { gateway: { ...input.gatewayIdentity } } : {}),
    },
    sanitized: true,
    notes: [ ...SOURCE_DISTRIBUTION_NOTES, ...evidence.notes ],
  };
}
