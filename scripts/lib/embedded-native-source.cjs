#!/usr/bin/env node
'use strict';

/**
 * Corresponding-Source sidecar for the native CLI embedded in the platform
 * package (and therefore in desktop.runtime).
 *
 * The installed npm package is the single authority for the release pin. A
 * build either supplies the already-verified source archive/docs, or reuses a
 * fixed cache, or downloads from the public pinned URL, and verifies the exact
 * hash/size/member/aggregate. Any drift (installed package, binary, license,
 * archive, embedded docs) fails the build instead of shipping mismatched
 * source.
 *
 * This is a small, inngest-specific contract, not a generic license framework.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { readNativeBinaryTarget } = require('./embedded-native-cli.cjs');
// Reuse the platform-package constant; never define a second `SOURCE` literal.
const { EMBEDDED_SOURCE_RELATIVE_PATH } = require('../platform-binaries.cjs');

const ARCHIVE_FETCH_TIMEOUT_MS = 15 * 60 * 1000;
const DOCS_TREE_FETCH_TIMEOUT_MS = 60 * 1000;
const DOCS_FILE_FETCH_TIMEOUT_MS = 60 * 1000;

// The single source pin. Bind to the installed package version, the actual
// binary (sha256 + real Mach-O/ELF target), the license text, the upstream
// source archive and the embedded docs inputs. Update only together.
const EMBEDDED_NATIVE_SOURCE_PINS = {
  'inngest-cli': {
    packageVersion: '1.40.0',
    binaryRelativePath: 'bin/inngest',
    targets: {
      'darwin-arm64': {
        binarySha256: 'b4e085c7d50d55a522f2b421615a0a37402518be07ce139efce3ec064e772c0c',
        binarySizeBytes: 99840138,
        binaryVersionString: '1.40.0-0d75b0b30',
      },
    },
    upstream: {
      repository: 'https://github.com/inngest/inngest',
      tag: 'v1.40.0',
      commit: '0d75b0b305010b5e90a627703e9d1df4464b1e39',
      releasePublishedAt: '2026-07-30T21:12:16Z',
    },
    license: {
      installedRelativePath: 'bin/LICENSE.md',
      sha256: '300ec5a863250241755061b8424ac949aeada4c5c2cb567a2642637aa0f2c7e4',
      sizeBytes: 30630,
      spdx: 'SSPL-1.0',
      futureLicense: 'Apache-2.0',
      futureLicenseEffectiveAt: '2029-07-30',
      copyright: 'Copyright (c) 2022 Inngest, Inc.',
    },
    sourceArchive: {
      urlTemplate: 'https://api.github.com/repos/inngest/inngest/tarball/<commit>',
      fileName: 'inngest-0d75b0b305010b5e90a627703e9d1df4464b1e39.tar.gz',
      sha256: 'dd6c84ec9e2660ae5fb0ee0ff3d16d9dcce9ca96d93c8e886b2adcd401541906',
      sizeBytes: 78012509,
      memberCount: 15302,
      rootDir: 'inngest-inngest-0d75b0b/',
    },
    embedDocs: {
      repository: 'https://github.com/inngest/website',
      commit: '159c0ac611e85ec85ffe0a8c8bf2c4a0330bdb38',
      submodulePath: 'internal/embeddocs/website',
      sourcePath: 'pages/docs',
      fileCount: 174,
      filesSha256Aggregate: '81c6015671a2901e594fcaaaff0ca0d8f361616d27d4552a7b3b6161bef98405',
      treeApiUrlTemplate: 'https://api.github.com/repos/inngest/website/git/trees/<commit>?recursive=1',
      rawFileUrlTemplate: 'https://raw.githubusercontent.com/inngest/website/<commit>/<path>',
      independentLicense: null,
      independentLicenseNote: 'No root LICENSE/NOTICE in inngest/website at the pinned commit; only vendored snippet licenses living outside pages/docs. No separate notice text exists to copy.',
    },
  },
};

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function listFilesRecursive(root) {
  const result = [];
  if (!fs.existsSync(root)) {
    return result;
  }
  const stack = [ root ];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        result.push(full);
      }
    }
  }
  return result;
}

function docsSha256Lines(docsRoot, sourcePath) {
  const embedRoot = path.join(docsRoot, sourcePath);
  return listFilesRecursive(embedRoot)
    .map((file) => ({
      rel: path.relative(docsRoot, file).split(path.sep).join(path.posix.sep),
      sha: sha256File(file),
    }))
    .sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0))
    .map((entry) => `${entry.sha}  ${entry.rel}`);
}

function aggregateDocsSha256(docsRoot, sourcePath) {
  return sha256(`${docsSha256Lines(docsRoot, sourcePath).join('\n')}\n`);
}

function resolveEmbeddedNativeSourcePin(packageName = 'inngest-cli') {
  const pin = EMBEDDED_NATIVE_SOURCE_PINS[packageName];
  if (!pin) {
    throw new Error(`No embedded native source pin for ${packageName}`);
  }
  return { packageName, ...pin };
}

function assertSourcePinMatchesInstalled({ pin, nodeModulesRoot, target, packageName = pin.packageName }) {
  const packageDir = path.join(nodeModulesRoot, packageName);
  const packageJsonPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Installed package is missing: ${packageJsonPath}`);
  }
  const installed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (installed.name !== packageName || installed.version !== pin.packageVersion) {
    throw new Error(`Installed ${packageName} version ${installed.version} drifted from pinned ${pin.packageVersion}`);
  }

  const binding = pin.targets[target];
  if (!binding) {
    throw new Error(`No pinned binary binding for target ${target}`);
  }
  const binaryPath = path.join(packageDir, pin.binaryRelativePath ?? 'bin/inngest');
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Installed native CLI binary is missing: ${binaryPath}`);
  }
  const detected = readNativeBinaryTarget(binaryPath);
  if (!detected || `${detected.platform}-${detected.arch}` !== target) {
    throw new Error(`Installed native CLI binary is not ${target}: ${binaryPath}`);
  }
  const binaryBytes = fs.readFileSync(binaryPath);
  if (sha256(binaryBytes) !== binding.binarySha256 || binaryBytes.length !== binding.binarySizeBytes) {
    throw new Error(`Installed native CLI binary drifted from pinned ${target} binary`);
  }

  const licensePath = path.join(packageDir, pin.license.installedRelativePath);
  if (!fs.existsSync(licensePath)) {
    throw new Error(`Installed native CLI license is missing: ${licensePath}`);
  }
  const licenseBytes = fs.readFileSync(licensePath);
  if (sha256(licenseBytes) !== pin.license.sha256 || licenseBytes.length !== pin.license.sizeBytes) {
    throw new Error('Installed native CLI license drifted from the pinned license text');
  }
}

function verifySourceArchive(filePath, pin) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Embedded native source archive not found: ${filePath}`);
  }
  const bytes = fs.readFileSync(filePath);
  if (bytes.length !== pin.sourceArchive.sizeBytes) {
    throw new Error(`Embedded native source archive size mismatch: ${bytes.length} != ${pin.sourceArchive.sizeBytes}`);
  }
  if (sha256(bytes) !== pin.sourceArchive.sha256) {
    throw new Error('Embedded native source archive hash mismatch');
  }
  const listing = spawnSync('tar', [ '-tzf', filePath ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listing.status !== 0) {
    throw new Error(`Embedded native source archive is not a readable tar.gz: ${filePath}`);
  }
  const memberCount = listing.stdout.trim().split('\n').filter(Boolean).length;
  if (memberCount !== pin.sourceArchive.memberCount) {
    throw new Error(`Embedded native source archive member count mismatch: ${memberCount} != ${pin.sourceArchive.memberCount}`);
  }
}

function verifyEmbeddedDocsRoot(docsRoot, pin) {
  const embedRoot = path.join(docsRoot, pin.embedDocs.sourcePath);
  if (!fs.existsSync(embedRoot)) {
    throw new Error(`Embedded docs subtree is missing: ${embedRoot}`);
  }
  const fileCount = listFilesRecursive(embedRoot).length;
  if (fileCount !== pin.embedDocs.fileCount) {
    throw new Error(`Embedded docs file count mismatch: ${fileCount} != ${pin.embedDocs.fileCount}`);
  }
  const aggregate = aggregateDocsSha256(docsRoot, pin.embedDocs.sourcePath);
  if (aggregate !== pin.embedDocs.filesSha256Aggregate) {
    throw new Error('Embedded docs aggregate hash mismatch');
  }
  return { fileCount, aggregate };
}

async function downloadToFile(url, destination, timeoutMs = DOCS_FILE_FETCH_TIMEOUT_MS) {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error(`No fetch implementation available to download ${url}`);
  }
  const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
  const response = await fetchImpl(url, { redirect: 'follow', signal });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.partial`;
  fs.writeFileSync(temporary, buffer);
  fs.renameSync(temporary, destination);
}

async function obtainSourceArchive(pin, options = {}) {
  const artifactPath = options.artifactPath;
  if (artifactPath) {
    verifySourceArchive(artifactPath, pin);
    return { path: artifactPath, obtained: 'provided' };
  }
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const cached = path.join(cacheDir, pin.sourceArchive.fileName);
  if (fs.existsSync(cached)) {
    try {
      verifySourceArchive(cached, pin);
      return { path: cached, obtained: 'cache' };
    } catch {
      fs.rmSync(cached, { force: true });
    }
  }
  const url = pin.sourceArchive.urlTemplate.replace('<commit>', pin.upstream.commit);
  await downloadToFile(url, cached, ARCHIVE_FETCH_TIMEOUT_MS);
  verifySourceArchive(cached, pin);
  return { path: cached, obtained: 'download' };
}

async function obtainEmbedDocs(pin, options = {}) {
  const provided = options.docsRoot;
  if (provided) {
    verifyEmbeddedDocsRoot(provided, pin);
    return { docsRoot: provided, obtained: 'provided' };
  }
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const cached = path.join(cacheDir, `${pin.packageName}-${pin.embedDocs.commit}-docs`);
  if (fs.existsSync(cached)) {
    try {
      const result = verifyEmbeddedDocsRoot(cached, pin);
      return { docsRoot: cached, obtained: 'cache', ...result };
    } catch {
      fs.rmSync(cached, { recursive: true, force: true });
    }
  }
  await downloadEmbedDocs(pin, cached);
  verifyEmbeddedDocsRoot(cached, pin);
  return { docsRoot: cached, obtained: 'download' };
}

async function downloadEmbedDocs(pin, destination) {
  const treeUrl = pin.embedDocs.treeApiUrlTemplate.replace('<commit>', pin.embedDocs.commit);
  const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(DOCS_TREE_FETCH_TIMEOUT_MS) : undefined;
  const response = await globalThis.fetch(treeUrl, { redirect: 'follow', signal });
  if (!response.ok) {
    throw new Error(`Failed to read embedded docs tree: HTTP ${response.status}`);
  }
  const tree = await response.json();
  if (tree.truncated === true) {
    throw new Error('Embedded docs tree response is truncated; refusing to stage a partial source');
  }
  const prefix = `${pin.embedDocs.sourcePath}/`;
  const paths = (Array.isArray(tree.tree) ? tree.tree : [])
    .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string' && entry.path.startsWith(prefix))
    .map((entry) => entry.path);
  if (paths.length !== pin.embedDocs.fileCount) {
    throw new Error(`Embedded docs path count mismatch: ${paths.length} != ${pin.embedDocs.fileCount}`);
  }
  const rawTemplate = pin.embedDocs.rawFileUrlTemplate.replace('<commit>', pin.embedDocs.commit);
  let index = 0;
  const failures = [];
  async function worker() {
    for (;;) {
      const current = index++;
      if (current >= paths.length) return;
      const relative = paths[current];
      try {
        await downloadToFile(rawTemplate.replace('<path>', relative), path.join(destination, relative));
      } catch (error) {
        failures.push(`${relative}: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  if (failures.length > 0) {
    throw new Error(`Embedded docs download failed for ${failures.length} file(s): ${failures[0]}`);
  }
}

function defaultCacheDir() {
  return path.join(os.tmpdir(), 'xpod-embedded-native-source');
}

function buildNotice(pin, target, manifest, docsObtained) {
  const binding = pin.targets[target];
  return [
    `${pin.packageName} ${pin.packageVersion} - Server Side Public License v1.0 (with Apache-2.0 future license)`,
    pin.license.copyright,
    '',
    `This platform package redistributes the ${pin.packageName} native CLI.`,
    `License text: ${EMBEDDED_SOURCE_RELATIVE_PATH}/LICENSE-inngest-cli.md`,
    `Current license: ${pin.license.spdx}; future license: ${pin.license.futureLicense} effective ${pin.license.futureLicenseEffectiveAt}`,
    '',
    `Corresponding Source: ${EMBEDDED_SOURCE_RELATIVE_PATH}/upstream/${pin.sourceArchive.fileName}`,
    `  upstream ${pin.upstream.repository} ${pin.upstream.tag} commit ${pin.upstream.commit}`,
    `  sha256 ${pin.sourceArchive.sha256} (${pin.sourceArchive.sizeBytes} bytes, ${pin.sourceArchive.memberCount} archive members)`,
    '',
    `Embedded documentation inputs: ${EMBEDDED_SOURCE_RELATIVE_PATH}/submodule-website/${pin.embedDocs.sourcePath}/`,
    `  ${pin.embedDocs.repository} commit ${pin.embedDocs.commit}`,
    `  ${pin.embedDocs.fileCount} files, aggregate sha256 ${pin.embedDocs.filesSha256Aggregate}`,
    pin.embedDocs.independentLicenseNote ? `  ${pin.embedDocs.independentLicenseNote}` : '',
    '',
    `Binary: ${target}, version ${binding.binaryVersionString}, sha256 ${binding.binarySha256}`,
    `Docs source obtained via ${docsObtained}.`,
    '',
    'Xpod itself is licensed under MIT; see the top-level LICENSE. This NOTICE covers',
    `the third-party ${pin.packageName} redistributed inside this platform package.`,
    '',
  ].filter((line) => line !== '').join('\n');
}

async function stageEmbeddedNativeSource(stageDir, options) {
  const pin = options.pin ?? resolveEmbeddedNativeSourcePin(options.packageName);
  const target = options.target;
  if (!target) {
    throw new Error('A target is required to stage the embedded native source sidecar');
  }
  const nodeModulesRoot = options.nodeModulesRoot;
  assertSourcePinMatchesInstalled({ pin, nodeModulesRoot, target });

  const archive = await obtainSourceArchive(pin, options);
  const docs = await obtainEmbedDocs(pin, options);
  const licenseSource = path.join(nodeModulesRoot, pin.packageName, pin.license.installedRelativePath);
  const licenseText = fs.readFileSync(licenseSource);

  const sourceDir = path.join(stageDir, EMBEDDED_SOURCE_RELATIVE_PATH);
  fs.rmSync(sourceDir, { recursive: true, force: true });
  const upstreamDir = path.join(sourceDir, 'upstream');
  fs.mkdirSync(upstreamDir, { recursive: true });

  const archiveDestination = path.join(upstreamDir, pin.sourceArchive.fileName);
  fs.copyFileSync(archive.path, archiveDestination);

  const licenseDestination = path.join(sourceDir, 'LICENSE-inngest-cli.md');
  fs.writeFileSync(licenseDestination, licenseText);

  const docsDestination = path.join(sourceDir, 'submodule-website', pin.embedDocs.sourcePath);
  fs.cpSync(path.join(docs.docsRoot, pin.embedDocs.sourcePath), docsDestination, { recursive: true });

  const docsLines = docsSha256Lines(docs.docsRoot, pin.embedDocs.sourcePath);
  const shaListPath = path.join(upstreamDir, 'submodule-docs-sha256.txt');
  fs.writeFileSync(shaListPath, `${docsLines.join('\n')}\n`);

  const binding = pin.targets[target];
  const manifest = {
    schemaVersion: 1,
    kind: 'xpod-embedded-native-source',
    subject: pin.packageName,
    packageVersion: pin.packageVersion,
    target,
    upstream: { ...pin.upstream },
    binary: {
      versionString: binding.binaryVersionString,
      sha256: binding.binarySha256,
      sizeBytes: binding.binarySizeBytes,
    },
    license: {
      path: 'LICENSE-inngest-cli.md',
      sha256: pin.license.sha256,
      sizeBytes: pin.license.sizeBytes,
      spdx: pin.license.spdx,
      futureLicense: pin.license.futureLicense,
      futureLicenseEffectiveAt: pin.license.futureLicenseEffectiveAt,
      copyright: pin.license.copyright,
    },
    sourceArchive: {
      path: `upstream/${pin.sourceArchive.fileName}`,
      sha256: pin.sourceArchive.sha256,
      sizeBytes: pin.sourceArchive.sizeBytes,
      memberCount: pin.sourceArchive.memberCount,
      rootDir: pin.sourceArchive.rootDir,
    },
    embedDocs: {
      path: `submodule-website/${pin.embedDocs.sourcePath}`,
      repository: pin.embedDocs.repository,
      commit: pin.embedDocs.commit,
      submodulePath: pin.embedDocs.submodulePath,
      fileCount: pin.embedDocs.fileCount,
      filesSha256Aggregate: pin.embedDocs.filesSha256Aggregate,
      filesSha256List: 'upstream/submodule-docs-sha256.txt',
      independentLicense: pin.embedDocs.independentLicense,
    },
  };

  const manifestPath = path.join(sourceDir, 'SOURCE-MANIFEST.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(sourceDir, 'NOTICE'), buildNotice(pin, target, manifest, docs.obtained));

  // Re-verify what actually landed on disk.
  verifySourceArchive(archiveDestination, pin);
  if (sha256File(licenseDestination) !== pin.license.sha256) {
    throw new Error('Staged license text drifted from the pinned license');
  }
  verifyEmbeddedDocsRoot(path.join(sourceDir, 'submodule-website'), pin);

  const files = listFilesRecursive(sourceDir)
    .map((file) => path.relative(stageDir, file).split(path.sep).join(path.posix.sep))
    .sort();
  return {
    relativeDir: EMBEDDED_SOURCE_RELATIVE_PATH,
    files,
    manifestPath,
    manifestSha256: sha256File(manifestPath),
  };
}

/**
 * Resolve a package-relative path and prove it stays inside the package root,
 * including through symlinks. Absence and escape both fail.
 */
function assertPathInsidePackage(packageRoot, targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} not found: ${targetPath}`);
  }
  const realRoot = fs.realpathSync(packageRoot);
  const realTarget = fs.realpathSync(targetPath);
  const relative = path.relative(realRoot, realTarget);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its package root: ${targetPath}`);
  }
  return realTarget;
}

/**
 * Verify the Corresponding-Source sidecar actually installed inside the
 * selected native platform package. Digests are recomputed from the shipped
 * bytes and checked against the pin, never trusted from the manifest alone.
 */
function verifyInstalledNativeSource(options) {
  const packageRoot = options?.packageRoot;
  const manifestRelativePath = options?.manifestRelativePath;
  const expectedManifestSha256 = options?.manifestSha256;
  const pin = options?.pin ?? resolveEmbeddedNativeSourcePin(options?.packageName);
  if (!packageRoot || !manifestRelativePath) {
    throw new Error('packageRoot and manifestRelativePath are required');
  }
  if (typeof expectedManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedManifestSha256)) {
    throw new Error('xpodEmbeddedSourceSha256 must be a sha256 hex string');
  }

  const manifestPath = assertPathInsidePackage(packageRoot, path.resolve(packageRoot, manifestRelativePath), 'xpodEmbeddedSource');
  const computedManifestSha256 = sha256File(manifestPath);
  if (computedManifestSha256 !== expectedManifestSha256) {
    throw new Error('Installed embedded source manifest digest mismatch');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const target = options?.target ?? manifest.target;
  const binding = pin.targets[target];
  if (!binding) {
    throw new Error(`No pinned binary binding for target ${target}`);
  }
  if (manifest.subject !== pin.packageName || manifest.packageVersion !== pin.packageVersion || manifest.target !== target) {
    throw new Error('Installed embedded source manifest subject/version/target drift');
  }
  if (manifest.upstream?.commit !== pin.upstream.commit || manifest.upstream?.tag !== pin.upstream.tag) {
    throw new Error('Installed embedded source manifest upstream drift');
  }
  if (manifest.binary?.sha256 !== binding.binarySha256 || manifest.binary?.versionString !== binding.binaryVersionString) {
    throw new Error('Installed embedded source manifest binary drift');
  }

  const sourceDir = assertPathInsidePackage(packageRoot, path.dirname(manifestPath), 'SOURCE directory');

  const archivePath = assertPathInsidePackage(packageRoot, path.join(sourceDir, manifest.sourceArchive.path), 'source archive');
  verifySourceArchive(archivePath, pin);
  if (manifest.sourceArchive.sha256 !== pin.sourceArchive.sha256
    || manifest.sourceArchive.sizeBytes !== pin.sourceArchive.sizeBytes
    || manifest.sourceArchive.memberCount !== pin.sourceArchive.memberCount) {
    throw new Error('Installed embedded source manifest archive contract drift');
  }

  const licensePath = assertPathInsidePackage(packageRoot, path.join(sourceDir, manifest.license.path), 'license');
  const licenseBytes = fs.readFileSync(licensePath);
  if (sha256(licenseBytes) !== pin.license.sha256 || manifest.license.sha256 !== pin.license.sha256) {
    throw new Error('Installed embedded source license drift');
  }

  const docsRoot = assertPathInsidePackage(packageRoot, path.join(sourceDir, 'submodule-website'), 'embedded docs');
  const docs = verifyEmbeddedDocsRoot(docsRoot, pin);
  if (manifest.embedDocs.commit !== pin.embedDocs.commit
    || manifest.embedDocs.fileCount !== pin.embedDocs.fileCount
    || manifest.embedDocs.filesSha256Aggregate !== pin.embedDocs.filesSha256Aggregate) {
    throw new Error('Installed embedded source manifest docs contract drift');
  }
  const shaListPath = assertPathInsidePackage(packageRoot, path.join(sourceDir, manifest.embedDocs.filesSha256List), 'docs sha list');
  const expectedShaList = `${docsSha256Lines(docsRoot, pin.embedDocs.sourcePath).join('\n')}\n`;
  if (fs.readFileSync(shaListPath, 'utf8') !== expectedShaList) {
    throw new Error('Installed embedded source docs sha list drift');
  }

  const noticePath = assertPathInsidePackage(packageRoot, path.join(sourceDir, 'NOTICE'), 'NOTICE');
  const notice = fs.readFileSync(noticePath, 'utf8');
  for (const token of [ pin.upstream.commit, pin.license.spdx, pin.license.copyright, binding.binarySha256, String(pin.embedDocs.fileCount) ]) {
    if (!notice.includes(token)) {
      throw new Error(`Installed embedded source NOTICE is missing ${token}`);
    }
  }

  return {
    manifestPath,
    manifestSha256: computedManifestSha256,
    target,
    archiveSha256: pin.sourceArchive.sha256,
    licenseSha256: pin.license.sha256,
    docsFileCount: docs.fileCount,
    docsAggregate: docs.aggregate,
  };
}

module.exports = {
  EMBEDDED_NATIVE_SOURCE_PINS,
  EMBEDDED_SOURCE_RELATIVE_PATH,
  aggregateDocsSha256,
  assertSourcePinMatchesInstalled,
  buildNotice,
  obtainEmbedDocs,
  obtainSourceArchive,
  resolveEmbeddedNativeSourcePin,
  stageEmbeddedNativeSource,
  verifyEmbeddedDocsRoot,
  verifyInstalledNativeSource,
  verifySourceArchive,
};
