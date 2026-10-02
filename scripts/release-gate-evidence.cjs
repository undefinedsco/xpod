#!/usr/bin/env node
/**
 * Bind the `qlever-local` and `package-consumers` acceptance gates to the
 * exact source SHA and the exact archive bytes a producing step built.
 *
 * Producers run only after their real smoke/consumer steps have succeeded
 * under `set -euo pipefail`, and hash the real artifacts they produced:
 *   - `create-qlever-local` reads the built runtime archive and derives the
 *     manifest/ABI/runtime hashes from inside it.
 *   - `create-package-consumers` reads the packed root tarball and the real
 *     Node/Bun registry-consumer `result.json` files, then archives the packed
 *     root and workspace applet tarballs.
 *
 * The `finalize_acceptance` verifier re-hashes the *downloaded* corresponding
 * artifact bytes and refuses missing, mismatched, wrong-SHA, wrong-ABI or
 * failed evidence. A green check is never an echoed boolean.
 *
 * Usage:
 *   node scripts/release-gate-evidence.cjs create-qlever-local \
 *     --source-sha <40-hex> --archive <tar.gz> [--abi-platform macos-arm64] \
 *     [--smoke-command <text>] --out <evidence.json>
 *   node scripts/release-gate-evidence.cjs verify-qlever-local \
 *     --evidence <file> --source-sha <40-hex> --expected-archive <tar.gz> \
 *     [--checks-out <file>]
 *   node scripts/release-gate-evidence.cjs create-package-consumers \
 *     --source-sha <40-hex> --pack-json <pack.json> \
 *     --node-result <result.json> --bun-result <result.json> \
 *     --workspace-evidence <workspace-consumer.json> \
 *     --archive-dir <dir> --out <evidence.json>
 *   node scripts/release-gate-evidence.cjs verify-package-consumers \
 *     --evidence <file> --source-sha <40-hex> --archive-dir <dir> \
 *     [--checks-out <file>]
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { PACKAGES } = require('./workspace-package-consumer.cjs');

const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SHA512_BASE64_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/;
const REPO_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9._/-]+\.git$/;
const XPOD_ROOT_NAME = '@undefineds.co/xpod';
const QLEVER_RUNTIME_MEMBER = 'bin/xpod_qlever_local_runtime';
const MAX_TAR_MEMBER_BYTES = 512 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function validateSourceSha(value) {
  if (!SOURCE_SHA_PATTERN.test(String(value ?? ''))) {
    fail('sourceSha must be exactly 40 lowercase hex characters');
  }
}

function readJsonFile(filePath, label) {
  const resolved = path.resolve(filePath ?? '');
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
    fail(`${label} does not exist: ${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function readFileOrFail(filePath, label) {
  const resolved = path.resolve(filePath ?? '');
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
    fail(`${label} does not exist: ${filePath}`);
  }
  const bytes = fs.readFileSync(resolved);
  if (bytes.length === 0) {
    fail(`${label} is empty: ${filePath}`);
  }
  return bytes;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha512Base64(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

// The authoritative QLever source pin and ABI come from the checked-out source,
// not from the artifact being verified. `xpod_qlever_adapter_abi_version()`
// returns `XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION`, so both manifest ABI fields
// must equal the single header define - no duplicated ABI table here.
function loadQleverSourceConformance() {
  const repoRoot = path.resolve(__dirname, '..');
  const lock = readJsonFile(path.join(repoRoot, 'qlever/qlever.lock.json'), 'qlever lock');
  if (!REPO_PATTERN.test(String(lock.repository ?? ''))
    || !SOURCE_SHA_PATTERN.test(String(lock.commit ?? ''))
    || !SHA256_PATTERN.test(String(lock.patchSeriesSha256 ?? ''))) {
    fail('qlever lock pin is incomplete');
  }
  const header = fs.readFileSync(
    path.join(repoRoot, 'qlever/rdf_protocol/include/xpod_rdf_physical_backend.h'),
    'utf8',
  );
  const match = /#define\s+XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION\s+(\d+)\b/.exec(header);
  if (!match) fail('cannot resolve the physical backend ABI from the source header');
  const abiVersion = Number(match[1]);
  if (!Number.isSafeInteger(abiVersion) || abiVersion <= 0) {
    fail('source physical backend ABI must be a positive integer');
  }
  return {
    repository: lock.repository,
    commit: lock.commit,
    patchSeriesSha256: lock.patchSeriesSha256,
    adapterAbiVersion: abiVersion,
    physicalBackendAbiVersion: abiVersion,
  };
}

// Artifact layouts differ between upload/download implementations; locate each
// expected archive by basename under the downloaded artifact root instead of
// depending on the directory nesting.
function findFileByBasename(directory, basename) {
  const root = path.resolve(directory);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`archive directory does not exist: ${directory}`);
  }
  const queue = [ root ];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(entryPath);
      else if (entry.isFile() && entry.name === basename) return entryPath;
    }
  }
  fail(`downloaded artifact is missing ${basename}`);
}

function writeJsonFile(filePath, value) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
}

function writeChecks(filePath, checks) {
  if (!filePath) return;
  writeJsonFile(filePath, checks);
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) fail(`${optionName} requires a value`);
  return value;
}

function extractTarMember(archivePath, candidates) {
  for (const member of candidates) {
    try {
      const bytes = execFileSync('tar', [ '-xzOf', archivePath, member ], {
        maxBuffer: MAX_TAR_MEMBER_BYTES,
      });
      if (bytes && bytes.length > 0) return bytes;
    } catch {
      // Try the next candidate member spelling.
    }
  }
  fail(`archive is missing an expected member: ${candidates.join(' or ')}`);
}

function validateRuntimeManifest(manifest, expected) {
  if (!isPlainObject(manifest) || manifest.schemaVersion !== 1) {
    fail('runtime manifest schemaVersion must be 1');
  }
  if (!isPlainObject(manifest.build) || manifest.build.source !== 'native-platform-build') {
    fail('runtime manifest must be a native platform build');
  }
  if (manifest.build.platform !== expected.platform) {
    fail(`runtime manifest platform ${manifest.build.platform} does not match ${expected.platform}`);
  }
  if (manifest.adapterAbiVersion !== expected.adapterAbiVersion
    || manifest.physicalBackendAbiVersion !== expected.physicalBackendAbiVersion) {
    fail('runtime manifest ABI does not match the source build contract');
  }
  if (!isPlainObject(manifest.qlever)
    || manifest.qlever.repository !== expected.repository
    || manifest.qlever.commit !== expected.commit
    || manifest.qlever.patchSeriesSha256 !== expected.patchSeriesSha256) {
    fail('runtime manifest qlever pin does not match the checked-out source');
  }
  if (!Array.isArray(manifest.artifacts)) {
    fail('runtime manifest artifacts must be an array');
  }
}

function declaredRuntimeArtifact(manifest) {
  const entry = manifest.artifacts.find((artifact) => artifact?.path === QLEVER_RUNTIME_MEMBER);
  if (!entry || !SHA256_PATTERN.test(String(entry.sha256 ?? ''))
    || !Number.isSafeInteger(entry.size) || entry.size <= 0) {
    fail(`runtime manifest is missing a hashed ${QLEVER_RUNTIME_MEMBER} artifact`);
  }
  return entry;
}

function createQleverLocal(args) {
  validateSourceSha(args.sourceSha);
  if (!args.archive) fail('--archive is required');
  if (!args.out) fail('--out is required');
  const platform = args.abiPlatform || 'macos-arm64';
  const conformance = { ...loadQleverSourceConformance(), platform };
  const archiveAbsolute = path.resolve(args.archive);
  const archiveBytes = readFileOrFail(archiveAbsolute, '--archive');
  const archiveSha = sha256Hex(archiveBytes);

  const manifestBytes = extractTarMember(archiveAbsolute, [ './manifest.json', 'manifest.json' ]);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    fail(`runtime manifest is not valid JSON: ${error.message}`);
  }
  validateRuntimeManifest(manifest, conformance);
  const declared = declaredRuntimeArtifact(manifest);

  const runtimeBytes = extractTarMember(archiveAbsolute, [
    `./${QLEVER_RUNTIME_MEMBER}`,
    QLEVER_RUNTIME_MEMBER,
  ]);
  const runtimeSha = sha256Hex(runtimeBytes);
  if (runtimeSha !== declared.sha256 || runtimeBytes.length !== declared.size) {
    fail('runtime member does not match the manifest artifact hash');
  }

  const evidence = {
    schemaVersion: 1,
    kind: 'qlever-local-acceptance',
    ok: true,
    sourceSha: args.sourceSha,
    platform,
    smoke: {
      command: args.smokeCommand || 'qlever/scripts/build-macos-local-runtime.sh',
      completed: true,
    },
    archive: {
      name: path.basename(archiveAbsolute),
      sha256: archiveSha,
      size: archiveBytes.length,
    },
    runtime: {
      member: QLEVER_RUNTIME_MEMBER,
      sha256: runtimeSha,
      size: runtimeBytes.length,
    },
    manifest: {
      sha256: sha256Hex(manifestBytes),
      adapterAbiVersion: manifest.adapterAbiVersion,
      physicalBackendAbiVersion: manifest.physicalBackendAbiVersion,
      platform: manifest.build.platform,
      qlever: {
        repository: manifest.qlever.repository,
        commit: manifest.qlever.commit,
        patchSeriesSha256: manifest.qlever.patchSeriesSha256,
      },
    },
  };
  writeJsonFile(args.out, evidence);
  process.stdout.write(`${JSON.stringify({
    kind: evidence.kind,
    sourceSha: evidence.sourceSha,
    archiveSha256: evidence.archive.sha256,
    runtimeSha256: evidence.runtime.sha256,
  })}\n`);
}

function validateQleverLocalEvidence(evidence) {
  if (!isPlainObject(evidence) || evidence.schemaVersion !== 1) fail('evidence schemaVersion must be 1');
  if (evidence.kind !== 'qlever-local-acceptance') fail('evidence kind must be qlever-local-acceptance');
  if (evidence.ok !== true) fail('evidence ok must be true');
  validateSourceSha(evidence.sourceSha);
  if (evidence.platform !== 'macos-arm64') fail('evidence platform must be macos-arm64');
  if (!isPlainObject(evidence.smoke) || evidence.smoke.completed !== true) {
    fail('evidence smoke.completed must be true');
  }
  if (!isPlainObject(evidence.archive) || !SHA256_PATTERN.test(String(evidence.archive.sha256 ?? ''))
    || !Number.isSafeInteger(evidence.archive.size) || evidence.archive.size <= 0) {
    fail('evidence archive must record sha256 and size');
  }
  if (!isPlainObject(evidence.runtime) || evidence.runtime.member !== QLEVER_RUNTIME_MEMBER
    || !SHA256_PATTERN.test(String(evidence.runtime.sha256 ?? ''))
    || !Number.isSafeInteger(evidence.runtime.size) || evidence.runtime.size <= 0) {
    fail('evidence runtime must record the built runtime member');
  }
  if (!isPlainObject(evidence.manifest) || !SHA256_PATTERN.test(String(evidence.manifest.sha256 ?? ''))
    || !Number.isSafeInteger(evidence.manifest.adapterAbiVersion)
    || evidence.manifest.adapterAbiVersion <= 0
    || !Number.isSafeInteger(evidence.manifest.physicalBackendAbiVersion)
    || evidence.manifest.physicalBackendAbiVersion <= 0
    || evidence.manifest.platform !== 'macos-arm64'
    || !isPlainObject(evidence.manifest.qlever)) {
    fail('evidence manifest must record the ABI, platform and qlever pin');
  }
}

function verifyQleverLocal(args) {
  validateSourceSha(args.sourceSha);
  if (!args.evidence) fail('--evidence is required');
  if (!args.expectedArchive) fail('--expected-archive is required');
  const evidence = readJsonFile(args.evidence, '--evidence');
  validateQleverLocalEvidence(evidence);
  if (evidence.sourceSha !== args.sourceSha) {
    fail('qlever-local evidence sourceSha does not match the accepted source SHA');
  }

  const archiveAbsolute = path.resolve(args.expectedArchive);
  const archiveBytes = readFileOrFail(archiveAbsolute, '--expected-archive');
  if (path.basename(archiveAbsolute) !== evidence.archive.name) {
    fail('qlever-local evidence archive name does not match the downloaded artifact');
  }
  if (sha256Hex(archiveBytes) !== evidence.archive.sha256 || archiveBytes.length !== evidence.archive.size) {
    fail('qlever-local evidence archive digest does not match the downloaded artifact');
  }

  const manifestBytes = extractTarMember(archiveAbsolute, [ './manifest.json', 'manifest.json' ]);
  if (sha256Hex(manifestBytes) !== evidence.manifest.sha256) {
    fail('qlever-local evidence manifest digest does not match the downloaded artifact');
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    fail(`downloaded runtime manifest is not valid JSON: ${error.message}`);
  }
  const conformance = { ...loadQleverSourceConformance(), platform: 'macos-arm64' };
  validateRuntimeManifest(manifest, conformance);
  if (manifest.adapterAbiVersion !== evidence.manifest.adapterAbiVersion
    || manifest.physicalBackendAbiVersion !== evidence.manifest.physicalBackendAbiVersion) {
    fail('qlever-local evidence ABI does not match the downloaded artifact');
  }
  const qlever = evidence.manifest.qlever;
  if (manifest.qlever.repository !== qlever.repository
    || manifest.qlever.commit !== qlever.commit
    || manifest.qlever.patchSeriesSha256 !== qlever.patchSeriesSha256) {
    fail('qlever-local evidence qlever pin does not match the downloaded artifact');
  }

  const declared = declaredRuntimeArtifact(manifest);
  const runtimeBytes = extractTarMember(archiveAbsolute, [
    `./${QLEVER_RUNTIME_MEMBER}`,
    QLEVER_RUNTIME_MEMBER,
  ]);
  const runtimeSha = sha256Hex(runtimeBytes);
  if (runtimeSha !== evidence.runtime.sha256 || runtimeBytes.length !== evidence.runtime.size) {
    fail('qlever-local evidence runtime digest does not match the downloaded artifact');
  }
  if (runtimeSha !== declared.sha256 || runtimeBytes.length !== declared.size) {
    fail('qlever-local runtime does not match the manifest-declared digest');
  }

  writeChecks(args.checksOut, { 'qlever-local': 'passed' });
  process.stdout.write(`${JSON.stringify({ valid: true, 'qlever-local': 'passed' })}\n`);
}

function readPackEntry(packJsonPath) {
  const data = readJsonFile(packJsonPath, '--pack-json');
  const pack = Array.isArray(data) ? data[0] : data;
  if (!isPlainObject(pack) || typeof pack.filename !== 'string' || pack.filename.length === 0) {
    fail('--pack-json does not describe a packed artifact');
  }
  return pack;
}

function readConsumerResult(resultPath, label) {
  const result = readJsonFile(resultPath, label);
  if (!isPlainObject(result) || result.passed !== true) {
    fail(`${label} must record a completed consumer (passed true)`);
  }
  if (result.name !== XPOD_ROOT_NAME) {
    fail(`${label} must record the packed root package`);
  }
  if (!SHA512_BASE64_PATTERN.test(String(result.integrity ?? ''))) {
    fail(`${label} must record the packed artifact integrity`);
  }
  return result;
}

// Validates the machine-readable result the `--local` workspace consumer wrote
// after its real consumption/export/type/CSS checks passed. The referenced
// tarballs are the exact consumed bytes it retained before cleanup.
function validateWorkspaceConsumerEvidence(evidence, expectedSourceSha, archiveDir) {
  if (!isPlainObject(evidence) || evidence.schemaVersion !== 1) {
    fail('workspace consumer evidence schemaVersion must be 1');
  }
  if (evidence.kind !== 'workspace-consumer-acceptance') {
    fail('workspace consumer evidence kind must be workspace-consumer-acceptance');
  }
  if (evidence.ok !== true) fail('workspace consumer evidence must record a successful consumer');
  validateSourceSha(evidence.sourceSha);
  if (evidence.sourceSha !== expectedSourceSha) {
    fail('workspace consumer evidence sourceSha does not match the accepted source SHA');
  }
  if (!Array.isArray(evidence.packages) || evidence.packages.length !== PACKAGES.length) {
    fail('workspace consumer evidence must cover every consumer package');
  }
  const packages = new Map(evidence.packages.map((entry) => [ entry?.packageName, entry ]));
  return PACKAGES.map((packageName) => {
    const entry = packages.get(packageName);
    if (!entry || typeof entry.name !== 'string' || entry.name.length === 0
      || !SHA256_PATTERN.test(String(entry.sha256 ?? ''))
      || !Number.isSafeInteger(entry.size) || entry.size <= 0) {
      fail(`workspace consumer evidence is missing a valid archive for ${packageName}`);
    }
    const bytes = readFileOrFail(path.join(archiveDir, entry.name), `consumed workspace tarball ${packageName}`);
    if (sha256Hex(bytes) !== entry.sha256 || bytes.length !== entry.size) {
      fail(`consumed workspace tarball ${packageName} does not match the workspace consumer result`);
    }
    return { packageName, name: entry.name, sha256: entry.sha256, size: entry.size };
  });
}

function createPackageConsumers(args) {
  validateSourceSha(args.sourceSha);
  for (const required of [ 'packJson', 'nodeResult', 'bunResult', 'workspaceEvidence', 'archiveDir', 'out' ]) {
    if (!args[required]) fail(`--${required.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  const pack = readPackEntry(args.packJson);
  const packDirectory = path.dirname(path.resolve(args.packJson));
  const rootTarballPath = path.join(packDirectory, pack.filename);
  const rootBytes = readFileOrFail(rootTarballPath, 'packed root tarball');
  const rootIntegrity = sha512Base64(rootBytes);
  if (pack.integrity !== rootIntegrity) {
    fail('packed root tarball integrity does not match pack.json');
  }
  if (pack.size !== rootBytes.length) {
    fail('packed root tarball size does not match pack.json');
  }

  const node = readConsumerResult(args.nodeResult, '--node-result');
  const bun = readConsumerResult(args.bunResult, '--bun-result');
  for (const [ label, result ] of [ [ 'node', node ], [ 'bun', bun ] ]) {
    if (result.integrity !== rootIntegrity) {
      fail(`${label} consumer did not install the packed root tarball`);
    }
  }

  const archiveDir = path.resolve(args.archiveDir);
  const workspaceEvidenceBytes = readFileOrFail(args.workspaceEvidence, '--workspace-evidence');
  const workspaceEvidence = JSON.parse(workspaceEvidenceBytes.toString('utf8'));
  const workspaceArchives = validateWorkspaceConsumerEvidence(
    workspaceEvidence,
    args.sourceSha,
    path.join(archiveDir, 'workspace'),
  );

  fs.mkdirSync(archiveDir, { recursive: true });
  fs.copyFileSync(rootTarballPath, path.join(archiveDir, pack.filename));

  const evidence = {
    schemaVersion: 1,
    kind: 'package-consumers-acceptance',
    ok: true,
    sourceSha: args.sourceSha,
    // This gate proves registry/consumer installation of the packed tarballs.
    // It does not prove the bundled native runtime; that is the qlever-local gate.
    scope: 'package-only',
    bundledNativeRuntime: false,
    rootArchive: {
      name: pack.filename,
      sha256: sha256Hex(rootBytes),
      size: rootBytes.length,
      integrity: rootIntegrity,
    },
    workspaceArchives,
    workspaceResult: {
      schemaVersion: 1,
      kind: 'workspace-consumer-acceptance',
      ok: true,
      sourceSha: workspaceEvidence.sourceSha,
      evidenceSha256: sha256Hex(workspaceEvidenceBytes),
    },
    consumers: {
      node: { passed: true, version: node.version, integrity: node.integrity },
      bun: { passed: true, version: bun.version, integrity: bun.integrity },
    },
  };
  writeJsonFile(args.out, evidence);
  process.stdout.write(`${JSON.stringify({
    kind: evidence.kind,
    sourceSha: evidence.sourceSha,
    rootSha256: evidence.rootArchive.sha256,
    workspaceCount: evidence.workspaceArchives.length,
  })}\n`);
}

function validatePackageConsumersEvidence(evidence) {
  if (!isPlainObject(evidence) || evidence.schemaVersion !== 1) fail('evidence schemaVersion must be 1');
  if (evidence.kind !== 'package-consumers-acceptance') fail('evidence kind must be package-consumers-acceptance');
  if (evidence.ok !== true) fail('evidence ok must be true');
  validateSourceSha(evidence.sourceSha);
  if (evidence.scope !== 'package-only') fail('evidence scope must be package-only');
  if (evidence.bundledNativeRuntime !== false) {
    fail('evidence must not claim a bundled native runtime');
  }
  const root = evidence.rootArchive;
  if (!isPlainObject(root) || typeof root.name !== 'string' || root.name.length === 0
    || !SHA256_PATTERN.test(String(root.sha256 ?? ''))
    || !Number.isSafeInteger(root.size) || root.size <= 0
    || !SHA512_BASE64_PATTERN.test(String(root.integrity ?? ''))) {
    fail('evidence rootArchive must record name, sha256, size and integrity');
  }
  if (!isPlainObject(evidence.workspaceResult)
    || evidence.workspaceResult.kind !== 'workspace-consumer-acceptance'
    || evidence.workspaceResult.ok !== true
    || evidence.workspaceResult.sourceSha !== evidence.sourceSha
    || !SHA256_PATTERN.test(String(evidence.workspaceResult.evidenceSha256 ?? ''))) {
    fail('evidence must record a completed workspace consumer result');
  }
  if (!Array.isArray(evidence.workspaceArchives) || evidence.workspaceArchives.length !== PACKAGES.length) {
    fail('evidence workspaceArchives must cover every consumer package');
  }
  const byPackage = new Map(evidence.workspaceArchives.map((archive) => [ archive?.packageName, archive ]));
  for (const packageName of PACKAGES) {
    const archive = byPackage.get(packageName);
    if (!archive || typeof archive.name !== 'string' || archive.name.length === 0
      || !SHA256_PATTERN.test(String(archive.sha256 ?? ''))
      || !Number.isSafeInteger(archive.size) || archive.size <= 0) {
      fail(`evidence is missing a valid workspace archive ${packageName}`);
    }
  }
  if (!isPlainObject(evidence.consumers)
    || evidence.consumers.node?.passed !== true
    || evidence.consumers.bun?.passed !== true
    || evidence.consumers.node.integrity !== root.integrity
    || evidence.consumers.bun.integrity !== root.integrity) {
    fail('evidence must record passed Node and Bun consumers of the packed root');
  }
}

function verifyPackageConsumers(args) {
  validateSourceSha(args.sourceSha);
  if (!args.evidence) fail('--evidence is required');
  if (!args.archiveDir) fail('--archive-dir is required');
  const evidence = readJsonFile(args.evidence, '--evidence');
  validatePackageConsumersEvidence(evidence);
  if (evidence.sourceSha !== args.sourceSha) {
    fail('package-consumers evidence sourceSha does not match the accepted source SHA');
  }

  const archiveDir = path.resolve(args.archiveDir);
  const rootBytes = readFileOrFail(findFileByBasename(archiveDir, evidence.rootArchive.name), 'downloaded root tarball');
  if (sha256Hex(rootBytes) !== evidence.rootArchive.sha256
    || rootBytes.length !== evidence.rootArchive.size
    || sha512Base64(rootBytes) !== evidence.rootArchive.integrity) {
    fail('package-consumers root archive does not match the downloaded artifact');
  }

  for (const archive of evidence.workspaceArchives) {
    if (!isPlainObject(archive) || typeof archive.name !== 'string' || archive.name.length === 0
      || !SHA256_PATTERN.test(String(archive.sha256 ?? ''))
      || !Number.isSafeInteger(archive.size) || archive.size <= 0) {
      fail('workspace archive evidence must record a name, sha256 and size');
    }
    const bytes = readFileOrFail(findFileByBasename(archiveDir, archive.name), `downloaded workspace ${archive.name}`);
    if (sha256Hex(bytes) !== archive.sha256 || bytes.length !== archive.size) {
      fail(`workspace archive ${archive.name} does not match the downloaded artifact`);
    }
  }

  writeChecks(args.checksOut, { 'package-consumers': 'passed' });
  process.stdout.write(`${JSON.stringify({ valid: true, 'package-consumers': 'passed' })}\n`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const key = option.replace(/^--/, '').replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    switch (key) {
      case 'sourceSha':
      case 'archive':
      case 'abiPlatform':
      case 'smokeCommand':
      case 'out':
      case 'evidence':
      case 'expectedArchive':
      case 'checksOut':
      case 'packJson':
      case 'nodeResult':
      case 'bunResult':
      case 'workspaceEvidence':
      case 'archiveDir':
        args[key] = readOptionValue(argv, index, option);
        index += 1;
        break;
      default:
        fail(`unknown option: ${option}`);
    }
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const [ command, ...rest ] = argv;
  const args = parseArgs(rest);
  switch (command) {
    case 'create-qlever-local':
      return createQleverLocal(args);
    case 'verify-qlever-local':
      return verifyQleverLocal(args);
    case 'create-package-consumers':
      return createPackageConsumers(args);
    case 'verify-package-consumers':
      return verifyPackageConsumers(args);
    default:
      fail('command must be create-qlever-local, verify-qlever-local, create-package-consumers or verify-package-consumers');
  }
}

module.exports = {
  createPackageConsumers,
  createQleverLocal,
  loadQleverSourceConformance,
  main,
  verifyPackageConsumers,
  verifyQleverLocal,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[release-gate-evidence] ${error.message}`);
    process.exit(1);
  }
}
