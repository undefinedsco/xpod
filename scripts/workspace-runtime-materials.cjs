'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function command(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}
function lstatOnly(filename) { try { return fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function regular(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Nonregular source material');
  return fs.readFileSync(filename);
}
function sources(packageRoot) {
  const names = ['package.json', 'README.md', 'LICENSE', ...fs.readdirSync(packageRoot).filter(name => /^tsconfig.*\.json$/.test(name))];
  for (const directory of ['src', 'scripts']) {
    const absolute = path.join(packageRoot, directory);
    if (!fs.existsSync(absolute)) continue;
    const walk = filename => {
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink()) throw new Error('Source material symlink');
      if (stat.isDirectory()) for (const name of fs.readdirSync(filename).sort()) walk(path.join(filename, name));
      else if (stat.isFile()) names.push(path.relative(packageRoot, filename).split(path.sep).join('/'));
      else throw new Error('Nonregular source material');
    };
    walk(absolute);
  }
  return names.sort().map(name => ({ path: name, bytes: regular(path.join(packageRoot, name)) }));
}
function chooseGeneratedProfile(directory, payload) {
  const bytes = regular(payload);
  const boundary = bytes.subarray(0, 3).toString() === '// ' ? 0 : bytes.indexOf('\n// ');
  if (boundary < 0) throw new Error('Generated prefix boundary missing');
  const prefix = bytes.subarray(0, boundary);
  const index = JSON.parse(regular(path.join(directory, 'index.json')));
  if (prefix.length > 0 && prefix.length === index.prefixBytes && hash(prefix) === index.prefixSha256) return undefined;
  for (const name of ['core', 'client', 'build-tools-cjs', 'build-tools-esm', 'output-esm']) {
    const filename = path.join(directory, name + '.json');
    if (!fs.existsSync(filename)) continue;
    const profile = JSON.parse(regular(filename));
    if (profile.bunVersion === index.bunVersion && prefix.length === profile.prefixBytes && hash(prefix) === profile.prefixSha256) return name;
  }
  throw new Error('Actual generated prefix has no admitted original-source profile');
}
function normalizeGeneratedNode(ts, node) {
    if (!node) return null;
    if (ts.isParenthesizedExpression(node)) return normalizeGeneratedNode(ts, node.expression);
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return [node.kind, node.text];
    const children = []; ts.forEachChild(node, child => { if (child.kind !== ts.SyntaxKind.ExportKeyword) children.push(normalizeGeneratedNode(ts, child)); });
    return [node.kind, ts.isVariableDeclarationList(node) ? node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const) : null, children.length ? children : node.getText()];
}

function deriveGeneratedIndex(originalDirectory, payload, destination) {
  const ts = require('typescript');
  const original = JSON.parse(regular(path.join(originalDirectory, 'index.json')));
  for (const row of original.files ?? []) {
    if (!/^[a-f0-9]{64}$/.test(row.sha256) || row.object !== `objects/${row.sha256}.txt` || hash(regular(path.join(originalDirectory, row.object))) !== row.sha256) throw new Error('Original generated source hash mismatch');
  }
  const runtime = original.files.find(row => row.sourcePath === 'src/runtime.js');
  if (!runtime) throw new Error('Official Bun runtime source missing');
  const source = ts.createSourceFile('runtime.js', regular(path.join(originalDirectory, runtime.object)).toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const bytes = regular(payload); const boundary = bytes.subarray(0, 3).toString() === '// ' ? 0 : bytes.indexOf('\n// ');
  if (boundary <= 0) throw new Error('Ordinary CJS generated prefix must be nonempty');
  const prefix = bytes.subarray(0, boundary);
  const actual = ts.createSourceFile('prefix.js', prefix.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length || actual.parseDiagnostics.length) throw new Error('Generated source parse failed');
  const declarations = file => {
    const values = new Map();
    for (const statement of file.statements) {
      if (ts.isVariableStatement(statement)) for (const node of statement.declarationList.declarations) { if (!ts.isIdentifier(node.name) || values.has(node.name.text)) throw new Error('Ambiguous helper declaration'); values.set(node.name.text, { declarationKind: statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const), initializer: node.initializer }); }
      else if (ts.isFunctionDeclaration(statement) && statement.name) { if (values.has(statement.name.text)) throw new Error('Ambiguous helper declaration'); values.set(statement.name.text, { declarationKind: 'function', initializer: statement }); }
      else if (file === actual) throw new Error('Unaudited generated statement');
    }
    return values;
  };
  const normalized = node => normalizeGeneratedNode(ts, node);
  const authorities = [{ label: 'official-runtime', sha256: runtime.sha256, values: declarations(source) }];
  const audited = original.files.find(row => row.sourcePath === 'generated-prefix.js');
  if (!audited || audited.sha256 !== original.prefixSha256 || regular(path.join(originalDirectory, audited.object)).length !== original.prefixBytes
    || !/^[a-f0-9]{40}$/.test(original.provenance?.bunCommit ?? '')) throw new Error('Audited generated authority missing');
  const addAudited = (label, row) => {
    const file = ts.createSourceFile(label + '.js', regular(path.join(originalDirectory, row.object)).toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (file.parseDiagnostics.length) throw new Error('Audited prefix parse failed');
    authorities.push({ label, sha256: row.sha256, values: declarations(file) });
  };
  addAudited('index', audited);
  const profileAuthorities = []; const profileFiles = [];
  for (const name of ['core', 'client', 'build-tools-cjs']) {
    const filename = path.join(originalDirectory, name + '.json');
    if (!fs.existsSync(filename)) continue;
    const profile = JSON.parse(regular(filename)); const row = profile.file;
    if (profile.schemaVersion !== 1 || profile.bunVersion !== original.bunVersion || profile.provenance?.basePrefixSha256 !== original.prefixSha256
      || row?.sourcePath !== 'generated-prefix.js' || row.object !== `objects/${row.sha256}.txt` || row.sha256 !== profile.prefixSha256
      || hash(regular(path.join(originalDirectory, row.object))) !== row.sha256 || regular(path.join(originalDirectory, row.object)).length !== profile.prefixBytes) continue;
    addAudited(name, row);
    if (typeof profile.provenance.derivation !== 'string' || !profile.provenance.derivation) throw new Error('Audited profile provenance missing');
    profileFiles.push({ ...row, sourcePath: `audited/${name}-prefix.js` });
    profileAuthorities.push({ name, profileSHA256: hash(regular(filename)), prefixSHA256: row.sha256, basePrefixSHA256: profile.provenance.basePrefixSha256, derivation: profile.provenance.derivation });
  }
  const emitted = declarations(actual); const helperAuthorities = [];
  if (!emitted.size) throw new Error('Empty generated helpers');
  for (const [name, initializer] of emitted) {
    const authority = authorities.find(row => row.values.has(name) && initializer.declarationKind === row.values.get(name).declarationKind && JSON.stringify(normalized(initializer.initializer)) === JSON.stringify(normalized(row.values.get(name).initializer)));
    if (!authority) throw new Error(`Generated helper differs from admitted source: ${name}`);
    helperAuthorities.push({ name, authority: authority.label, sourceSHA256: authority.sha256 });
  }
  fs.mkdirSync(path.join(destination, 'objects'), { recursive: true });
  const files = original.files.filter(row => row.sourcePath !== 'generated-prefix.js');
  files.push({ ...audited, sourcePath: 'audited/generated-prefix.js' });
  files.push(...profileFiles);
  for (const row of files) if (!fs.existsSync(path.join(destination, row.object))) fs.copyFileSync(path.join(originalDirectory, row.object), path.join(destination, row.object), fs.constants.COPYFILE_EXCL);
  const digest = hash(prefix); const object = `objects/${digest}.txt`;
  if (!fs.existsSync(path.join(destination, object))) fs.writeFileSync(path.join(destination, object), prefix, { flag: 'wx' });
  files.push({ sourcePath: 'generated-prefix.js', object, sha256: digest, provenance: { role: 'Actual CJS prefix checked helper by helper against pinned runtime or existing audited generated-prefix objects' } });
  fs.writeFileSync(path.join(destination, 'index.json'), JSON.stringify({ ...original, prefixBytes: prefix.length, prefixSha256: digest,
    provenance: { ...original.provenance, derivation: { runtimeSHA256: runtime.sha256, algorithmVersion: 'helper-ast-v2', helperAuthorities, profileAuthorities, comparison: 'Actual helper AST equals pinned original runtime or existing audited generated-prefix helper; export modifiers and redundant parentheses excluded, no block/control-flow normalization' } }, files }, null, 2) + '\n', { flag: 'wx' });
}
// Physical tool/material roots are independent of Git source authority. Docker
// and rebuilt published packages have usable originals without a .git directory.
function buildMaterialRoots(toolPath, packageRoot, gitRoot) {
  const resolved = fs.realpathSync(toolPath);
  let cliRoot = null, dependencyRoot = null;
  for (let current = path.dirname(resolved), depth = 0; depth < 16; depth++) {
    const manifest = path.join(current, 'package.json');
    if (!cliRoot && fs.existsSync(manifest) && JSON.parse(regular(manifest)).name === '@undefineds.co/xpod-cli') cliRoot = current;
    if (!dependencyRoot && path.basename(current) === 'node_modules') dependencyRoot = path.dirname(current);
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  let workspaceRoot = null;
  if (cliRoot && path.basename(path.dirname(cliRoot)) === 'packages') {
    const candidate = path.dirname(path.dirname(cliRoot)), manifest = path.join(candidate, 'package.json');
    if (fs.existsSync(manifest)) {
      const declaration = JSON.parse(regular(manifest));
      if (declaration.name === '@undefineds.co/xpod' && Array.isArray(declaration.workspaces) && declaration.workspaces.includes('packages/*')) workspaceRoot = candidate;
    }
  }
  return { cliRoot, noticesRoot: gitRoot ?? workspaceRoot ?? dependencyRoot ?? packageRoot };
}
async function collectWorkspaceRuntimeMaterials(options) {
  const root = fs.realpathSync(options.packageRoot);
  const repo = command(root, ['rev-parse', '--show-toplevel']);
  const helper = __filename;
  const items = sources(root);
  items.push({ path: 'build-tools/workspace-runtime-materials.cjs', bytes: regular(helper), source: helper });
  const files = items.map(item => ({ path: item.path, bytes: item.bytes.length, sha256: hash(item.bytes),
    tracked: command(root, ['ls-files', '--error-unmatch', '--', item.source ?? path.join(root, item.path)]) !== null }));
  const scope = ['src', 'scripts', 'package.json', 'README.md', 'LICENSE', ':(glob)tsconfig*.json', helper];
  const trackedPaths = command(root, ['ls-files', '--full-name', '-z', '--', ...scope]);
  const actualPaths = new Set(items.map(item => repo ? path.relative(repo, item.source ?? path.join(root, item.path)).split(path.sep).join('/') : ''));
  const missingTracked = trackedPaths === null ? [] : trackedPaths.split('\0').filter(Boolean).filter(name => !actualPaths.has(name));
  const tracked = files.every(file => file.tracked) && trackedPaths !== null && missingTracked.length === 0;
  const head = command(root, ['rev-parse', 'HEAD']);
  const status = command(root, ['status', '--porcelain', '--untracked-files=all', '--', ...scope]);
  const sourceAuthority = { sourceCommit: tracked && /^[a-f0-9]{40}$/.test(head ?? '') ? head : null,
    tracked, dirty: status === null ? null : Boolean(status), snapshotSHA256: hash(JSON.stringify(files)),
    missingTrackedSourceCount: missingTracked.length,
    scope: 'canonical package source and actual shared material collector' };
  const dist = path.join(root, 'dist');
  if (lstatOnly(dist) && (!lstatOnly(dist).isDirectory() || lstatOnly(dist).isSymbolicLink())) throw new Error('Unsafe material parent');
  const destination = path.join(root, 'dist/materials');
  if (lstatOnly(destination)) throw new Error('Material destination already exists');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const stage = fs.mkdtempSync(path.join(root, 'dist/.materials-'));
  try {
    for (const item of items) {
      const target = path.join(stage, 'source', item.path);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, item.bytes, { flag: 'wx' });
    }
    fs.writeFileSync(path.join(stage, 'source-inventory.json'), JSON.stringify({ schemaVersion: 1, sourceAuthority, files }, null, 2) + '\n', { flag: 'wx' });
    const bundleFacts = [];
    let compiler = null;
    if (options.bundles?.length) {
      const toolPath = options.buildTools ?? createRequire(path.join(root, 'package.json')).resolve('@undefineds.co/xpod-cli/build-tools');
      const tools = await import(pathToFileURL(toolPath).href);
      const materialRoots = buildMaterialRoots(toolPath, root, repo);
      const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' });
      if (bun.status !== 0) throw new Error('Actual Bun compiler unavailable');
      const version = bun.stdout.trim();
      const executable = spawnSync('bun', ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' });
      const revision = spawnSync('bun', ['--revision'], { encoding: 'utf8' });
      if (executable.status !== 0 || revision.status !== 0) throw new Error('Actual compiler identity unavailable');
      compiler = { version, revision: revision.stdout.trim(), executableSHA256: hash(regular(executable.stdout)), platform: `${process.platform}-${process.arch}` };
      if (options.generated === undefined && !materialRoots.cliRoot) throw new Error('Actual CLI build-tool package originals unavailable');
      const generated = options.generated ?? path.join(materialRoots.cliRoot, 'licenses/javascript/generated', version);
      for (const bundle of options.bundles) {
        if (!/^[a-z][a-z0-9-]*$/.test(bundle.name)) throw new Error('Unsafe bundle material name');
        const payload = path.join(root, bundle.payload); const metafile = path.join(root, bundle.metafile);
        const rawMetadata = regular(metafile);
        const rawDirectory = path.join(root, '.test-data/build');
        fs.mkdirSync(rawDirectory, { recursive: true });
        fs.writeFileSync(path.join(rawDirectory, bundle.name + '-inputs.raw.json'), rawMetadata);
        fs.writeFileSync(metafile, tools.canonicalBuildMetafile(rawMetadata));
        let selectedGenerated = generated; let profile;
        try { profile = chooseGeneratedProfile(generated, payload); } catch (error) {
          if (error.message !== 'Actual generated prefix has no admitted original-source profile') throw error;
          selectedGenerated = path.join(stage, 'generated', bundle.name);
          deriveGeneratedIndex(generated, payload, selectedGenerated);
        }
        bundleFacts.push({ name: bundle.name, payload: bundle.payload, payloadSHA256: hash(regular(payload)), metafile: bundle.metafile, metafileSHA256: hash(regular(metafile)), generatedProfile: profile ?? 'index' });
        tools.collectJavascriptNotices({ stageRoot: root, repoRoot: materialRoots.noticesRoot, metafile,
          destination: path.join(stage, 'javascript', bundle.name), target: `${process.platform}-${process.arch}`,
          cli: payload, bunVersion: version, generated: selectedGenerated, ...(profile ? { generatedProfile: profile } : {}) });
      }
    }
    fs.writeFileSync(path.join(stage, 'build-provenance.json'), JSON.stringify({ schemaVersion: 1, sourceAuthority, compiler, bundles: bundleFacts }, null, 2) + '\n', { flag: 'wx' });
    const materialFiles = [];
    const inventory = directory => { for (const name of fs.readdirSync(directory).sort()) { const filename = path.join(directory, name); const stat = fs.lstatSync(filename); if (stat.isDirectory()) inventory(filename); else { const bytes = regular(filename); materialFiles.push({ path: path.relative(stage, filename).split(path.sep).join('/'), bytes: bytes.length, sha256: hash(bytes) }); } } };
    inventory(stage);
    fs.writeFileSync(path.join(stage, 'index.json'), JSON.stringify({ schemaVersion: 1, sourceAuthority, files: materialFiles }, null, 2) + '\n', { flag: 'wx' });
    for (const bundle of bundleFacts) if (hash(regular(path.join(root, bundle.payload))) !== bundle.payloadSHA256 || hash(regular(path.join(root, bundle.metafile))) !== bundle.metafileSHA256) throw new Error('Built payload changed during material collection');
    for (const item of items) if (hash(regular(item.source ?? path.join(root, item.path))) !== hash(item.bytes)) throw new Error('Source changed during material collection');
    if (command(root, ['rev-parse', 'HEAD']) !== head || command(root, ['status', '--porcelain', '--untracked-files=all', '--', ...scope]) !== status) throw new Error('Git authority changed during collection');
    fs.renameSync(stage, destination);
    return sourceAuthority;
  } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true }); }
}
module.exports = { collectWorkspaceRuntimeMaterials, chooseGeneratedProfile, deriveGeneratedIndex, normalizeGeneratedNode };
if (require.main === module) collectWorkspaceRuntimeMaterials({ packageRoot: process.argv[2] ?? process.cwd(),
  bundles: JSON.parse(process.argv[3] ?? '[]') }).catch(error => { console.error(error.message); process.exitCode = 1; });
