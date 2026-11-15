'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { parseTar, sha512Integrity } = require('./workspace-package-payload.cjs');
const { normalizeWorkspaceDependencies } = require('./workspace-package-pack.cjs');
const { PACKAGES } = require('./workspace-package-consumer.cjs');

// One existing external producer contract, not a caller supplied trust switch.
const EXTERNAL_HARNESS = 'd88245884e27852a76b72c7dc0c423399da664050e80b65dd663b668de17221f';
// Execution coordinates of the hash-pinned harness above; receipt paths cannot redefine them.
const EXTERNAL_PROFILE = Object.freeze({
  root: '/Users/gbb/develop/.worktrees/.test-data/extensions-normal-producer-4979425-20261016',
  repository: 'https://github.com/undefinedsco/extensions',
  commit: '497942519bc211b6b5bc684f47f41bad189cf632',
  name: '@undefineds.co/extensions', version: '0.1.0',
});
const WORKSPACE_COLLECTOR = '8f14113cfa81702b2ebc7879481c7cbeb61ffb3e2acce3ed540ec6f5ea02fdf7';
// Only the independently reviewed collector/runner pair is supported. This
// allows original verification; it does not establish a successful normal run.
const REVIEWED_WORKSPACE_RUNNERS = new Set([
  '97980fdad10a7d078aac8746c5ed2549e24419fb67de63f16438e45f7493e8be',
]);
const PHASES = ['bun-version', 'node-version', 'git-init', 'git-fetch-pin', 'git-checkout-pin', 'source-head',
  'source-before', 'source-input-list', 'install-tools-frozen', 'upstream-tests', 'upstream-typecheck',
  'normal-pack-with-prepare', 'source-after', 'tracked-generated-diff', 'node-archive-install', 'node-public-exports',
  'node-remove', 'bun-archive-install', 'bun-public-exports', 'bun-remove'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function need(ok, message) { if (!ok) throw new Error('Normal registry artifact blocked: ' + message); }
function noSymlinkPath(file) {
  need(typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file, 'canonical absolute original path required');
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    need(!fs.lstatSync(current).isSymbolicLink(), 'original path contains a symlink');
  }
}
function ordinary(file, maximum) {
  noSymlinkPath(file);
  const stat = fs.lstatSync(file);
  need(stat.isFile() && stat.size <= maximum, 'bounded regular original required');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    need(before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs
      && bytes.length === before.size && bytes.length <= maximum, 'original changed while reading');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function original(ref, maximum = 16 * 1024 ** 2) {
  need(ref && /^[a-f0-9]{64}$/.test(ref.sha256) && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0, 'original byte reference required');
  const bytes = ordinary(ref.path, maximum);
  need(bytes.length === ref.bytes && hash(bytes) === ref.sha256, 'original reference mismatch');
  return bytes;
}
function json(ref, maximum) { return JSON.parse(original(ref, maximum).toString()); }
function below(root, relative) {
  need(typeof relative === 'string' && relative && !relative.includes('\\') && !path.isAbsolute(relative)
    && relative.split('/').every(part => part && part !== '.' && part !== '..'), 'unsafe relative original path');
  return path.join(root, relative);
}
function identity(expected) {
  need(expected && /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(expected.repository)
    && /^[a-f0-9]{40}$/.test(expected.commit) && typeof expected.name === 'string'
    && typeof expected.version === 'string' && require('semver').valid(expected.version) === expected.version, 'complete exact source identity required');
}
function verifyActualInputs(source, commit, expectedTree, inputs) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const nullFile = require('node:os').devNull;
  env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_GLOBAL = nullFile;
  const git = args => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${nullFile}`, ...args],
    { cwd: source, env, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 ** 2 });
  need(git(['rev-parse', 'HEAD']).trim() === commit && (!expectedTree || git(['rev-parse', 'HEAD^{tree}']).trim() === expectedTree)
    && !git(['status', '--porcelain', '--untracked-files=all']).trim(), 'actual retained checkout identity/state changed');
  const staged = git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
  const head = new Map(git(['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean).map(row => {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
    need(match, 'HEAD contains an unsupported source input'); return [match[3], { mode: match[1], blob: match[2] }];
  }));
  need(staged.length === Object.keys(inputs).length && head.size === staged.length, 'actual source inventory changed');
  for (const row of staged) {
    const match = /^(100644|100755|120000) ([a-f0-9]{40}) 0\t(.+)$/.exec(row);
    need(match && Object.prototype.hasOwnProperty.call(inputs, match[3]), 'unbound/nonregular source input');
    const file = below(source, match[3]), ref = inputs[match[3]];
    let bytes;
    if (match[1] === '120000') {
      noSymlinkPath(path.dirname(file));
      const before = fs.lstatSync(file);
      need(before.isSymbolicLink() && ref.mode === '120000', 'tracked symlink mode mismatch');
      bytes = fs.readlinkSync(file, { encoding: 'buffer' });
      const target = bytes.toString('utf8'), relativeTarget = path.relative(source, path.resolve(path.dirname(file), target));
      need(Buffer.from(target).equals(bytes) && target.length > 0 && !path.isAbsolute(target) && !path.win32.isAbsolute(target) && !target.includes('\\')
        && relativeTarget !== '..' && !relativeTarget.startsWith('..' + path.sep) && !path.isAbsolute(relativeTarget),
      'tracked symlink target escapes source');
      const after = fs.lstatSync(file);
      need(after.isSymbolicLink() && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs
        && ref.linkTargetBase64 === bytes.toString('base64'), 'tracked symlink changed while reading');
    } else bytes = ordinary(file, 16 * 1024 ** 2);
    need(head.get(match[3])?.mode === match[1] && head.get(match[3])?.blob === match[2]
      && (ref.mode === undefined || ref.mode === match[1]) && (ref.gitBlob === undefined || ref.gitBlob === match[2])
      && bytes.length === ref.bytes && hash(bytes) === ref.sha256
      && crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex') === match[2]
      && (match[1] === '120000' || Boolean(fs.statSync(file).mode & 0o111) === (match[1] === '100755')), 'actual source input content/mode mismatch');
  }
}
function inspectBoundedArchive(bytes) {
  const entries = parseTar(zlib.gunzipSync(bytes, { maxOutputLength: 128 * 1024 ** 2 }));
  need(entries.length > 0 && entries.length <= 10000 && entries.every(row => row.type === 'file' || row.type === 'directory'), 'archive member contract mismatch');
  const files = new Set(entries.filter(row => row.type === 'file').map(row => row.path));
  for (const row of entries) {
    const name = row.path.replace(/\/$/, '');
    need((name === 'package' && row.type === 'directory') || name.startsWith('package/'), 'archive package layout mismatch');
    const parts = name.split('/');
    need(!parts.slice(1).some((_, index) => files.has(parts.slice(0, index + 1).join('/'))), 'archive file/directory layout conflict');
  }
  const manifestEntry = entries.find(row => row.path === 'package/package.json');
  need(manifestEntry?.type === 'file', 'archive original manifest missing');
  return { entries, manifestEntry, manifest: JSON.parse(manifestEntry.content.toString()) };
}

/** Local original binding only. It does not authenticate remote execution or grant release/source admission. */
function readExternalNormalArtifact(input) {
  identity(input?.expected);
  const e = input.expected, custody = json(input.custody);
  need(custody.kind === 'external-extensions-normal-producer-custody'
    && custody.source?.repository === e.repository && custody.source?.commit === e.commit, 'external source envelope mismatch');
  need(custody.harness?.sha256 === EXTERNAL_HARNESS, 'unsupported external producer harness');
  original(custody.harness);
  const result = json(custody.normalProducerReceipt);
  need(result.kind === 'external-extensions-normal-producer' && result.sourcePin === e.commit
    && result.published === false && result.releaseQualified === false && result.registryAdmission === false
    && result.legalClearance === false, 'producer identity or admission mismatch');
  const root = result.retainedOwnedRoot;
  need(root === EXTERNAL_PROFILE.root && e.repository === EXTERNAL_PROFILE.repository
    && e.commit === EXTERNAL_PROFILE.commit && e.name === EXTERNAL_PROFILE.name
    && e.version === EXTERNAL_PROFILE.version
    && custody.archive?.path === path.join(root, 'artifacts/extensions-0.1.0.tgz'),
  'producer execution coordinates differ from reviewed harness');
  need(Array.isArray(result.phases) && result.phases.length === PHASES.length, 'complete external phases required');
  const raw = new Map(), rows = new Map();
  for (const [index, row] of result.phases.entries()) {
    need(row.name === PHASES[index] && row.actualReturnCode === 0 && row.signal === null && row.waitStatus === 'known'
      && row.ownedGroupAbsent === true && row.rawClosed === true && row.rawClosedBeforeHash === true
      && Number.isSafeInteger(row.pid) && row.pid > 1 && Array.isArray(row.raw) && row.raw.length === 2, 'phase closure/identity mismatch');
    const streams = [];
    for (const [streamIndex, ref] of row.raw.entries()) {
      const relative = `evidence/${row.name}.${['stdout', 'stderr'][streamIndex]}.raw.log`;
      need(ref.path === relative, 'raw phase path mismatch');
      streams.push(original({ ...ref, path: below(root, relative) }));
    }
    raw.set(row.name, streams); rows.set(row.name, row);
  }
  const source = rows.get('source-head').cwd;
  need(source === path.join(root, 'source'), 'source checkout binding mismatch');
  const commands = {
    'git-fetch-pin': ['git', 'fetch', '--no-tags', '--depth', '1', e.repository, e.commit],
    'git-checkout-pin': ['git', 'checkout', '--detach', 'FETCH_HEAD'],
    'source-head': ['git', 'rev-parse', 'HEAD'],
    'source-before': ['git', 'status', '--porcelain', '--untracked-files=all'],
    'source-after': ['git', 'status', '--porcelain', '--untracked-files=all'],
    'source-input-list': ['git', 'ls-files', '-z'],
    'upstream-tests': ['bun', 'run', 'test'],
    'upstream-typecheck': ['bun', 'run', 'typecheck'],
    'normal-pack-with-prepare': ['bun', 'pm', 'pack', '--filename', custody.archive.path],
  };
  for (const [name, argv] of Object.entries(commands)) need(rows.get(name).cwd === source && isDeepStrictEqual(rows.get(name).argv, argv), 'normal producer command changed');
  const rootCommands = { 'bun-version': ['bun', '--version'], 'node-version': ['node', '--version'],
    'git-init': ['git', 'init', '-q', source] };
  for (const [name, argv] of Object.entries(rootCommands)) need(rows.get(name).cwd === root && isDeepStrictEqual(rows.get(name).argv, argv), 'producer bootstrap command changed');
  need(isDeepStrictEqual(rows.get('install-tools-frozen').argv, ['bun', 'install', '--frozen-lockfile', '--ignore-scripts', '--cache-dir', path.join(root, 'cache')])
    && rows.get('install-tools-frozen').cwd === source
    && isDeepStrictEqual(rows.get('tracked-generated-diff').argv, ['git', 'diff', '--binary'])
    && rows.get('tracked-generated-diff').cwd === source, 'normal tooling/source observation command changed');
  need(raw.get('source-head')[0].toString().trim() === e.commit && !raw.get('source-before')[0].length
    && !raw.get('source-after')[0].length && !raw.get('tracked-generated-diff')[0].length, 'original source state not clean/exact');
  need(raw.get('bun-version')[0].toString().trim() === '1.4.2' && raw.get('node-version')[0].toString().trim() === 'v22.21.1', 'producer toolchain changed');
  const packOutput = raw.get('normal-pack-with-prepare')[0].toString();
  need(packOutput.split(/\r?\n/).filter(line => line === custody.archive.path).length === 1,
    'original pack output execution path mismatch');
  const buildLog = raw.get('normal-pack-with-prepare')[1].toString();
  need(buildLog.includes('$ bun run build') && buildLog.includes('tsc -p tsconfig.json && tsc -p tsconfig.cjs.json'), 'normal prepare/build execution evidence missing');
  need(Array.isArray(custody.retainedOriginals), 'source input originals missing');
  const retained = name => {
    const matches = custody.retainedOriginals.filter(ref => ref.path === path.join(root, name));
    need(matches.length === 1, 'unique source input original required'); return json(matches[0]);
  };
  const before = retained('source-inputs-before.original.json'), after = retained('source-inputs-after.original.json');
  need(isDeepStrictEqual(retained('phases.original.json'), result.phases), 'standalone phase original mismatch');
  need(isDeepStrictEqual(before, after), 'source input bytes drifted');
  const listed = raw.get('source-input-list')[0].toString().split('\0').filter(Boolean);
  need(listed.length > 0 && listed.length <= 1000 && new Set(listed).size === listed.length
    && isDeepStrictEqual([...listed].sort(), Object.keys(before).sort()), 'source inventory coverage mismatch');
  verifyActualInputs(source, e.commit, custody.source.gitTree, before);
  const bytes = original(custody.archive, 32 * 1024 ** 2);
  need(result.archive?.path === custody.archive.path && result.archive.sha256 === custody.archive.sha256
    && result.archive.bytes === bytes.length && result.archive.integrity === custody.integrity
    && sha512Integrity(bytes) === custody.integrity, 'archive original/SRI mismatch');
  // Reuse the existing parser, adding a bounded decompression before parsing.
  const { entries, manifestEntry } = inspectBoundedArchive(bytes);
  need(entries.length <= 1000 && entries.every(row => row.type === 'file'), 'external archive must contain regular files');
  need(manifestEntry && manifestEntry.content.equals(original(custody.originalManifest))
    && manifestEntry.content.equals(ordinary(path.join(source, 'package.json'), 1024 ** 2)), 'original manifest changed');
  const manifest = JSON.parse(manifestEntry.content.toString());
  need(manifest.name === e.name && manifest.version === e.version, 'archive package identity mismatch');
  for (const entry of entries) {
    need(entry.path.startsWith('package/'), 'archive package path mismatch');
    const file = below(source, entry.path.slice(8));
    need(entry.content.equals(ordinary(file, 16 * 1024 ** 2))
      && entry.mode === (fs.statSync(file).mode & 0o111 ? 0o755 : 0o644), 'archive payload differs from actual source build');
  }
  for (const runtime of ['node', 'bun']) {
    const probe = JSON.parse(raw.get(runtime + '-public-exports')[0].toString());
    need(probe.esm === true && probe.cjs === true && probe.registryReaders === 0 && probe.registryTools === 0
      && probe.installedResolutionContained === true, 'public archive consumer probe mismatch');
    const cwd = path.join(root, runtime + '-consumer');
    const consumerCommands = {
      [runtime + '-archive-install']: ['bun', 'install', '--offline', '--ignore-scripts', '--cache-dir', path.join(root, 'cache')],
      [runtime + '-public-exports']: [runtime, path.join(cwd, 'probe.mjs')],
      [runtime + '-remove']: ['bun', 'remove', e.name, '--offline', '--ignore-scripts', '--cache-dir', path.join(root, 'cache')],
    };
    for (const [name, argv] of Object.entries(consumerCommands)) need(rows.get(name).cwd === cwd && isDeepStrictEqual(rows.get(name).argv, argv), 'archive consumer command changed');
    need(rows.get(runtime + '-archive-install').cwd === cwd
      && !fs.existsSync(path.join(root, runtime + '-consumer/node_modules', e.name)), 'consumer binding/removal mismatch');
  }
  return { artifact: { tarball: custody.archive.path, bytes, manifest, integrity: custody.integrity },
    binding: { repository: e.repository, commit: e.commit, custody: input.custody, phases: PHASES.length, rawFiles: PHASES.length * 2,
      scope: 'Retained local normal producer/input/archive/consumer observations; no authenticated remote execution or release authority.' },
    sourceAdmission: false, releaseQualified: false, published: false };
}

function readWorkspaceNormalArtifacts(input) {
  const receipt = json(input?.receipt);
  need(receipt.kind === 'workspace-consumer-acceptance', 'workspace receipt kind mismatch');
  const execution = receipt.execution;
  need(execution && receipt.schemaVersion === 1, 'workspace original normal-run phase/raw/source-input collector evidence is required; receipt.ok/sourceAuthority are not execution authority');
  const expected = input.expected;
  need(expected?.repository === 'https://github.com/undefinedsco/xpod' && /^[a-f0-9]{40}$/.test(expected.commit)
    && receipt.sourceSha === expected.commit, 'workspace exact source envelope required');
  const output = path.dirname(input.receipt.path), root = execution.root;
  need(typeof root === 'string' && path.isAbsolute(root) && path.resolve(root) === root, 'workspace source root required');
  const relativeOriginal = ref => original({ ...ref, path: below(output, ref?.path) });
  const relativeJSON = ref => JSON.parse(relativeOriginal(ref).toString());
  const phase = execution.phase;
  need(phase && phase.code === 0 && phase.actualReturnCode === 0 && phase.signal === null && !phase.spawnError
    && phase.waitStatus === 'known' && phase.actualWait === true && phase.actualClose === true && phase.groupAbsent === true
    && phase.rawComplete === true && phase.rawClosed === true && phase.rawClosedBeforeHash === true && phase.cwd === root
    && Array.isArray(phase.pipeEOF) && isDeepStrictEqual(phase.pipeEOF, [true, true]), 'workspace composite execution/EOF closure incomplete');
  need(Array.isArray(phase.raw) && phase.raw.length === 2, 'workspace composite raw originals missing');
  for (const [index, ref] of phase.raw.entries()) {
    need(ref.path === `normal-pack-and-consumer.${['stdout', 'stderr'][index]}.raw.log`, 'workspace composite raw identity mismatch');
    relativeOriginal(ref);
  }
  const workspacePath = below(output, receipt.workspaceEvidence?.path);
  const wantedArgs = [path.join(root, 'scripts/workspace-package-consumer.cjs'), '--local', '--source-sha', expected.commit,
    '--archive-dir', path.join(output, 'archives'), '--evidence', workspacePath];
  need(typeof phase.command === 'string' && path.isAbsolute(phase.command) && ['node', 'bun', 'node.exe', 'bun.exe'].includes(path.basename(phase.command))
    && isDeepStrictEqual(phase.args, wantedArgs), 'workspace command is not the original composite normal entry');
  const tool = (ref, name) => {
    need(ref?.path === name && ref.actualPath === path.join(root, name), 'workspace tool path mismatch');
    return original({ ...ref, path: below(root, name) });
  };
  need(execution.collector?.sha256 === WORKSPACE_COLLECTOR, 'unsupported workspace collector');
  need(REVIEWED_WORKSPACE_RUNNERS.has(execution.commandRunner?.sha256), 'workspace command runner is blocked or has not passed independent closure review');
  tool(execution.collector, 'scripts/collect-workspace-normal-run.cjs');
  tool(execution.commandRunner, 'scripts/lib/afs-publication-command.cjs');
  const toolNames = ['scripts/workspace-package-consumer.cjs', 'scripts/workspace-package-pack.cjs',
    'scripts/workspace-package-payload.cjs', 'scripts/workspace-package-typecheck.cjs'];
  need(Array.isArray(execution.tools) && execution.tools.length === toolNames.length, 'workspace producer tools incomplete');
  for (const name of toolNames) {
    const refs = execution.tools.filter(ref => ref.path === name);
    need(refs.length === 1, 'workspace producer tool duplicate/missing');
    original({ ...refs[0], path: below(root, name) });
  }
  const snapshots = [execution.sourceBefore, execution.sourceAfter].map((ref, snapshotIndex) => {
    const value = relativeJSON(ref), suffix = snapshotIndex ? 'after' : 'before';
    need(value.sourceSha === expected.commit && Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 100000,
      'workspace source input inventory incomplete');
    need(Array.isArray(value.gitCommands) && value.gitCommands.length === 3, 'workspace original source Git outcomes missing');
    const commands = [['head', ['rev-parse', 'HEAD']], ['status', ['status', '--porcelain', '--untracked-files=all']],
      ['tracked-index', ['ls-files', '--stage', '-z']]];
    const observed = [];
    for (const [index, [label, args]] of commands.entries()) {
      const row = value.gitCommands[index];
      need(row.command === 'git' && isDeepStrictEqual(row.args, args) && row.cwd === root && row.actualReturnCode === 0
        && row.signal === null && row.waitStatus === 'known' && row.rawClosedBeforeHash === true
        && Array.isArray(row.raw) && row.raw.length === 2, 'workspace original source Git command mismatch');
      const streams = row.raw.map((raw, rawIndex) => {
        need(raw.path === `source-${suffix}-${label}.${['stdout', 'stderr'][rawIndex]}.raw.log`, 'workspace source raw identity mismatch');
        return relativeOriginal(raw);
      });
      observed.push(streams[0]);
    }
    need(observed[0].toString().trim() === expected.commit && observed[1].length === 0
      && value.statusSHA256 === hash(observed[1]), 'workspace original source state is not clean/exact');
    const indexed = observed[2].toString().split('\0').filter(Boolean).map(row => {
      const match = /^(100644|100755|120000) ([a-f0-9]{40}) 0\t(.+)$/.exec(row); need(match, 'workspace source index unsupported');
      return { path: match[3], mode: match[1], gitBlob: match[2] };
    });
    const files = new Map();
    for (const file of value.files) {
      need(!files.has(file.path) && /^[a-f0-9]{64}$/.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0,
        'workspace source input duplicate/invalid'); files.set(file.path, file);
    }
    need(indexed.length === files.size && indexed.every(row => files.get(row.path)?.mode === row.mode
      && files.get(row.path)?.gitBlob === row.gitBlob), 'workspace source index/input inventory coverage mismatch');
    const projection = { sourceSha: value.sourceSha, clean: true, statusSHA256: value.statusSHA256, files: value.files };
    need(value.inputSHA256 === hash(Buffer.from(JSON.stringify(projection))), 'workspace source input projection hash mismatch');
    return { value, inputs: Object.fromEntries(files) };
  });
  need(isDeepStrictEqual(snapshots[0].inputs, snapshots[1].inputs), 'workspace tracked inputs changed');
  for (const ref of [execution.collector, execution.commandRunner, ...execution.tools]) {
    need(snapshots[0].inputs[ref.path]?.sha256 === ref.sha256
      && snapshots[0].inputs[ref.path]?.bytes === ref.bytes, 'workspace executed tool is not bound to tracked source inputs');
  }
  verifyActualInputs(root, expected.commit, undefined, snapshots[0].inputs);
  const child = relativeJSON(receipt.workspaceEvidence);
  need(child.kind === 'workspace-consumer-acceptance' && child.schemaVersion === 1 && child.sourceSha === expected.commit
    && Array.isArray(child.packages) && child.packages.length === PACKAGES.length
    && Array.isArray(receipt.archives) && receipt.archives.length === PACKAGES.length, 'workspace normal archive coverage incomplete');
  const artifacts = [], seen = new Set();
  for (const directory of PACKAGES) {
    const sourceManifest = JSON.parse(ordinary(path.join(root, 'packages', directory, 'package.json'), 1024 ** 2).toString());
    const normalized = normalizeWorkspaceDependencies(root, sourceManifest);
    const rows = receipt.archives.filter(row => row.packageName === sourceManifest.name);
    const childRows = child.packages.filter(row => row.packageName === sourceManifest.name);
    need(rows.length === 1 && childRows.length === 1, 'workspace archive identity duplicate/missing');
    const row = rows[0], bound = childRows[0];
    need(row.path === `archives/${bound.name}` && !seen.has(row.path) && row.version === sourceManifest.version
      && bound.version === row.version && bound.sha256 === row.sha256 && bound.size === row.bytes
      && bound.integrity === row.integrity, 'workspace normal archive references disagree');
    seen.add(row.path);
    const bytes = original({ ...row, path: below(output, row.path) }, 32 * 1024 ** 2);
    need(sha512Integrity(bytes) === row.integrity, 'workspace archive SRI mismatch');
    const { manifest } = inspectBoundedArchive(bytes);
    need(manifest.name === sourceManifest.name && manifest.version === sourceManifest.version && !manifest.private, 'workspace archive original identity/private mismatch');
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'devDependencies']) {
      need(isDeepStrictEqual(manifest[field], normalized[field]), 'workspace archive dependency declarations changed');
    }
    artifacts.push({ tarball: below(output, row.path), bytes, manifest, integrity: row.integrity });
  }
  return { artifacts, binding: { repository: expected.repository, commit: expected.commit, receipt: input.receipt,
    compositePhases: 1, buildAuthority: false }, sourceAdmission: false, releaseQualified: false, published: false };
}
module.exports = { readExternalNormalArtifact, readWorkspaceNormalArtifacts, verifyActualInputs };
