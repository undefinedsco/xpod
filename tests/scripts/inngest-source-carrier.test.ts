import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const requireFromHere = createRequire(import.meta.url);
const embeddedNativeSource = requireFromHere('../../scripts/lib/embedded-native-source.cjs') as {
  EMBEDDED_NATIVE_SOURCE_PINS: Record<string, unknown>;
  resolveEmbeddedNativeSourcePin(packageName?: string): SourcePin;
  assertSourcePinMatchesInstalled(options: {
    pin: SourcePin;
    nodeModulesRoot: string;
    target: string;
    packageName?: string;
  }): void;
  verifySourceArchive(filePath: string, pin: SourcePin): void;
  verifyEmbeddedDocsRoot(docsRoot: string, pin: SourcePin): { fileCount: number; aggregate: string };
  stageEmbeddedNativeSource(stageDir: string, options: {
    pin: SourcePin;
    target: string;
    nodeModulesRoot: string;
    artifactPath?: string;
    docsRoot?: string;
  }): Promise<{ relativeDir: string; files: string[]; manifestSha256: string }>;
  verifyInstalledNativeSource(options: {
    packageRoot: string;
    manifestRelativePath: string;
    manifestSha256: string;
    pin?: SourcePin;
    target?: string;
  }): {
    manifestPath: string;
    manifestSha256: string;
    target: string;
    archiveSha256: string;
    licenseSha256: string;
    docsFileCount: number;
    docsAggregate: string;
  };
};

interface SourcePin {
  packageName: string;
  packageVersion: string;
  binaryRelativePath?: string;
  targets: Record<string, { binarySha256: string; binarySizeBytes: number; binaryVersionString: string }>;
  upstream: { repository: string; tag: string; commit: string };
  license: { installedRelativePath: string; sha256: string; sizeBytes: number; spdx: string; futureLicense: string; copyright: string };
  sourceArchive: { url: string; fileName: string; sha256: string; sizeBytes: number; memberCount: number; rootDir: string };
  embedDocs: { repository: string; commit: string; sourcePath: string; fileCount: number; filesSha256Aggregate: string; rawFileUrlTemplate: string };
}

const repoRoot = process.cwd();
const testRoot = path.join(repoRoot, '.test-data', 'opencode-shared', 'inngest-source-wiring', 'unit');
const roots: string[] = [];
const realCarrierRoot = path.join(repoRoot, '.test-data', 'opencode-shared', 'inngest-packaging', 'source-carrier');
const realCarrierArchive = path.join(realCarrierRoot, 'upstream', 'inngest-0d75b0b305010b5e90a627703e9d1df4464b1e39.tar.gz');
const realCarrierDocs = path.join(realCarrierRoot, 'submodule-website');
const hasRealCarrier = existsSync(realCarrierArchive) && existsSync(realCarrierDocs);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function newRoot(): string {
  const root = path.join(testRoot, `case-${roots.length}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function sha256File(file: string): string {
  return sha256(readFileSync(file));
}

function listFiles(root: string): string[] {
  const result: string[] = [];
  const stack = [ root ];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of require('node:fs').readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else result.push(full);
    }
  }
  return result;
}

function aggregateDocs(docsRoot: string): string {
  const lines = listFiles(docsRoot)
    .map((file) => ({ rel: path.relative(docsRoot, file).split(path.sep).join('/'), sha: sha256File(file) }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map((entry) => `${entry.sha}  ${entry.rel}`);
  return sha256(`${lines.join('\n')}\n`);
}

function makeSyntheticPin(root: string): SourcePin {
  const nodeModulesRoot = path.join(root, 'node_modules');
  const pkgDir = path.join(nodeModulesRoot, 'inngest-cli');
  mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'inngest-cli', version: '1.40.0' }));
  const licenseText = '# Server Side Public License, Version 1.0\nCopyright (c) 2022 Inngest, Inc.\n';
  writeFileSync(path.join(pkgDir, 'bin', 'LICENSE.md'), licenseText);
  // Mach-O arm64 header so the installed binary binding can read the real target.
  const binary = Buffer.alloc(64);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(0x0100000c, 4);
  writeFileSync(path.join(pkgDir, 'bin', 'inngest'), binary);
  chmodSync(path.join(pkgDir, 'bin', 'inngest'), 0o755);

  const artifactRoot = path.join(root, 'artifact');
  mkdirSync(path.join(artifactRoot, 'src'), { recursive: true });
  writeFileSync(path.join(artifactRoot, 'src', 'main.go'), 'package main\n');
  writeFileSync(path.join(artifactRoot, 'LICENSE.md'), licenseText);
  const archivePath = path.join(root, 'upstream.tar.gz');
  expect(spawnSync('tar', [ '-czf', archivePath, '-C', artifactRoot, '.' ]).status).toBe(0);
  const archiveBytes = readFileSync(archivePath);
  const memberCount = spawnSync('tar', [ '-tzf', archivePath ], { encoding: 'utf8' }).stdout.trim().split('\n').length;

  const docsRoot = path.join(root, 'docs');
  mkdirSync(path.join(docsRoot, 'pages', 'docs', 'apps'), { recursive: true });
  writeFileSync(path.join(docsRoot, 'pages', 'docs', 'index.mdx'), '# docs\n');
  writeFileSync(path.join(docsRoot, 'pages', 'docs', 'apps', 'cloud.mdx'), '# cloud\n');

  const commit = 'a'.repeat(40);
  const subCommit = 'b'.repeat(40);
  return {
    packageName: 'inngest-cli',
    packageVersion: '1.40.0',
    binaryRelativePath: 'bin/inngest',
    targets: { 'darwin-arm64': { binarySha256: sha256File(path.join(pkgDir, 'bin', 'inngest')), binarySizeBytes: 64, binaryVersionString: '1.40.0-aaaaaaaa' } },
    upstream: { repository: 'https://github.com/inngest/inngest', tag: 'v1.40.0', commit },
    license: { installedRelativePath: 'bin/LICENSE.md', sha256: sha256(licenseText), sizeBytes: Buffer.byteLength(licenseText), spdx: 'SSPL-1.0', futureLicense: 'Apache-2.0', copyright: 'Copyright (c) 2022 Inngest, Inc.' },
    sourceArchive: { url: 'https://example.invalid/source.tar.gz', fileName: `inngest-${commit}.tar.gz`, sha256: sha256(archiveBytes), sizeBytes: archiveBytes.length, memberCount, rootDir: './' },
    embedDocs: { repository: 'https://github.com/inngest/website', commit: subCommit, sourcePath: 'pages/docs', fileCount: listFiles(docsRoot).length, filesSha256Aggregate: aggregateDocs(docsRoot), rawFileUrlTemplate: `https://raw.githubusercontent.com/inngest/website/${subCommit}/<path>` },
  };
}

async function stageSyntheticInstalledPackage(root: string, pin: SourcePin): Promise<{ packageRoot: string; manifestSha256: string }> {
  const packageRoot = path.join(root, 'installed-platform');
  mkdirSync(packageRoot, { recursive: true });
  const result = await embeddedNativeSource.stageEmbeddedNativeSource(packageRoot, {
    pin,
    target: 'darwin-arm64',
    nodeModulesRoot: path.join(root, 'node_modules'),
    artifactPath: path.join(root, 'upstream.tar.gz'),
    docsRoot: path.join(root, 'docs'),
  });
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@undefineds.co/xpod-darwin-arm64',
    xpodEmbeddedSource: `./${result.relativeDir}/SOURCE-MANIFEST.json`,
    xpodEmbeddedSourceSha256: result.manifestSha256,
  }));
  return { packageRoot, manifestSha256: result.manifestSha256 };
}

describe('embedded native CLI source carrier', () => {
  it('exports a single pinned source identity for inngest-cli', () => {
    const pin = embeddedNativeSource.resolveEmbeddedNativeSourcePin('inngest-cli');
    expect(pin.upstream.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(pin.sourceArchive.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(embeddedNativeSource.EMBEDDED_NATIVE_SOURCE_PINS)).toEqual([ 'inngest-cli' ]);
  });

  it('verifies the installed package binding against the pin', () => {
    const root = newRoot();
    const pin = makeSyntheticPin(root);
    expect(() => embeddedNativeSource.assertSourcePinMatchesInstalled({
      pin, nodeModulesRoot: path.join(root, 'node_modules'), target: 'darwin-arm64',
    })).not.toThrow();
  });

  it('stages a SOURCE sidecar with actual source, license, docs and NOTICE', async () => {
    const root = newRoot();
    const pin = makeSyntheticPin(root);
    const stageDir = path.join(root, 'stage');
    const result = await embeddedNativeSource.stageEmbeddedNativeSource(stageDir, {
      pin,
      target: 'darwin-arm64',
      nodeModulesRoot: path.join(root, 'node_modules'),
      artifactPath: path.join(root, 'upstream.tar.gz'),
      docsRoot: path.join(root, 'docs'),
    });

    const sourceDir = path.join(stageDir, result.relativeDir);
    for (const relative of [
      'SOURCE-MANIFEST.json',
      'NOTICE',
      'LICENSE-inngest-cli.md',
      `upstream/${pin.sourceArchive.fileName}`,
      'upstream/submodule-docs-sha256.txt',
      'submodule-website/pages/docs/index.mdx',
      'submodule-website/pages/docs/apps/cloud.mdx',
    ]) {
      expect(existsSync(path.join(sourceDir, relative)), relative).toBe(true);
    }
    expect(readFileSync(path.join(sourceDir, 'LICENSE-inngest-cli.md'), 'utf8')).toBe(readFileSync(path.join(root, 'node_modules', 'inngest-cli', 'bin', 'LICENSE.md'), 'utf8'));
    expect(sha256File(path.join(sourceDir, `upstream/${pin.sourceArchive.fileName}`))).toBe(pin.sourceArchive.sha256);
    const manifest = JSON.parse(readFileSync(path.join(sourceDir, 'SOURCE-MANIFEST.json'), 'utf8'));
    expect(manifest.upstream.commit).toBe(pin.upstream.commit);
    expect(manifest.embedDocs.filesSha256Aggregate).toBe(pin.embedDocs.filesSha256Aggregate);
    expect(manifest.binary.sha256).toBe(pin.targets['darwin-arm64'].binarySha256);
    const notice = readFileSync(path.join(sourceDir, 'NOTICE'), 'utf8');
    expect(notice).toContain(pin.upstream.commit);
    expect(notice).toContain('SSPL-1.0');
    expect(notice).toContain(pin.license.copyright);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a missing source archive, archive drift and docs drift', async () => {
    const root = newRoot();
    const pin = makeSyntheticPin(root);
    const nodeModulesRoot = path.join(root, 'node_modules');
    const stageDir = path.join(root, 'stage');

    await expect(embeddedNativeSource.stageEmbeddedNativeSource(stageDir, {
      pin, target: 'darwin-arm64', nodeModulesRoot,
      artifactPath: path.join(root, 'missing.tar.gz'), docsRoot: path.join(root, 'docs'),
    })).rejects.toThrow(/source archive/i);

    const driftedArchive = path.join(root, 'drifted.tar.gz');
    writeFileSync(driftedArchive, 'not the pinned archive');
    expect(() => embeddedNativeSource.verifySourceArchive(driftedArchive, pin)).toThrow(/hash|size/i);

    const before = embeddedNativeSource.verifyEmbeddedDocsRoot(path.join(root, 'docs'), pin);
    expect(before.fileCount).toBe(pin.embedDocs.fileCount);
    writeFileSync(path.join(root, 'docs', 'pages', 'docs', 'extra.mdx'), 'drift\n');
    expect(() => embeddedNativeSource.verifyEmbeddedDocsRoot(path.join(root, 'docs'), pin)).toThrow(/file count|aggregate/i);
  });

  it('rejects an installed package that drifted from the pin', () => {
    const root = newRoot();
    const pin = makeSyntheticPin(root);
    const packageJsonPath = path.join(root, 'node_modules', 'inngest-cli', 'package.json');
    writeFileSync(packageJsonPath, JSON.stringify({ name: 'inngest-cli', version: '1.41.0' }));
    expect(() => embeddedNativeSource.assertSourcePinMatchesInstalled({
      pin, nodeModulesRoot: path.join(root, 'node_modules'), target: 'darwin-arm64',
    })).toThrow(/version/i);
  });

  it('verifies an installed SOURCE sidecar against the pin, not just its self-reported digest', async () => {
    const root = newRoot();
    const pin = makeSyntheticPin(root);
    const { packageRoot, manifestSha256 } = await stageSyntheticInstalledPackage(root, pin);

    const result = embeddedNativeSource.verifyInstalledNativeSource({
      packageRoot,
      manifestRelativePath: './SOURCE/SOURCE-MANIFEST.json',
      manifestSha256,
      pin,
    });

    expect(result.manifestPath).toContain(path.join('SOURCE', 'SOURCE-MANIFEST.json'));
    expect(result.target).toBe('darwin-arm64');
    expect(result.archiveSha256).toBe(pin.sourceArchive.sha256);
    expect(result.licenseSha256).toBe(pin.license.sha256);
    expect(result.docsFileCount).toBe(pin.embedDocs.fileCount);
    expect(result.docsAggregate).toBe(pin.embedDocs.filesSha256Aggregate);
  });

  it('rejects a missing manifest, a self-reported digest mismatch and a path escape', async () => {
    const root = newRoot();
    const pin = makeSyntheticPin(root);
    const { packageRoot, manifestSha256 } = await stageSyntheticInstalledPackage(root, pin);

    expect(() => embeddedNativeSource.verifyInstalledNativeSource({
      packageRoot, manifestRelativePath: './SOURCE/MISSING.json', manifestSha256, pin,
    })).toThrow(/not found/);

    expect(() => embeddedNativeSource.verifyInstalledNativeSource({
      packageRoot, manifestRelativePath: './SOURCE/SOURCE-MANIFEST.json', manifestSha256: 'f'.repeat(64), pin,
    })).toThrow(/manifest digest mismatch/);

    const outside = path.join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'SOURCE-MANIFEST.json'), '{}');
    expect(() => embeddedNativeSource.verifyInstalledNativeSource({
      packageRoot, manifestRelativePath: '../outside/SOURCE-MANIFEST.json', manifestSha256, pin,
    })).toThrow(/escapes/);
    expect(() => embeddedNativeSource.verifyInstalledNativeSource({
      packageRoot, manifestRelativePath: path.join(outside, 'SOURCE-MANIFEST.json'), manifestSha256, pin,
    })).toThrow(/escapes/);
  });

  it('rejects archive, license, docs, sha-list and NOTICE drift in an installed sidecar', async () => {
    // Rebuild fixtures per mutation so drift types stay isolated.
    async function verify(root: string, mutate: (packageRoot: string) => void): Promise<string> {
      const pin = makeSyntheticPin(root);
      const { packageRoot, manifestSha256 } = await stageSyntheticInstalledPackage(root, pin);
      mutate(packageRoot);
      try {
        embeddedNativeSource.verifyInstalledNativeSource({ packageRoot, manifestRelativePath: './SOURCE/SOURCE-MANIFEST.json', manifestSha256, pin });
        return 'no-throw';
      } catch (error) {
        return (error as Error).message;
      }
    }

    expect(await verify(newRoot(), (packageRoot) => {
      const archive = path.join(packageRoot, 'SOURCE', 'upstream');
      const file = readFileSync(path.join(packageRoot, 'SOURCE', 'SOURCE-MANIFEST.json'), 'utf8');
      const name = JSON.parse(file).sourceArchive.path.split('/').pop();
      appendFileSync(path.join(archive, name), 'x');
    })).toMatch(/hash|size/);

    expect(await verify(newRoot(), (packageRoot) => {
      writeFileSync(path.join(packageRoot, 'SOURCE', 'LICENSE-inngest-cli.md'), 'tampered');
    })).toMatch(/license drift/);

    expect(await verify(newRoot(), (packageRoot) => {
      writeFileSync(path.join(packageRoot, 'SOURCE', 'submodule-website', 'pages', 'docs', 'extra.mdx'), 'drift\n');
    })).toMatch(/file count|aggregate/);

    expect(await verify(newRoot(), (packageRoot) => {
      writeFileSync(path.join(packageRoot, 'SOURCE', 'upstream', 'submodule-docs-sha256.txt'), 'tampered\n');
    })).toMatch(/sha list/);

    expect(await verify(newRoot(), (packageRoot) => {
      writeFileSync(path.join(packageRoot, 'SOURCE', 'NOTICE'), 'tampered');
    })).toMatch(/NOTICE is missing/);
  });

  it.skipIf(!hasRealCarrier)('verifies a real staged sidecar from the hash-verified private cache', async () => {
    const pin = embeddedNativeSource.resolveEmbeddedNativeSourcePin('inngest-cli');
    const root = newRoot();
    const packageRoot = path.join(root, 'installed-platform');
    mkdirSync(packageRoot, { recursive: true });
    const staged = await embeddedNativeSource.stageEmbeddedNativeSource(packageRoot, {
      pin,
      target: 'darwin-arm64',
      nodeModulesRoot: path.join(repoRoot, 'node_modules'),
      artifactPath: realCarrierArchive,
      docsRoot: realCarrierDocs,
    });
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@undefineds.co/xpod-darwin-arm64',
      xpodEmbeddedSource: `./${staged.relativeDir}/SOURCE-MANIFEST.json`,
      xpodEmbeddedSourceSha256: staged.manifestSha256,
    }));
    const result = embeddedNativeSource.verifyInstalledNativeSource({
      packageRoot,
      manifestRelativePath: './SOURCE/SOURCE-MANIFEST.json',
      manifestSha256: staged.manifestSha256,
      pin,
    });
    expect(result.archiveSha256).toBe(pin.sourceArchive.sha256);
    expect(result.docsFileCount).toBe(pin.embedDocs.fileCount);
  });
});
