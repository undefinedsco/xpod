// Test-only legacy-root supply. Normal producers own bytes; this is not a publisher or release authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const semver = require('semver');
const assert = require('node:assert/strict');
const { inspectTarballBuffer, sha512Integrity } = require('../workspace-package-payload.cjs');
const { packWorkspacePackages, normalizeWorkspaceDependencies } = require('../workspace-package-pack.cjs');
const { snapshotWorkspace } = require('../collect-workspace-normal-run.cjs');
const LIMIT = 8 * 1024 * 1024, TOTAL = 32 * 1024 * 1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function readRegular(file, maximum = LIMIT) {
  const absolute = path.resolve(file);
  for (let current = path.dirname(absolute); ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked supply ancestor');
    if (current === path.dirname(current)) break;
  }
  const before = fs.lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) throw new Error('Invalid supply original');
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0));
  let failure;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || opened.size !== before.size) throw new Error('Supply identity changed');
    const bytes = Buffer.alloc(opened.size); let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) throw new Error('Supply shortened'); offset += count; }
    const after = fs.fstatSync(fd), named = fs.lstatSync(absolute);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.nlink !== 1 || named.nlink !== 1 || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino) throw new Error('Supply changed while reading');
    return bytes;
  } catch (error) { failure = error; throw error; }
  finally { try { fs.closeSync(fd); } catch (error) { throw failure ? new AggregateError([failure, error], 'Supply read/close failed', { cause: failure }) : error; } }
}
function reference(file, maximum) { const bytes = readRegular(file, maximum); return { path: path.resolve(file), bytes: bytes.length, sha256: hash(bytes) }; }
function bound(ref, maximum) {
  if (!ref || !path.isAbsolute(ref.path) || !Number.isSafeInteger(ref.bytes) || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error('Invalid supply reference');
  const bytes = readRegular(ref.path, maximum); if (bytes.length !== ref.bytes || hash(bytes) !== ref.sha256) throw new Error('Supply reference mismatch'); return bytes;
}
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return reference(file); }
function artifact(ref) {
  const bytes = bound(ref); if (sha512Integrity(bytes) !== ref.integrity) throw new Error('Supply SRI mismatch');
  zlib.gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 });
  const { manifest, entries } = inspectTarballBuffer(bytes);
  if (!manifest.name || semver.valid(manifest.version) !== manifest.version || ref.name !== manifest.name || ref.version !== manifest.version) throw new Error('Invalid supply package identity');
  return { tarball: ref.path, bytes, manifest, integrity: ref.integrity, entries };
}
function verifyArtifactSource(value, directory, expected) {
  assert.deepEqual(value.manifest, expected, 'Normal manifest changed');
  for (const entry of value.entries) {
    if (entry.type === 'directory') continue;
    if (entry.type !== 'file' || !entry.path.startsWith('package/')) throw new Error('Normal archive layout changed');
    const relative = entry.path.slice('package/'.length);
    if (relative === 'package.json') continue;
    if (!readRegular(path.join(directory, relative)).equals(entry.content)) throw new Error('Normal archive payload changed');
  }
}
function verifyPublicationMetadata(value, metadata) {
  const manifest = value.manifest, version = metadata?.versions?.[manifest.version];
  if (metadata?.name !== manifest.name || version?.name !== manifest.name || version.version !== manifest.version
    || version.dist?.integrity !== value.integrity || version.dist?.shasum !== crypto.createHash('sha1').update(value.bytes).digest('hex')) throw new Error('Publication identity/dist changed');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']) assert.deepEqual(version[field], manifest[field], 'Publication dependency metadata changed');
  // npm normalizes the two supported aliases. Preserve originals, compare the same semantic list.
  const bundled = row => row.bundleDependencies ?? row.bundledDependencies;
  assert.deepEqual(bundled(version), bundled(manifest), 'Publication bundled metadata changed');
}
function sourceAuthority(root) {
  const source = JSON.parse(readRegular(path.join(root, 'package.json')));
  const workspaces = new Map();
  for (const name of fs.readdirSync(path.join(root, 'packages'))) {
    const file = path.join(root, 'packages', name, 'package.json'); if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(readRegular(file));
    if (workspaces.has(manifest.name)) throw new Error('Duplicate workspace identity');
    workspaces.set(manifest.name, { directory: name, manifest: normalizeWorkspaceDependencies(root, manifest) });
  }
  const git = new Map();
  for (const [name, spec] of Object.entries(source.dependencies ?? {})) if (typeof spec === 'string' && spec.startsWith('github:')) {
    const match = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([a-f0-9]{40})$/.exec(spec);
    if (!match) throw new Error('Exact external Git source required'); git.set(name, { repository: match[1], commit: match[2] });
  }
  return { workspaces, git };
}
function edges(manifest) {
  return [...Object.entries(manifest.dependencies ?? {}), ...Object.entries(manifest.optionalDependencies ?? {}),
    ...Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => !manifest.peerDependenciesMeta?.[name]?.optional)];
}
function privateSources(authority) {
  return { workspaces: [...authority.workspaces].map(([name, row]) => ({ name, directory: row.directory, version: row.manifest.version })).sort((a, b) => a.name.localeCompare(b.name)),
    git: [...authority.git].map(([name, source]) => ({ name, ...source })).sort((a, b) => a.name.localeCompare(b.name)) };
}
// Derive recursively from the real root and original normal manifests, never a historical missing-name list.
function requiredArtifacts(rootManifest, manifests, authority) {
  const required = new Map(), queue = [rootManifest], supplied = new Map();
  for (const manifest of manifests) {
    if (supplied.has(manifest.name)) throw new Error('Duplicate supplied identity'); supplied.set(manifest.name, manifest);
  }
  while (queue.length) for (const [name, range] of edges(queue.shift())) {
    const local = authority.workspaces.has(name) || authority.git.has(name);
    if (!local) { if (typeof range !== 'string' || /^(?:workspace:|file:|link:|github:)/.test(range)) throw new Error('Unknown private supply: ' + name); continue; }
    const selected = supplied.get(name);
    if (!selected || !semver.satisfies(selected.version, range, { includePrerelease: true })) throw new Error('Missing exact private supply or range mismatch: ' + name);
    if (!required.has(name)) { required.set(name, { name, version: selected.version }); queue.push(selected); }
  }
  if (!required.size) throw new Error('Empty private required set');
  return [...required.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function verifyExternalPin(name, authority, externals) {
  const source = authority.git.get(name), candidates = externals?.filter(value => value.name === name);
  const external = candidates?.length === 1 ? candidates[0] : null;
  if (!source || !external || external.source?.repository !== source.repository || external.source?.commit !== source.commit
    || external.sourceBefore?.sourceSha !== source.commit || external.sourceAfter?.sourceSha !== source.commit) throw new Error('External pin mismatch');
  return external;
}
function verifyBuild(inputFile, root, rootArtifact) {
  if (typeof inputFile !== 'string' || !path.isAbsolute(inputFile)) throw new Error('Explicit absolute supply input required');
  const input = JSON.parse(readRegular(inputFile));
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (input.kind !== 'legacy-root-normal-build-input' || input.sourceSha !== actual || !/^[a-f0-9]{40}$/.test(actual) || input.sourceBeforeStatus !== '') throw new Error('Root build source mismatch');
  if (!/^[1-9]\d*$/.test(input.runId ?? '') || !Number.isSafeInteger(input.runAttempt) || input.runAttempt < 1
    || process.env.GITHUB_ACTIONS === 'true' && (input.runId !== process.env.GITHUB_RUN_ID || String(input.runAttempt) !== process.env.GITHUB_RUN_ATTEMPT)) throw new Error('Root build run/attempt mismatch');
  const step = input.build;
  if (JSON.stringify(step?.command) !== JSON.stringify(['bun', 'run', 'build']) || step.actualExit !== 0 || step.signal !== null || step.spawnError !== null || step.actualWaitCompleted !== true || step.rawLogsClosed !== true) throw new Error('Actual root build outcome required');
  for (const channel of ['stdout', 'stderr']) bound(step[channel], 128 * 1024 * 1024);
  const original = bound(input.archive, 128 * 1024 * 1024);
  if (!original.equals(rootArtifact.bytes) || input.archive.integrity !== rootArtifact.integrity) throw new Error('Root archive binding mismatch');
  const snapshot = snapshotWorkspace(root);
  if (snapshot.sourceSha !== actual) throw new Error('Supply checkout changed');
  // The existing lane's exact emitted-UI observation is the only admitted tracked delta.
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--no-renames'], { cwd: root, encoding: 'utf8' }).trimEnd();
  require('../release-gate-evidence.cjs').verifyCompatSourceObservation(status, input.uiObservation);
  return { input, snapshot };
}
function producerRecipes(rootManifest, authority, normalManifests = []) {
  const normal = new Map(normalManifests.map(row => [row.name, row]));
  const selected = new Map(), queue = [rootManifest];
  while (queue.length) for (const [name] of edges(queue.shift())) {
    const local = authority.workspaces.get(name);
    if (!local || selected.has(name)) continue;
    const distribution = normal.get(name);
    const recipe = name === '@undefineds.co/xpod-afs' ? 'afs-standalone-js' : distribution ? 'cli-normal-publication' : 'workspace-normal-pack';
    if (local.manifest.private && recipe !== 'afs-standalone-js') throw new Error('Private workspace has no normal distribution recipe: ' + name);
    selected.set(name, { name, directory: local.directory, recipe }); queue.push(distribution ?? local.manifest);
  }
  for (const [name] of authority.git) if (edges(rootManifest).some(([dependency]) => dependency === name)) selected.set(name, { name, recipe: 'external-git-normal' });
  return [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
}
async function produceRootSupply({ inputFile, root, rootArtifact, destination, cache }, execute = (...args) => require('../check-package-registry-consumer.cjs').run(...args)) {
  root = fs.realpathSync(root);
  const { input, snapshot } = verifyBuild(inputFile, root, rootArtifact), authority = sourceAuthority(root);
  fs.mkdirSync(destination, { mode: 0o700 });
  write(path.join(destination, 'source-before.original.json'), snapshot);
  const archives = path.join(destination, 'archives'); fs.mkdirSync(archives);
  const commands = [];
  const event = row => fs.appendFileSync(path.join(destination, 'commands.original.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', { mode: 0o600 });
  const run = async (command, args, cwd) => {
    event({ event: 'start', command, args, cwd });
    try {
      await execute(args, process.env, command, cwd);
      const record = { command, args, cwd, completed: true, scope: 'Existing command runner completion only; parent install raw records output, no invented per-command raw/group admission' };
      commands.push(record); event({ event: 'returned', ...record });
    } catch (primary) {
      try { event({ event: 'failed', command, args, cwd, message: primary.message }); }
      catch (secondary) { throw new AggregateError([primary, secondary], 'Normal command and diagnostic write failed', { cause: primary }); }
      throw primary;
    }
  };
  let normalSupply, normalArtifacts = [];
  const normalInput = process.env.XPOD_LEGACY_AFS_SUPPLY;
  if (normalInput) {
    const helper = require('./legacy-afs-supply.cjs');
    helper.verifyCustody(normalInput, input, root);
    const retained = path.join(destination, 'normal-afs'); helper.copyTree(normalInput, retained);
    const verified = helper.verifyCustody(retained, input, root); normalArtifacts = verified.artifacts;
    normalSupply = { directory: retained, member: 'normal-afs' };
  }
  const recipes = producerRecipes(rootArtifact.manifest, authority, normalArtifacts.map(row => row.manifest));
  if (recipes.some(row => row.recipe === 'afs-standalone-js') && !normalArtifacts.some(row => row.manifest.name === '@undefineds.co/xpod-afs')) throw new Error('Original normal AFS distribution required');
  const packed = packWorkspacePackages(root, recipes.filter(row => row.recipe === 'workspace-normal-pack').map(row => row.directory), archives);
  for (const value of normalArtifacts) {
    if (!recipes.some(row => row.name === value.manifest.name)) throw new Error('Normal distribution outside private graph');
    const file = path.join(archives, value.manifest.name.split('/').pop() + '.tgz'); fs.writeFileSync(file, value.bytes, { flag: 'wx' }); packed[value.manifest.name] = file;
  }
  const externals = [];
  for (const [name, source] of authority.git) {
    if (!edges(rootArtifact.manifest).some(([dependency]) => dependency === name)) continue;
    fs.mkdirSync(cache, { recursive: true });
    const directory = fs.mkdtempSync(path.join(cache, 'root-supply-source-'));
    await run('git', ['init', '-q'], directory);
    await run('git', ['config', '--local', 'core.autocrlf', 'false'], directory);
    await run('git', ['fetch', '--no-tags', '--depth', '1', 'https://github.com/' + source.repository, source.commit], directory);
    await run('git', ['checkout', '--detach', 'FETCH_HEAD'], directory);
    if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim() !== source.commit) throw new Error('External source mismatch');
    const before = snapshotWorkspace(directory), manifestBytes = readRegular(path.join(directory, 'package.json')), manifest = JSON.parse(manifestBytes);
    if (!before.clean || manifest.name !== name || !manifest.scripts?.prepare || !manifest.scripts?.test || !manifest.scripts?.typecheck) throw new Error('Normal external producer contract missing');
    write(path.join(destination, 'external-' + externals.length + '.source-before.original.json'), before);
    fs.writeFileSync(path.join(destination, 'external-' + externals.length + '.package.original.json'), manifestBytes, { flag: 'wx', mode: 0o600 });
    await run('bun', ['install', '--frozen-lockfile', '--ignore-scripts', '--cache-dir', path.join(cache, 'external-install-cache')], directory);
    await run('bun', ['run', 'test'], directory); await run('bun', ['run', 'typecheck'], directory);
    const archive = path.join(archives, 'external-' + externals.length + '.tgz');
    await run('bun', ['pm', 'pack', '--filename', archive], directory);
    if (!readRegular(path.join(directory, 'package.json')).equals(manifestBytes)) throw new Error('External manifest changed');
    const after = snapshotWorkspace(directory), outputRoots = new Set();
    const targets = [manifest.main, manifest.types, ...Object.values(manifest.exports ?? {}).flatMap(value => typeof value === 'string' ? [value] : Object.values(value))];
    for (const target of targets) if (typeof target === 'string') { const first = target.replace(/^\.\//, '').split('/')[0]; if (first && first !== '.' && first !== '..' && target.includes('/')) outputRoots.add(first); }
    if (after.sourceSha !== source.commit || after.files.length !== before.files.length || after.files.some((row, index) => row.path !== before.files[index].path || row.sha256 !== before.files[index].sha256 && !outputRoots.has(row.path.split('/')[0]))) throw new Error('External immutable source changed');
    write(path.join(destination, 'external-' + externals.length + '.source-after.original.json'), after);
    externals.push({ name, directory, source, sourceBefore: before, sourceAfter: after, manifest: { bytes: manifestBytes.length, sha256: hash(manifestBytes) } }); packed[name] = archive;
  }
  const after = snapshotWorkspace(root);
  if (after.inputSHA256 !== snapshot.inputSHA256) throw new Error('Source changed during normal pack');
  write(path.join(destination, 'source-after.original.json'), after);
  const artifacts = Object.entries(packed).map(([name, file]) => { const bytes = readRegular(file); const inspected = inspectTarballBuffer(bytes); if (inspected.manifest.name !== name) throw new Error('Normal pack identity mismatch'); return { ...reference(file), file: path.basename(file), integrity: sha512Integrity(bytes), name, version: inspected.manifest.version }; });
  if (artifacts.length > 64 || artifacts.reduce((n, row) => n + row.bytes, 0) > TOTAL) throw new Error('Root supply budget exceeded');
  const manifests = artifacts.map(row => {
    const value = artifact(row), local = authority.workspaces.get(row.name);
    const supplied = normalArtifacts.find(item => item.manifest.name === row.name);
    if (supplied) { if (!value.bytes.equals(supplied.bytes)) throw new Error('Original distribution changed'); return value.manifest; }
    const external = externals.find(item => item.name === row.name);
    const directory = local ? path.join(root, 'packages', local.directory) : external.directory;
    const expected = local ? local.manifest : JSON.parse(readRegular(path.join(directory, 'package.json')));
    verifyArtifactSource(value, directory, expected); return value.manifest;
  }), required = requiredArtifacts(rootArtifact.manifest, manifests, authority);
  const receipt = { kind: 'legacy-root-normal-supply', sourceSha: input.sourceSha, runId: input.runId, runAttempt: input.runAttempt, buildInput: reference(inputFile), sourceBefore: snapshot, sourceAfter: after, rootManifest: rootArtifact.manifest, privateSources: privateSources(authority),
    normalSupply, recipes, producerTools: ['scripts/workspace-package-pack.cjs', 'scripts/lib/root-registry-supply.cjs'].map(file => ({ file, ...reference(path.join(root, file)) })), commands, externals, artifacts, required, published: false, releaseQualified: false };
  const receiptRef = write(path.join(destination, 'supply.original.json'), receipt);
  return { receipt: receiptRef, artifacts: manifests.map((_, i) => artifact(artifacts[i])), required };
}
function readRootSupply(requestFile, root, rootArtifact) {
  const request = JSON.parse(readRegular(requestFile)), receipt = JSON.parse(bound(request.receipt));
  const verified = verifyBuild(receipt.buildInput.path, root, rootArtifact);
  bound(receipt.buildInput);
  if (receipt.kind !== 'legacy-root-normal-supply' || receipt.sourceSha !== verified.input.sourceSha || receipt.sourceBefore?.inputSHA256 !== receipt.sourceAfter?.inputSHA256 || receipt.sourceAfter?.inputSHA256 !== verified.snapshot.inputSHA256) throw new Error('Normal supply source mismatch');
  if (JSON.stringify(receipt.producerTools?.map(tool => tool.file)) !== JSON.stringify(['scripts/workspace-package-pack.cjs', 'scripts/lib/root-registry-supply.cjs'])) throw new Error('Missing normal producer tools');
  for (const tool of receipt.producerTools) if (!bound(tool).equals(readRegular(path.join(root, tool.file)))) throw new Error('Supply producer tool changed');
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length > 64 || receipt.artifacts.reduce((n, row) => n + row.bytes, 0) > TOTAL) throw new Error('Root supply budget exceeded');
  const artifacts = receipt.artifacts.map(artifact), authority = sourceAuthority(root);
  const normalArtifacts = receipt.normalSupply ? require('./legacy-afs-supply.cjs').verifyCustody(receipt.normalSupply.directory, verified.input, root).artifacts : [];
  if (receipt.recipes) assert.deepEqual(receipt.recipes, producerRecipes(rootArtifact.manifest, authority, normalArtifacts.map(row => row.manifest)));
  assert.deepEqual(receipt.rootManifest, rootArtifact.manifest, 'Root manifest changed');
  assert.deepEqual(receipt.privateSources, privateSources(authority), 'Private source authority changed');
  const required = requiredArtifacts(rootArtifact.manifest, artifacts.map(row => row.manifest), authority);
  if (required.length !== artifacts.length) throw new Error('Unexpected artifact outside private closure');
  for (const row of artifacts) {
    const supplied = normalArtifacts.find(value => value.manifest.name === row.manifest.name);
    if (supplied) { if (!row.bytes.equals(supplied.bytes)) throw new Error('Original distribution changed'); continue; }
    const local = authority.workspaces.get(row.manifest.name);
    if (local) {
      if (local.manifest.version !== row.manifest.version) throw new Error('Workspace version changed');
      verifyArtifactSource(row, path.join(root, 'packages', local.directory), local.manifest);
    } else {
      const external = verifyExternalPin(row.manifest.name, authority, receipt.externals);
      if (snapshotWorkspace(external.directory).inputSHA256 !== external.sourceAfter.inputSHA256) throw new Error('External producer source changed');
      verifyArtifactSource(row, external.directory, JSON.parse(readRegular(path.join(external.directory, 'package.json'))));
    }
  }
  if (JSON.stringify(receipt.required) !== JSON.stringify(required)) throw new Error('Required closure changed');
  return { artifacts, required, receipt: request.receipt };
}
// Portable integrity readback of this lane's originals. Execution qualification
// still comes from the exact lane command/raw outcomes, not receipt booleans.
function verifyRetainedSupply(directory, ref, sourceSha, rootArchive) {
  if (ref?.path !== 'registry-supply/publication.original.json') throw new Error('Root supply publication reference missing');
  const readAt = (row, file, maximum) => bound({ ...row, path: file }, maximum);
  const base = path.join(directory, 'registry-supply');
  const publication = JSON.parse(readAt(ref, path.join(directory, ref.path)));
  const receipt = JSON.parse(readAt(publication.source, path.join(base, 'supply.original.json')));
  if (receipt.kind !== 'legacy-root-normal-supply' || receipt.sourceSha !== sourceSha || receipt.sourceBefore?.sourceSha !== sourceSha
    || receipt.sourceAfter?.sourceSha !== sourceSha || receipt.sourceBefore?.inputSHA256 !== receipt.sourceAfter?.inputSHA256) throw new Error('Retained supply source mismatch');
  if (!Array.isArray(receipt.artifacts) || !receipt.artifacts.length || receipt.artifacts.length > 64 || receipt.artifacts.reduce((n, row) => n + row.bytes, 0) > TOTAL) throw new Error('Retained supply budget invalid');
  let retainedNormal = [];
  if (receipt.normalSupply) {
    if (receipt.normalSupply.member !== 'normal-afs') throw new Error('Invalid retained normal supply member');
    retainedNormal = require('./legacy-afs-supply.cjs').verifyCustody(path.join(base, 'normal-afs'), { sourceSha, runId: receipt.runId, runAttempt: receipt.runAttempt }, process.cwd(), { retained: true }).artifacts;
  }
  const names = new Set();
  const artifacts = receipt.artifacts.map(row => {
    const name = row.file;
    if (typeof name !== 'string' || /[\\/\x00-\x1f]/.test(name) || names.has(name) || !name.endsWith('.tgz')) throw new Error('Duplicate/invalid retained supply archive'); names.add(name);
    return artifact({ ...row, path: path.join(base, 'archives', name) });
  });
  if (artifacts.some(row => row.manifest.name === '@undefineds.co/xpod-afs') && !retainedNormal.length) throw new Error('Retained standalone AFS originals required');
  for (const normal of retainedNormal) {
    const matches = artifacts.filter(row => row.manifest.name === normal.manifest.name);
    if (matches.length !== 1 || !matches[0].bytes.equals(normal.bytes)) throw new Error('Retained normal distribution changed');
  }
  const authority = { workspaces: new Map(receipt.privateSources?.workspaces?.map(row => [row.name, row]) ?? []), git: new Map(receipt.privateSources?.git?.map(row => [row.name, row]) ?? []) };
  for (const value of artifacts) {
    const local = authority.workspaces.get(value.manifest.name);
    if (local) { if (local.version !== value.manifest.version) throw new Error('Retained workspace version mismatch'); }
    else verifyExternalPin(value.manifest.name, authority, receipt.externals);
  }
  const required = requiredArtifacts(receipt.rootManifest, artifacts.map(row => row.manifest), authority);
  if (required.length !== artifacts.length) throw new Error('Unexpected retained artifact outside private closure');
  assert.deepEqual(receipt.required, required); assert.deepEqual(publication.required, required);
  if (publication.publications?.length !== artifacts.length) throw new Error('Missing retained publication metadata');
  for (const [index, row] of publication.publications.entries()) {
    if (row.file !== 'publication-' + index + '.original.json' || row.name !== artifacts[index].manifest.name || row.version !== artifacts[index].manifest.version) throw new Error('Retained publication identity mismatch');
    verifyPublicationMetadata(artifacts[index], JSON.parse(readAt(row, path.join(base, row.file))));
  }
  const rootBytes = readAt(rootArchive, path.join(directory, rootArchive.path), 128 * 1024 * 1024);
  if (receipt.rootManifest?.name !== rootArchive.name || receipt.rootManifest?.version !== rootArchive.version) throw new Error('Retained root identity mismatch');
  verifyPublicationMetadata({ bytes: rootBytes, integrity: rootArchive.integrity, manifest: receipt.rootManifest }, publication.root);
  return { required, originalArchives: artifacts.length, sourceSha, publicDependencies: publication.publicDependencies };
}
module.exports = { readRegular, reference, bound, artifact, verifyArtifactSource, verifyPublicationMetadata, sourceAuthority, producerRecipes, requiredArtifacts, verifyExternalPin, verifyBuild, produceRootSupply, readRootSupply, verifyRetainedSupply };
