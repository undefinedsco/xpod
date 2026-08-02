import { execFile as execFileCallback } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/release-candidate.cjs');
const { deriveCandidate } = require(scriptPath);
const fullSha = '0123456789abcdef0123456789abcdef01234567';

const tempRoots: string[] = [];

async function makeManifestRepo(version = '0.3.67'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-release-candidate-'));
  tempRoots.push(root);

  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({
    name: '@undefineds.co/xpod',
    version,
    optionalDependencies: {
      '@undefineds.co/xpod-darwin-arm64': version,
      '@undefineds.co/xpod-linux-x64-gnu': version,
      untouched: '1.2.3',
    },
  }, null, 2)}\n`);

  await mkdir(path.join(root, 'packages/one'), { recursive: true });
  await mkdir(path.join(root, 'packages/two'), { recursive: true });
  await writeFile(path.join(root, 'packages/one/package.json'), '{ "name": "one", "version": "9.9.9" }\n');
  await writeFile(path.join(root, 'packages/two/package.json'), '{\n  "name": "two",\n  "version": "8.8.8"\n}\n');

  return root;
}

async function readWorkspaceManifests(root: string): Promise<Record<string, string>> {
  return {
    one: await readFile(path.join(root, 'packages/one/package.json'), 'utf8'),
    two: await readFile(path.join(root, 'packages/two/package.json'), 'utf8'),
  };
}

async function runCli(args: string[], options: { repoRoot?: string; env?: NodeJS.ProcessEnv } = {}) {
  return execFile('node', [ scriptPath, ...args ], {
    cwd: options.repoRoot ?? repoRoot,
    env: {
      ...process.env,
      ...options.env,
    },
  });
}

describe('release candidate metadata', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('derives the first candidate from a stable release branch and run metadata', () => {
    expect(deriveCandidate({
      branch: 'release/0.3.68',
      runNumber: 42,
      runAttempt: 1,
      sha: fullSha,
    })).toEqual({
      targetVersion: '0.3.68',
      candidateVersion: '0.3.68-rc.42',
      shaTag: `sha-${fullSha}`,
      sourceSha: fullSha,
    });
  });

  it('adds the run attempt suffix after the first candidate attempt', () => {
    expect(deriveCandidate({
      branch: 'release/0.3.68',
      runNumber: 42,
      runAttempt: 2,
      sha: fullSha,
    }).candidateVersion).toBe('0.3.68-rc.42.2');
  });

  it('prints candidate metadata as JSON from the CLI', async () => {
    const { stdout } = await runCli([
      '--branch', 'release/0.3.68',
      '--run-number', '42',
      '--run-attempt', '1',
      '--sha', fullSha,
      '--json',
    ]);

    expect(JSON.parse(stdout)).toEqual({
      targetVersion: '0.3.68',
      candidateVersion: '0.3.68-rc.42',
      shaTag: `sha-${fullSha}`,
      sourceSha: fullSha,
    });
  });

  it('rejects main branches with release branch guidance', () => {
    expect(() => deriveCandidate({
      branch: 'main',
      runNumber: 42,
      runAttempt: 1,
      sha: fullSha,
    })).toThrow(/release\/<version>/);
  });

  it('rejects prerelease branch versions with stable SemVer guidance', () => {
    expect(() => deriveCandidate({
      branch: 'release/0.3.68-rc.1',
      runNumber: 42,
      runAttempt: 1,
      sha: fullSha,
    })).toThrow(/stable SemVer/);
  });

  it('rejects missing and invalid SHAs', () => {
    expect(() => deriveCandidate({
      branch: 'release/0.3.68',
      runNumber: 42,
      runAttempt: 1,
      sha: '',
    })).toThrow(/SHA/);

    expect(() => deriveCandidate({
      branch: 'release/0.3.68',
      runNumber: 42,
      runAttempt: 1,
      sha: 'not-a-sha',
    })).toThrow(/SHA/);
  });

  it('rejects non-numeric and non-positive run fields', () => {
    expect(() => deriveCandidate({
      branch: 'release/0.3.68',
      runNumber: 'abc',
      runAttempt: 1,
      sha: fullSha,
    })).toThrow(/runNumber/);

    expect(() => deriveCandidate({
      branch: 'release/0.3.68',
      runNumber: 0,
      runAttempt: 1,
      sha: fullSha,
    })).toThrow(/runNumber/);

    expect(() => deriveCandidate({
      branch: 'release/0.3.68',
      runNumber: -1,
      runAttempt: 1,
      sha: fullSha,
    })).toThrow(/runNumber/);

    expect(() => deriveCandidate({
      branch: 'release/0.3.68',
      runNumber: 42,
      runAttempt: 'abc',
      sha: fullSha,
    })).toThrow(/runAttempt/);

    expect(() => deriveCandidate({
      branch: 'release/0.3.68',
      runNumber: 42,
      runAttempt: 0,
      sha: fullSha,
    })).toThrow(/runAttempt/);
  });

  it('fails CLI validation without leaking environment values', async () => {
    await expect(runCli([
      '--branch', 'main',
      '--run-number', '42',
      '--run-attempt', '1',
      '--sha', fullSha,
      '--json',
    ], {
      env: { XPOD_SECRET_VALUE: 'do-not-leak-this-value' },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('release/<version>'),
    });

    await expect(runCli([
      '--branch', 'release/0.3.68',
      '--run-number', 'abc',
      '--run-attempt', '1',
      '--sha', fullSha,
      '--json',
    ], {
      env: { XPOD_SECRET_VALUE: 'do-not-leak-this-value' },
    })).rejects.toMatchObject({
      stderr: expect.not.stringContaining('do-not-leak-this-value'),
    });
  });

  it('applies the candidate version only to the root manifest and syncs root platform optional dependencies', async () => {
    const manifestRoot = await makeManifestRepo();
    const beforeWorkspaceManifests = await readWorkspaceManifests(manifestRoot);

    const { stdout } = await runCli([
      '--branch', 'release/0.3.68',
      '--run-number', '42',
      '--run-attempt', '2',
      '--sha', fullSha,
      '--json',
      '--apply-root-version',
      '--repo-root', manifestRoot,
    ], { repoRoot: manifestRoot });

    expect(JSON.parse(stdout)).toMatchObject({
      targetVersion: '0.3.68',
      candidateVersion: '0.3.68-rc.42.2',
    });

    const rootManifest = JSON.parse(await readFile(path.join(manifestRoot, 'package.json'), 'utf8'));
    expect(rootManifest.version).toBe('0.3.68-rc.42.2');
    expect(rootManifest.optionalDependencies['@undefineds.co/xpod-darwin-arm64']).toBe('0.3.68-rc.42.2');
    expect(rootManifest.optionalDependencies['@undefineds.co/xpod-linux-x64-gnu']).toBe('0.3.68-rc.42.2');
    expect(rootManifest.optionalDependencies.untouched).toBe('1.2.3');
    await expect(readWorkspaceManifests(manifestRoot)).resolves.toEqual(beforeWorkspaceManifests);
  });
});
