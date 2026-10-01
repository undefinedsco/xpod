import { describe, expect, test } from 'bun:test';
import {
  MANIFEST_SCHEMA_VERSION,
  XPOD_CLI_PACKAGE,
  validateManifest,
  publicGateProblems,
  isPublicReleaseReady,
  type XpodCliManifest,
} from '../src/manifest';

function baseManifest(overrides: Partial<XpodCliManifest> = {}): XpodCliManifest {
  const manifest: XpodCliManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    package: XPOD_CLI_PACKAGE,
    version: '0.1.0-preview.1',
    channel: 'preview',
    platform: 'darwin-arm64',
    sourceSHA: 'a'.repeat(40),
    dirtyTreeHash: null,
    source: { mode: 'release', commit: 'a'.repeat(40), dirty: false },
    selectedEnginePin: {
      engine: 'agentfs',
      repository: 'https://github.com/tursodatabase/agentfs',
      commit: 'b'.repeat(40),
      sdkLicenseStatus: 'verified',
      cliLicenseStatus: 'pending',
      rootLicensePresent: false,
    },
    artifacts: [
      {
        name: 'xpodcli',
        kind: 'cli',
        path: 'bin/xpodcli',
        sha256: 'c'.repeat(64),
        sizeBytes: 123,
        included: true,
        license: { spdx: null, status: 'pending', source: 'root declares MIT; no LICENSE file' },
      },
      {
        name: 'agentfs-pod',
        kind: 'native-helper',
        path: null,
        sha256: null,
        sizeBytes: null,
        included: false,
        license: { spdx: null, status: 'pending', source: 'no license field' },
        unavailableReason: 'cli-only',
      },
    ],
    validationState: 'cli-only',
    generatedAt: '2026-10-01T00:00:00.000Z',
    notes: [],
  };
  return { ...manifest, ...overrides };
}

describe('validateManifest', () => {
  test('accepts a structurally valid manifest', () => {
    expect(validateManifest(baseManifest())).toEqual([]);
  });

  test('rejects a bad platform', () => {
    const problems = validateManifest(baseManifest({ platform: 'darwin' }));
    expect(problems.some((p) => p.includes('platform'))).toBe(true);
  });

  test('requires sha256 for included artifacts', () => {
    const manifest = baseManifest();
    manifest.artifacts[0].sha256 = null as unknown as string;
    const problems = validateManifest(manifest);
    expect(problems.some((p) => p.includes('sha256'))).toBe(true);
  });

  test('requires unavailableReason for omitted artifacts', () => {
    const manifest = baseManifest();
    delete manifest.artifacts[1].unavailableReason;
    const problems = validateManifest(manifest);
    expect(problems.some((p) => p.includes('unavailableReason'))).toBe(true);
  });
});

describe('public gate', () => {
  test('blocks a dirty local preview with pending licenses', () => {
    const manifest = baseManifest({
      channel: 'local-preview',
      sourceSHA: 'a'.repeat(40),
      dirtyTreeHash: 'd'.repeat(64),
      source: { mode: 'local-preview', commit: 'a'.repeat(40), dirty: true },
    });
    const problems = publicGateProblems(manifest);
    expect(problems.some((p) => p.includes('dirty'))).toBe(true);
    expect(problems.some((p) => p.includes('local-preview'))).toBe(true);
    expect(problems.some((p) => p.includes('license'))).toBe(true);
    expect(isPublicReleaseReady(manifest)).toBe(false);
  });

  test('blocks missing root LICENSE and pending CLI license even when clean', () => {
    const problems = publicGateProblems(baseManifest());
    expect(problems.some((p) => p.includes('CLI license'))).toBe(true);
    expect(problems.some((p) => p.includes('root LICENSE'))).toBe(true);
    expect(problems.some((p) => p.includes('license is pending'))).toBe(true);
    expect(problems.some((p) => p.includes('full-verified'))).toBe(true);
  });

  test('never auto-assigns MIT for an unknown license', () => {
    const manifest = baseManifest({
      selectedEnginePin: {
        engine: 'agentfs',
        repository: 'https://github.com/tursodatabase/agentfs',
        commit: 'b'.repeat(40),
        sdkLicenseStatus: 'verified',
        cliLicenseStatus: 'verified',
        rootLicensePresent: true,
      },
      artifacts: [
        {
          name: 'xpodcli',
          kind: 'cli',
          path: 'bin/xpodcli',
          sha256: 'c'.repeat(64),
          sizeBytes: 123,
          included: true,
          license: { spdx: null, status: 'verified', source: 'reviewed' },
        },
      ],
      validationState: 'full-verified',
    });
    expect(publicGateProblems(manifest)).toEqual([]);
  });
});
