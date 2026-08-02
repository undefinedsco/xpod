import { execFile as execFileCallback } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/release-acceptance-manifest.cjs');
const { createManifest, validateManifest } = require(scriptPath);

const fullSha = '0123456789abcdef0123456789abcdef01234567';
const imageDigest = `sha256:${'a'.repeat(64)}`;
const acceptedAt = '2026-08-02T12:34:56.789Z';
const requiredChecks = [ 'build:ts', 'integration' ];

const tempRoots: string[] = [];

function validInput(overrides = {}) {
  return {
    targetVersion: '0.3.68',
    candidateVersion: '0.3.68-rc.42',
    sourceSha: fullSha,
    sourceBranch: 'release/0.3.68',
    imageDigest,
    npmPackage: '@undefineds.co/xpod',
    npmVersion: '0.3.68-rc.42',
    endpoint: 'https://rc.id.undefineds.co',
    acceptedAt,
    checks: {
      'build:ts': 'passed',
      integration: 'passed',
    },
    ...overrides,
  };
}

function validManifest(overrides = {}) {
  return createManifest(validInput(overrides));
}

function expected(overrides = {}) {
  return {
    tag: 'v0.3.68',
    sourceSha: fullSha,
    requiredChecks,
    ...overrides,
  };
}

async function tempFile(name: string, contents: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-acceptance-manifest-'));
  tempRoots.push(root);
  const filePath = path.join(root, name);
  await writeFile(filePath, contents);
  return filePath;
}

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFile('node', [ scriptPath, ...args ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
    },
  });
}

describe('release acceptance manifest', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('creates and validates a promotion-safe acceptance manifest', () => {
    const manifest = validManifest();

    expect(manifest).toEqual({
      schemaVersion: 1,
      ...validInput(),
    });
    expect(validateManifest(manifest, expected())).toEqual({ valid: true, errors: [] });
  });

  it('rejects inherited manifest fields and inherited checks', () => {
    const inheritedManifest = Object.create(validManifest());
    const inheritedChecks = Object.create({
      'build:ts': 'passed',
      integration: 'passed',
    });

    expect(validateManifest(inheritedManifest, expected()).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '' }),
    ]));

    const result = validateManifest({
      ...validManifest(),
      checks: inheritedChecks,
    }, expected());
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'checks' }),
      expect.objectContaining({ path: 'checks.build:ts' }),
      expect.objectContaining({ path: 'checks.integration' }),
    ]));
  });

  it('rejects a source SHA mismatch without echoing the SHA', () => {
    const result = validateManifest(validManifest(), expected({
      sourceSha: 'fedcba9876543210fedcba9876543210fedcba98',
    }));

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'sourceSha' }),
    ]));
    expect(JSON.stringify(result)).not.toContain(fullSha);
  });

  it('rejects source SHAs that are not exactly 40 hex characters even when expected matches', () => {
    const result = validateManifest(
      validManifest({ sourceSha: 'not-a-sha' }),
      expected({ sourceSha: 'not-a-sha' }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'sourceSha' }),
    ]));
    expect(JSON.stringify(result)).not.toContain('not-a-sha');
  });

  it('rejects mutable image tags instead of immutable sha256 digests', () => {
    const result = validateManifest(validManifest({ imageDigest: 'latest' }), expected());

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'imageDigest' }),
    ]));
  });

  it('rejects tag, target, branch, candidate, package, and npm version mismatches', () => {
    const cases = [
      [ 'targetVersion', validManifest({ targetVersion: '0.3.69' }), expected() ],
      [ 'targetVersion', validManifest(), expected({ tag: '0.3.68' }) ],
      [ 'sourceBranch', validManifest({ sourceBranch: 'main' }), expected() ],
      [ 'candidateVersion', validManifest({ candidateVersion: '0.3.69-rc.1', npmVersion: '0.3.69-rc.1' }), expected() ],
      [ 'candidateVersion', validManifest({ candidateVersion: '0.3.68-beta.1', npmVersion: '0.3.68-beta.1' }), expected() ],
      [ 'candidateVersion', validManifest({ candidateVersion: '0.3.68-rc.0', npmVersion: '0.3.68-rc.0' }), expected() ],
      [ 'candidateVersion', validManifest({ candidateVersion: '0.3.68-rc.01', npmVersion: '0.3.68-rc.01' }), expected() ],
      [ 'candidateVersion', validManifest({ candidateVersion: '0.3.68-rc.1.0', npmVersion: '0.3.68-rc.1.0' }), expected() ],
      [ 'candidateVersion', validManifest({ candidateVersion: '0.3.68-rc.1.01', npmVersion: '0.3.68-rc.1.01' }), expected() ],
      [ 'npmPackage', validManifest({ npmPackage: '@undefineds.co/other' }), expected() ],
      [ 'npmVersion', validManifest({ npmVersion: '0.3.68-rc.41' }), expected() ],
    ] as const;

    for (const [ pathName, manifest, expectedInput ] of cases) {
      const result = validateManifest(manifest, expectedInput);
      expect(result.valid, pathName).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: pathName }),
      ]));
    }
  });

  it('rejects missing required checks and non-passed check values', () => {
    expect(validateManifest(validManifest({ checks: { 'build:ts': 'passed' }}), expected()).errors)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'checks.integration' }),
      ]));

    expect(validateManifest(validManifest({ checks: { 'build:ts': 'passed', integration: 'failed' }}), expected()).errors)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'checks.integration' }),
      ]));
  });

  it('requires non-empty expected required checks for pure validation', () => {
    const result = validateManifest(validManifest(), expected({ requiredChecks: [] }));

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'requiredChecks' }),
    ]));
  });

  it('rejects invalid timestamps', () => {
    const result = validateManifest(validManifest({ acceptedAt: 'not-a-date' }), expected());

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'acceptedAt' }),
    ]));
  });

  it('rejects undeclared top-level fields and recursive sensitive field names', () => {
    const withExtraTopLevel = {
      ...validManifest(),
      releaseNotes: 'not declared in schema',
    };
    const withNestedSecret = {
      ...validManifest(),
      metadata: {
        apiKey: 'do-not-leak-this-value',
      },
    };

    expect(validateManifest(withExtraTopLevel, expected()).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'releaseNotes' }),
    ]));

    const result = validateManifest(withNestedSecret, expected());
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'metadata.apiKey' }),
    ]));
    expect(JSON.stringify(result)).not.toContain('do-not-leak-this-value');
  });

  it('does not treat legal check names as sensitive payload fields', () => {
    const manifest = validManifest({
      checks: {
        'build:ts': 'passed',
        integration: 'passed',
        'kubernetes-secret-keys-present': 'passed',
      },
    });

    expect(validateManifest(manifest, expected({
      requiredChecks: [ ...requiredChecks, 'kubernetes-secret-keys-present' ],
    }))).toEqual({ valid: true, errors: [] });
  });

  it('returns validation errors for cyclic metadata instead of throwing or echoing values', () => {
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;
    metadata.note = 'cycle-secret-value';
    const manifest = {
      ...validManifest(),
      metadata,
    };
    let result: ReturnType<typeof validateManifest> | undefined;

    expect(() => {
      result = validateManifest(manifest, expected());
    }).not.toThrow();
    expect(result?.valid).toBe(false);
    expect(result?.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'metadata.self' }),
    ]));
    expect(JSON.stringify(result)).not.toContain('cycle-secret-value');
  });

  it('returns validation errors when metadata traversal exceeds the depth limit', () => {
    const metadata: Record<string, unknown> = {};
    let cursor = metadata;
    for (let index = 0; index < 48; index += 1) {
      cursor.child = {};
      cursor = cursor.child as Record<string, unknown>;
    }

    const result = validateManifest({
      ...validManifest(),
      metadata,
    }, expected());

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('maximum traversal depth') }),
    ]));
  });

  it('does not serialize extra input or environment sentinel secrets through createManifest', () => {
    const manifest = createManifest({
      ...validInput(),
      apiKey: 'input-secret-sentinel',
      env: {
        SECRET_TOKEN: 'nested-secret-sentinel',
      },
    });

    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain('input-secret-sentinel');
    expect(serialized).not.toContain('nested-secret-sentinel');
  });

  it('creates and validates manifests from the CLI', async () => {
    const checksPath = await tempFile('checks.json', JSON.stringify(validInput().checks));

    const { stdout } = await runCli([
      'create',
      '--target-version', '0.3.68',
      '--candidate-version', '0.3.68-rc.42',
      '--source-sha', fullSha,
      '--source-branch', 'release/0.3.68',
      '--image-digest', imageDigest,
      '--npm-package', '@undefineds.co/xpod',
      '--npm-version', '0.3.68-rc.42',
      '--endpoint', 'https://rc.id.undefineds.co',
      '--accepted-at', acceptedAt,
      '--checks-file', checksPath,
    ], {
      SECRET_SENTINEL: 'cli-env-secret-sentinel',
    });

    expect(stdout).not.toContain('cli-env-secret-sentinel');

    const manifestPath = await tempFile('manifest.json', stdout);
    const validation = await runCli([
      'validate',
      '--manifest', manifestPath,
      '--tag', 'v0.3.68',
      '--source-sha', fullSha,
      '--required-check', 'build:ts',
      '--required-check', 'integration',
    ]);

    expect(JSON.parse(validation.stdout)).toEqual({ valid: true, errors: [] });
  });

  it('rejects CLI create when required fields are missing without printing a partial manifest', async () => {
    await expect(runCli([
      'create',
      '--target-version', '0.3.68',
    ], {
      XPOD_SECRET_VALUE: 'create-missing-secret-sentinel',
    })).rejects.toMatchObject({
      stdout: '',
      stderr: expect.stringContaining('manifest validation failed'),
    });

    await expect(runCli([
      'create',
      '--target-version', '0.3.68',
    ], {
      XPOD_SECRET_VALUE: 'create-missing-secret-sentinel',
    })).rejects.toMatchObject({
      stderr: expect.not.stringContaining('create-missing-secret-sentinel'),
    });
  });

  it('rejects CLI create when checks-file is empty', async () => {
    const checksPath = await tempFile('checks.json', '{}');

    await expect(runCli([
      'create',
      '--target-version', '0.3.68',
      '--candidate-version', '0.3.68-rc.42',
      '--source-sha', fullSha,
      '--source-branch', 'release/0.3.68',
      '--image-digest', imageDigest,
      '--npm-package', '@undefineds.co/xpod',
      '--npm-version', '0.3.68-rc.42',
      '--endpoint', 'https://rc.id.undefineds.co',
      '--accepted-at', acceptedAt,
      '--checks-file', checksPath,
    ])).rejects.toMatchObject({
      stdout: '',
      stderr: expect.stringContaining('manifest validation failed'),
    });
  });

  it('rejects CLI create when release constraints fail without leaking secrets', async () => {
    const checksPath = await tempFile('checks.json', JSON.stringify(validInput().checks));

    await expect(runCli([
      'create',
      '--target-version', '0.3.68',
      '--candidate-version', '0.3.69-rc.42',
      '--source-sha', 'not-a-sha',
      '--source-branch', 'main',
      '--image-digest', 'latest',
      '--npm-package', '@undefineds.co/other',
      '--npm-version', '0.3.69-rc.42',
      '--endpoint', 'https://example.com',
      '--accepted-at', 'not-a-date',
      '--checks-file', checksPath,
    ], {
      XPOD_PASSWORD: 'create-invalid-secret-sentinel',
    })).rejects.toMatchObject({
      stdout: '',
      stderr: expect.stringContaining('manifest validation failed'),
    });

    await expect(runCli([
      'create',
      '--target-version', '0.3.68',
      '--candidate-version', '0.3.69-rc.42',
      '--source-sha', 'not-a-sha',
      '--source-branch', 'main',
      '--image-digest', 'latest',
      '--npm-package', '@undefineds.co/other',
      '--npm-version', '0.3.69-rc.42',
      '--endpoint', 'https://example.com',
      '--accepted-at', 'not-a-date',
      '--checks-file', checksPath,
    ], {
      XPOD_PASSWORD: 'create-invalid-secret-sentinel',
    })).rejects.toMatchObject({
      stderr: expect.not.stringContaining('create-invalid-secret-sentinel'),
    });
  });

  it('returns a machine-readable validation failure and non-zero exit code from the CLI', async () => {
    const manifestPath = await tempFile('manifest.json', JSON.stringify(validManifest({ imageDigest: 'latest' })));

    await expect(runCli([
      'validate',
      '--manifest', manifestPath,
      '--tag', 'v0.3.68',
      '--source-sha', fullSha,
      '--required-check', 'build:ts',
      '--required-check', 'integration',
    ], {
      XPOD_PASSWORD: 'cli-error-secret-sentinel',
    })).rejects.toMatchObject({
      stdout: expect.stringContaining('"valid":false'),
      stderr: expect.not.stringContaining('cli-error-secret-sentinel'),
    });
  });

  it('requires at least one required check from the validate CLI', async () => {
    const manifestPath = await tempFile('manifest.json', JSON.stringify(validManifest()));

    await expect(runCli([
      'validate',
      '--manifest', manifestPath,
      '--tag', 'v0.3.68',
      '--source-sha', fullSha,
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining('"valid":false'),
      stderr: '',
    });
  });
});
