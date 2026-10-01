/**
 * Xpod CLI install manifest schema, validation and public-release gate.
 *
 * The manifest is the single source of truth for what was built, from which
 * source identity, against which selected engine pin, with which artifact
 * hashes and which validation state. A preview/local build may be dirty; a
 * public release must be an exact commit with verified licenses.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const MANIFEST_SCHEMA_VERSION = 1;
export const XPOD_CLI_PACKAGE = '@undefineds.co/xpod-cli';
export const XPOD_CLI_VERSION = '0.1.0-preview.1';

export type ValidationState = 'unverified' | 'cli-only' | 'install-verified' | 'full-verified';
export type LicenseStatus = 'verified' | 'pending';
export type ArtifactKind = 'cli' | 'native-helper' | 'notice' | 'config';
export type SourceMode = 'local-preview' | 'release';

export interface ArtifactLicense {
  /** SPDX id, or null when no license text/field has been verified. */
  spdx: string | null;
  status: LicenseStatus;
  /** Where the license claim came from. Never invented. */
  source: string;
}

export interface ManifestArtifact {
  name: string;
  kind: ArtifactKind;
  /** Relative path inside the install dir, or null when not included. */
  path: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  included: boolean;
  license: ArtifactLicense;
  /** Why the artifact is unavailable (cli-only builds, missing helper). */
  unavailableReason?: string;
}

export interface SelectedEnginePin {
  engine: string;
  repository: string;
  commit: string;
  sdkLicenseStatus: LicenseStatus;
  cliLicenseStatus: LicenseStatus;
  rootLicensePresent: boolean;
}

export interface XpodCliManifest {
  schemaVersion: number;
  package: string;
  version: string;
  channel: 'local-preview' | 'preview';
  platform: string;
  /** Exact source commit when known; null only for a dirty local preview. */
  sourceSHA: string | null;
  /** Hash over the dirty working tree, set only for local previews. */
  dirtyTreeHash: string | null;
  source: {
    mode: SourceMode;
    commit: string | null;
    dirty: boolean;
  };
  selectedEnginePin: SelectedEnginePin;
  artifacts: ManifestArtifact[];
  validationState: ValidationState;
  generatedAt: string;
  notes: string[];
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256File(file: string): string {
  return sha256Hex(readFileSync(file));
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

/** Structural/schema validation. Returns a list of problems (empty = valid). */
export function validateManifest(manifest: unknown): string[] {
  const problems: string[] = [];
  if (typeof manifest !== 'object' || manifest === null) {
    return [ 'manifest is not an object' ];
  }
  const m = manifest as Partial<XpodCliManifest>;
  if (m.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${MANIFEST_SCHEMA_VERSION}, got ${String(m.schemaVersion)}`);
  }
  if (m.package !== XPOD_CLI_PACKAGE) {
    problems.push(`package must be ${XPOD_CLI_PACKAGE}, got ${String(m.package)}`);
  }
  if (typeof m.version !== 'string' || m.version.length === 0) {
    problems.push('version is required');
  }
  if (m.channel !== 'local-preview' && m.channel !== 'preview') {
    problems.push(`channel must be local-preview or preview, got ${String(m.channel)}`);
  }
  if (typeof m.platform !== 'string' || !/^[a-z0-9]+-[a-z0-9]+$/.test(m.platform)) {
    problems.push(`platform must look like darwin-arm64, got ${String(m.platform)}`);
  }
  if (m.sourceSHA !== null && !COMMIT_RE.test(String(m.sourceSHA))) {
    problems.push(`sourceSHA must be 40-hex or null, got ${String(m.sourceSHA)}`);
  }
  if (m.dirtyTreeHash !== null && !SHA256_RE.test(String(m.dirtyTreeHash))) {
    problems.push(`dirtyTreeHash must be 64-hex or null, got ${String(m.dirtyTreeHash)}`);
  }
  if (typeof m.source !== 'object' || m.source === null) {
    problems.push('source is required');
  } else {
    if (m.source.mode !== 'local-preview' && m.source.mode !== 'release') {
      problems.push(`source.mode invalid: ${String(m.source.mode)}`);
    }
    if (typeof m.source.dirty !== 'boolean') {
      problems.push('source.dirty must be boolean');
    }
    if (m.source.commit !== null && !COMMIT_RE.test(String(m.source.commit))) {
      problems.push(`source.commit must be 40-hex or null, got ${String(m.source.commit)}`);
    }
  }
  if (typeof m.selectedEnginePin !== 'object' || m.selectedEnginePin === null) {
    problems.push('selectedEnginePin is required');
  } else {
    const pin = m.selectedEnginePin as SelectedEnginePin;
    if (!pin.engine || !pin.repository || !pin.commit) {
      problems.push('selectedEnginePin.engine/repository/commit are required');
    }
    if (pin.commit && !COMMIT_RE.test(String(pin.commit))) {
      problems.push('selectedEnginePin.commit must be 40-hex');
    }
  }
  if (!Array.isArray(m.artifacts) || m.artifacts.length === 0) {
    problems.push('artifacts must be a non-empty array');
  } else {
    for (const artifact of m.artifacts) {
      if (!artifact || typeof artifact !== 'object') {
        problems.push('artifact entry is not an object');
        continue;
      }
      if (artifact.included) {
        if (typeof artifact.path !== 'string' || artifact.path.length === 0) {
          problems.push(`artifact ${artifact.name}: path required when included`);
        }
        if (artifact.sha256 === null || !SHA256_RE.test(String(artifact.sha256))) {
          problems.push(`artifact ${artifact.name}: sha256 must be 64-hex when included`);
        }
        if (typeof artifact.sizeBytes !== 'number' || artifact.sizeBytes <= 0) {
          problems.push(`artifact ${artifact.name}: sizeBytes must be positive when included`);
        }
      } else if (!artifact.unavailableReason) {
        problems.push(`artifact ${artifact.name}: unavailableReason required when not included`);
      }
    }
  }
  const validStates: ValidationState[] = [ 'unverified', 'cli-only', 'install-verified', 'full-verified' ];
  if (!validStates.includes(m.validationState as ValidationState)) {
    problems.push(`validationState invalid: ${String(m.validationState)}`);
  }
  return problems;
}

/**
 * Public release gate. Returns the reasons a manifest must NOT be published.
 * An empty array means the manifest is release-ready. Unknown licenses and
 * dirty/local previews are always blocked here.
 */
export function publicGateProblems(manifest: XpodCliManifest): string[] {
  const problems = validateManifest(manifest);
  if (manifest.channel !== 'preview') {
    problems.push('public gate: channel must be preview');
  }
  if (manifest.source.mode !== 'release') {
    problems.push('public gate: source.mode must be release (exact commit), not local-preview');
  }
  if (manifest.source.dirty) {
    problems.push('public gate: source tree is dirty');
  }
  if (manifest.dirtyTreeHash !== null) {
    problems.push('public gate: dirtyTreeHash must be null for a release');
  }
  if (manifest.sourceSHA === null || !COMMIT_RE.test(manifest.sourceSHA)) {
    problems.push('public gate: sourceSHA must be an exact 40-hex commit');
  } else if (manifest.source.commit !== manifest.sourceSHA) {
    problems.push('public gate: source.commit must equal sourceSHA');
  }
  const pin = manifest.selectedEnginePin;
  if (pin.sdkLicenseStatus === 'pending') {
    problems.push('public gate: selected engine SDK license is pending verification');
  }
  if (pin.cliLicenseStatus === 'pending') {
    problems.push('public gate: selected engine CLI license is pending verification');
  }
  if (!pin.rootLicensePresent) {
    problems.push('public gate: selected engine root LICENSE file is absent');
  }
  for (const artifact of manifest.artifacts) {
    if (!artifact.included) {
      problems.push(`public gate: artifact ${artifact.name} is not included`);
      continue;
    }
    if (artifact.license.status === 'pending') {
      problems.push(`public gate: artifact ${artifact.name} license is pending verification`);
    }
  }
  if (manifest.validationState !== 'full-verified') {
    problems.push(`public gate: validationState must be full-verified, got ${manifest.validationState}`);
  }
  // De-duplicate while preserving order.
  return [ ...new Set(problems) ];
}

export function isPublicReleaseReady(manifest: XpodCliManifest): boolean {
  return publicGateProblems(manifest).length === 0;
}
