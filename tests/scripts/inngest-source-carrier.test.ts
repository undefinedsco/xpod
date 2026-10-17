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
  obtainEmbedDocs(pin: SourcePin, options?: { cacheDir?: string; docsRoot?: string }): Promise<{ docsRoot: string; obtained: string }>;
  obtainSourceArchive(pin: SourcePin, options?: { cacheDir?: string; artifactPath?: string }): Promise<{ path: string; obtained: 'provided' | 'cache' | 'download' }>;
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
  sourceArchive: { url: string; urlTemplate?: string; fileName: string; sha256: string; sizeBytes: number; memberCount: number; rootDir: string };
  embedDocs: { repository: string; commit: string; sourcePath: string; fileCount: number; filesSha256Aggregate: string; rawFileUrlTemplate: string; treeApiUrlTemplate: string };
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
    embedDocs: {
      repository: 'https://github.com/inngest/website',
      commit: subCommit,
      sourcePath: 'pages/docs',
      fileCount: listFiles(docsRoot).length,
      filesSha256Aggregate: aggregateDocs(docsRoot),
      rawFileUrlTemplate: `https://raw.githubusercontent.com/inngest/website/${subCommit}/<path>`,
      treeApiUrlTemplate: `https://api.github.com/repos/inngest/website/git/trees/<commit>?recursive=1`,
    },
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

function makePinnedSyntheticPin(root: string): SourcePin {
  const pin = makeSyntheticPin(root);
  const fixed = embeddedNativeSource.resolveEmbeddedNativeSourcePin().embedDocs;
  pin.embedDocs.commit = fixed.commit;
  pin.embedDocs.treeApiUrlTemplate = fixed.treeApiUrlTemplate;
  pin.embedDocs.rawFileUrlTemplate = fixed.rawFileUrlTemplate;
  return pin;
}

describe('embedded docs GitHub reliability (HTTP 403)', () => {
  const realFetch = globalThis.fetch;
  const realGhToken = process.env.GH_TOKEN;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realGhToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = realGhToken;
    }
  });

  type FetchCall = { url: string; authorization: string | undefined; redirect: string | undefined };

  function installMockFetch(handler: (url: string) => Response): FetchCall[] {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, authorization: headers.get('authorization') ?? undefined, redirect: init?.redirect as string | undefined });
      return handler(url);
    }) as unknown as typeof fetch;
    return calls;
  }

  function withTreeUrl(pin: SourcePin, treeApiUrlTemplate: string): SourcePin {
    return { ...pin, embedDocs: { ...pin.embedDocs, treeApiUrlTemplate } };
  }

  it('fails closed on the anonymous 403 without inventing a fallback or partial cache', async () => {
    const root = newRoot();
    const pin = makePinnedSyntheticPin(root);
    delete process.env.GH_TOKEN;
    const calls = installMockFetch(() => new Response(
      JSON.stringify({ message: 'API rate limit exceeded for 1.2.3.4' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ));

    await expect(embeddedNativeSource.obtainEmbedDocs(pin, { cacheDir: path.join(root, 'cache') }))
      .rejects.toThrow(/embedded docs tree: HTTP 403/);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('https://api.github.com/repos/inngest/website/git/trees/');
    expect(calls[0].authorization).toBeUndefined();
    expect(calls[0].redirect).toBe('manual');
    expect(existsSync(path.join(root, 'cache'))).toBe(false);
  });

  it('authenticates the exact api.github.com tree read and completes the pinned docs', async () => {
    const root = newRoot();
    const pin = makePinnedSyntheticPin(root);
    const docsRoot = path.join(root, 'docs');
    process.env.GH_TOKEN = '  ghs_test_ci_token  ';
    const calls = installMockFetch((url) => {
      if (url.startsWith('https://api.github.com/')) {
        if (!url.endsWith('?recursive=1') || !url.includes(pin.embedDocs.commit)) {
          return new Response('wrong tree url', { status: 404 });
        }
        const tree = listFiles(docsRoot).map((file) => ({
          path: path.relative(docsRoot, file).split(path.sep).join('/'),
          type: 'blob',
        }));
        return new Response(JSON.stringify({ truncated: false, tree }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('https://raw.githubusercontent.com/')) {
        const marker = `/${pin.embedDocs.commit}/`;
        const relative = decodeURIComponent(url.slice(url.indexOf(marker) + marker.length));
        return new Response(readFileSync(path.join(docsRoot, relative)), { status: 200 });
      }
      return new Response('unexpected host', { status: 500 });
    });

    const obtained = await embeddedNativeSource.obtainEmbedDocs(pin, { cacheDir: path.join(root, 'cache') });
    expect(obtained.obtained).toBe('download');
    expect(obtained.docsRoot).toBe(path.join(root, 'cache', `inngest-cli-${pin.embedDocs.commit}-docs`));
    expect(embeddedNativeSource.verifyEmbeddedDocsRoot(obtained.docsRoot, pin)).toEqual({
      fileCount: pin.embedDocs.fileCount,
      aggregate: pin.embedDocs.filesSha256Aggregate,
    });

    const apiCalls = calls.filter((call) => call.url.startsWith('https://api.github.com/'));
    const rawCalls = calls.filter((call) => call.url.startsWith('https://raw.githubusercontent.com/'));
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0].authorization).toBe('Bearer ghs_test_ci_token');
    expect(apiCalls[0].redirect).toBe('manual');
    expect(rawCalls.length).toBeGreaterThan(0);
    for (const call of rawCalls) {
      expect(call.authorization).toBeUndefined();
      expect(call.redirect).toBe('follow');
    }
  });

  it('never sends GH_TOKEN over http, an extra port or a foreign host', async () => {
    process.env.GH_TOKEN = 'ghs_test_ci_token';
    for (const template of [
      'http://api.github.com/repos/inngest/website/git/trees/<commit>?recursive=1',
      'https://api.github.com:8443/repos/inngest/website/git/trees/<commit>?recursive=1',
      'https://evil.example.com/repos/inngest/website/git/trees/<commit>?recursive=1',
    ]) {
      const root = newRoot();
      const pin = withTreeUrl(makePinnedSyntheticPin(root), template);
      const calls = installMockFetch(() => new Response('blocked', { status: 403 }));

      await expect(embeddedNativeSource.obtainEmbedDocs(pin, { cacheDir: path.join(root, 'cache') }))
        .rejects.toThrow(/pinned HTTPS API identity/);
      expect(calls).toHaveLength(0);
    }
  });

  it('fails closed when the authenticated tree read is redirected', async () => {
    const root = newRoot();
    const pin = makePinnedSyntheticPin(root);
    process.env.GH_TOKEN = 'ghs_test_ci_token';
    const calls = installMockFetch(() => new Response(null, {
      status: 302,
      headers: { location: 'https://codeload.github.com/inngest/website/legacy.tar.gz/x' },
    }));

    await expect(embeddedNativeSource.obtainEmbedDocs(pin, { cacheDir: path.join(root, 'cache') }))
      .rejects.toThrow(/redirect refused/);

    expect(calls).toHaveLength(1);
    expect(calls[0].authorization).toBe('Bearer ghs_test_ci_token');
    expect(calls[0].redirect).toBe('manual');
    expect(existsSync(path.join(root, 'cache'))).toBe(false);
  });
});

describe('cold-cache embedded docs acquisition authentication', () => {
  const token = 'synthetic-docs-token';
  function fixture() {
    const root = newRoot();
    const pin = makePinnedSyntheticPin(root);
    return { root, pin, cacheDir: path.join(root, 'cold-cache') };
  }
  function mockDownloads(root: string) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [
        { type: 'blob', path: 'pages/docs/index.mdx' },
        { type: 'blob', path: 'pages/docs/apps/cloud.mdx' },
      ] }));
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return new Response(readFileSync(path.join(root, 'docs', new URL(url).pathname.split('/').slice(4).join('/'))));
    });
  }
  it('authenticates only the exact pinned tree and verifies downloaded content', async () => {
    const { root, pin, cacheDir } = fixture();
    vi.stubEnv('GH_TOKEN', token);
    const fetchMock = mockDownloads(root);
    vi.stubGlobal('fetch', fetchMock);
    await embeddedNativeSource.obtainEmbedDocs(pin, { cacheDir });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('keeps the local unauthenticated acquisition path', async () => {
    const { root, pin, cacheDir } = fixture();
    vi.stubEnv('GH_TOKEN', '');
    const fetchMock = mockDownloads(root);
    vi.stubGlobal('fetch', fetchMock);
    await embeddedNativeSource.obtainEmbedDocs(pin, { cacheDir });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
  });
  it.each([
    'https://foreign.invalid/tree', 'http://api.github.com/repos/inngest/website/git/trees/<commit>?recursive=1',
    'not-a-url', 'https://api.github.com/repos/inngest/website/git/trees/other?recursive=1',
    'https://user:password@api.github.com/repos/inngest/website/git/trees/<commit>?recursive=1',
  ])('never sends credentials to an invalid tree identity: %s', async (template) => {
    const { pin, cacheDir } = fixture();
    pin.embedDocs.treeApiUrlTemplate = template;
    vi.stubEnv('GH_TOKEN', token);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return new Response('', { status: 403 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(embeddedNativeSource.obtainEmbedDocs(pin, { cacheDir })).rejects.toThrow(/pinned HTTPS API identity/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([301, 302, 303, 307, 308])('refuses tree redirect %s without requesting its destination', async (status) => {
    const { pin, cacheDir } = fixture();
    vi.stubEnv('GH_TOKEN', token);
    const fetchMock = vi.fn(async () => new Response('', { status, headers: { Location: 'https://foreign.invalid/secret-target' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(embeddedNativeSource.obtainEmbedDocs(pin, { cacheDir })).rejects.toThrow(/redirect/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toBeDefined();
  });
  it('reports 403 safely and never stages rejected source', async () => {
    const { root, pin, cacheDir } = fixture();
    vi.stubEnv('GH_TOKEN', token);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(token, { status: 403 })));
    await expect(embeddedNativeSource.obtainEmbedDocs(pin, { cacheDir })).rejects.toThrow('Failed to read embedded docs tree: HTTP 403');
    expect(existsSync(path.join(cacheDir, `${pin.packageName}-${pin.embedDocs.commit}-docs`))).toBe(false);
    expect(existsSync(path.join(root, 'stage', 'SOURCE'))).toBe(false);
  });
  it('refuses a truncated tree before raw downloads', async () => {
    const { pin, cacheDir } = fixture();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ truncated: true, tree: [] })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(embeddedNativeSource.obtainEmbedDocs(pin, { cacheDir })).rejects.toThrow(/truncated/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('refuses downloaded aggregate drift', async () => {
    const { root, pin, cacheDir } = fixture();
    pin.embedDocs.filesSha256Aggregate = 'f'.repeat(64);
    vi.stubGlobal('fetch', mockDownloads(root));
    await expect(embeddedNativeSource.obtainEmbedDocs(pin, { cacheDir })).rejects.toThrow(/aggregate hash/);
  });
  it('refuses a changed pinned commit before making a request', async () => {
    const { pin, cacheDir } = fixture();
    pin.embedDocs.commit = 'c'.repeat(40);
    vi.stubEnv('GH_TOKEN', token);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(embeddedNativeSource.obtainEmbedDocs(pin, { cacheDir })).rejects.toThrow(/pinned HTTPS API identity/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['request', 'json'])('does not relay sensitive %s errors', async (failure) => {
    const { pin, cacheDir } = fixture();
    vi.stubEnv('GH_TOKEN', token);
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (failure === 'request') throw new Error(`${token} https://private.invalid/`);
      return new Response(token);
    }));
    try {
      await embeddedNativeSource.obtainEmbedDocs(pin, { cacheDir });
      throw new Error('Expected acquisition to fail');
    } catch (error) {
      expect((error as Error).message).toBe(failure === 'request'
        ? 'Failed to read embedded docs tree: request failed'
        : 'Embedded docs tree response is not valid JSON');
    }
  });
  it('reuses verified cache without another authenticated request', async () => {
    const { root, pin, cacheDir } = fixture();
    vi.stubEnv('GH_TOKEN', token);
    const fetchMock = mockDownloads(root);
    vi.stubGlobal('fetch', fetchMock);
    await embeddedNativeSource.obtainEmbedDocs(pin, { cacheDir });
    fetchMock.mockClear();
    await embeddedNativeSource.obtainEmbedDocs(pin, { cacheDir });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('never authenticates source archives even on the API origin', async () => {
    const { root, pin, cacheDir } = fixture();
    pin.sourceArchive.urlTemplate = 'https://api.github.com/repos/inngest/inngest/tarball/<commit>';
    vi.stubEnv('GH_TOKEN', token);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return new Response(readFileSync(path.join(root, 'upstream.tar.gz')));
    });
    vi.stubGlobal('fetch', fetchMock);
    await embeddedNativeSource.obtainSourceArchive(pin, { cacheDir });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
