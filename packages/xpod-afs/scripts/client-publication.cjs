const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const { normalizeWorkspaceDependencies } = require('../../../scripts/workspace-package-pack.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Pure completed-build stage. The caller owns the existing live verified scope.
function emitClientPublication({ packageRoot, repoRoot, destination, assertCurrent, limits = {} }) {
  if (typeof assertCurrent !== 'function') throw new Error('Live producer scope required');
  assertCurrent();
  const root = fs.realpathSync(packageRoot), target = path.resolve(destination);
  const parent = path.dirname(target);
  // Resolve every existing ancestor before stage creation; lexical prefix checks
  // alone allow a parent symlink to redirect writes into the source package.
  let ancestor = path.parse(parent).root;
  for (const segment of parent.slice(ancestor.length).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, segment);
    const stat = fs.lstatSync(ancestor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Stage ancestor must be a real directory');
  }
  const physicalParent = fs.realpathSync(parent);
  const physicalTarget = path.join(physicalParent, path.basename(target));
  if (physicalTarget === root || physicalTarget.startsWith(root + path.sep)) throw new Error('Fresh external stage required');
  try { fs.lstatSync(target); throw new Error('Fresh external stage required'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const parentIdentity = fs.lstatSync(parent);
  const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
  const verifyParent = () => {
    const current = fs.lstatSync(parent);
    if (current.isSymbolicLink() || !sameIdentity(current, parentIdentity) || fs.realpathSync(parent) !== physicalParent) throw new Error('Stage parent changed');
  };
  const budgets = { files: 4096, bytes: 32 * 1024 * 1024, fileBytes: 8 * 1024 * 1024, ...limits };
  for (const [key, value] of Object.entries(budgets)) if (!['files', 'bytes', 'fileBytes'].includes(key) || !Number.isSafeInteger(value) || value < 1 || value > ({ files: 4096, bytes: 32 * 1024 * 1024, fileBytes: 8 * 1024 * 1024 })[key]) throw new Error('Invalid stage budget');
  const safe = relative => {
    if (typeof relative !== 'string' || !relative || /[\\\x00-\x1f]/.test(relative) || path.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe publication path');
    return relative;
  };
  function read(relative, base = root) {
    safe(relative); let current = base;
    for (const part of relative.split('/')) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Publication symlink rejected'); }
    const stat = fs.statSync(current);
    if (!stat.isFile() || stat.size > budgets.fileBytes) throw new Error('Invalid publication file');
    const bytes = fs.readFileSync(current);
    if (bytes.length > budgets.fileBytes) throw new Error('Publication file budget exceeded');
    return bytes;
  }
  const original = read('package.json'), source = JSON.parse(original);
  if (source.name !== '@undefineds.co/xpod-afs' || source.private !== true) throw new Error('Private AFS source identity required');
  const normalized = normalizeWorkspaceDependencies(repoRoot, source);
  const manifest = {};
  for (const key of ['name', 'version', 'description', 'type', 'license', 'exports', 'main', 'types', 'typesVersions', 'engines', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'lsd:module', 'lsd:components', 'lsd:contexts', 'lsd:importPaths']) if (normalized[key] !== undefined) manifest[key] = normalized[key];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error('Exact AFS version required');
  manifest.private = false;
  manifest.files = ['dist', 'LICENSE', 'README.md', 'provenance'];
  const payload = new Map(); let total = 0;
  function add(relative, bytes) {
    safe(relative);
    if (payload.has(relative)) { if (!payload.get(relative).equals(bytes)) throw new Error('Duplicate publication destination'); return; }
    if (bytes.length > budgets.fileBytes || payload.size + 1 > budgets.files || total + bytes.length > budgets.bytes) throw new Error('Publication budget exceeded');
    if (/\.(?:node|so|dylib|dll|exe|wasm|a)$/i.test(relative) || (bytes.length >= 4 && ['7f454c46','cffaedfe','feedfacf','cafebabe','0061736d'].includes(bytes.subarray(0,4).toString('hex'))) || bytes.subarray(0,2).toString() === 'MZ') throw new Error('Native publication payload rejected');
    payload.set(relative, bytes);total += bytes.length;
  }
  // Notice collectors also preserve conventional extensionless legal documents.
  // Keep this classification inside the notice tree, separate from executable closure.
  const isNoticeDocument = relative => relative.startsWith('dist/licenses/') && /^(?:LICENSE|LICENCE|NOTICE|COPYING)$/i.test(path.posix.basename(relative));
  function include(relative) {
    relative = safe(relative.replace(/^\.\//, ''));
    if (payload.has(relative)) return;
    if (!relative.startsWith('dist/') || (!/\.(?:[cm]?js|d\.ts|jsonld|json|txt|md)$/.test(relative) && !isNoticeDocument(relative))) throw new Error('Unsupported generated payload');
    const bytes = read(relative);add(relative, bytes);
    if (/\.(?:[cm]?js|d\.ts)$/.test(relative)) {
      const syntax = ts.createSourceFile(relative, bytes.toString('utf8'), ts.ScriptTarget.Latest, true);
      const refs = [];
      const visit = node => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) refs.push(node.moduleSpecifier.text);
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments.length && ts.isStringLiteral(node.arguments[0])) refs.push(node.arguments[0].text);
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) refs.push(node.argument.literal.text);
        ts.forEachChild(node, visit);
      };visit(syntax);
      for (const ref of refs) {
        if (!ref.startsWith('.')) continue;
        if (/[?#\\]/.test(ref)) throw new Error('Unsupported generated reference');
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), ref));safe(resolved);
        const choices = relative.endsWith('.d.ts') ? [resolved.replace(/\.[cm]?js$/, '.d.ts'), resolved, resolved + '.d.ts', resolved + '/index.d.ts'] : [resolved];
        const found = choices.find(item => fs.existsSync(path.join(root, item)));
        if (!found) throw new Error('Missing generated reference: ' + ref);
        include(found);
      }
    }
    if (relative.endsWith('.jsonld')) {
      const walk = value => {
        if (typeof value === 'string') {
          // JSON-LD resource fragments identify terms within a document; they
          // are not part of the generated document's filesystem filename.
          const document = value.split('#', 1)[0];
          if (document.startsWith('./') || document.startsWith('../')) include(path.posix.normalize(path.posix.join(path.posix.dirname(relative), document)));
          else if (/^[A-Za-z][A-Za-z0-9]*:dist\//.test(document)) include(document.slice(document.indexOf(':') + 1));
        } else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item);
      };walk(JSON.parse(bytes));
    }
  }
  function targets(value) {
    if (typeof value === 'string') {
      if (value === './package.json') return;
      if (!value.startsWith('./dist/')) throw new Error('Unsafe export target');
      include(value);
    } else if (value && typeof value === 'object') for (const item of Object.values(value)) targets(item);
  }
  targets(manifest.exports);targets(manifest.main);targets(manifest.types);
  // moduleLauncher reaches this by a constructed path, outside manifest exports.
  include('dist/entry.mjs'); include('dist/runtime.mjs'); include('dist/library.cjs');
  let visited = 0;
  function subtree(relative, accept) {
    if (++visited > 16384) throw new Error('Publication directory budget exceeded');
    safe(relative);
    const absolute = path.join(root, relative), stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('Publication symlink rejected');
    if (stat.isDirectory()) for (const name of fs.readdirSync(absolute).sort()) subtree(relative + '/' + name, accept);
    else if (accept(relative)) include(relative);
    else throw new Error('Unexpected contract payload: ' + relative);
  }
  subtree('dist/types', name => /\.(?:d\.ts|jsonld)$/.test(name));
  subtree('dist/components', name => /\.jsonld$/.test(name));
  subtree('dist/licenses', name => /\.(?:json|txt|md)$/.test(name) || isNoticeDocument(name));
  for (const relative of Object.values(manifest['lsd:contexts'] || {})) include(relative);
  if (manifest['lsd:components']) include(manifest['lsd:components']);
  const typeTargets = value => {
    if (typeof value === 'string') {
      if (!value.startsWith('dist/types/') || value.includes('..') || /[\\?#]/.test(value)) throw new Error('Unsafe type target');
      if (value.includes('*')) {
        const prefix = value.slice(0, value.indexOf('*'));
        if (!value.endsWith('*') || value.indexOf('*') !== value.length - 1 || ![...payload.keys()].some(name => name.startsWith(prefix))) throw new Error('Unsupported type wildcard');
      } else include(value);
    } else if (value && typeof value === 'object') for (const item of Object.values(value)) typeTargets(item);
  };typeTargets(manifest.typesVersions);
  for (const [name, bytes] of payload) if (name.startsWith('dist/licenses/') && name.endsWith('.json')) {
    const walk = value => {
      if (value && typeof value === 'object') {
        if (typeof value.object === 'string') {
          const object = safe(path.posix.normalize(path.posix.join(path.posix.dirname(name), value.object)));
          if (!object.startsWith('dist/licenses/')) throw new Error('Unsafe notice object');
          const content = payload.get(object);if (!content || (value.sha256 && sha(content) !== value.sha256)) throw new Error('Missing or changed notice object');
        }
        for (const item of Object.values(value)) walk(item);
      }
    };walk(JSON.parse(bytes));
  }
  add('README.md', read('README.md'));add('LICENSE', read('LICENSE', fs.realpathSync(repoRoot)));
  add('provenance/source-package.json', original);
  add('package.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  if (!read('package.json').equals(original)) throw new Error('Source manifest changed');
  assertCurrent();
  verifyParent();
  fs.mkdirSync(target, { recursive: false });
  const stageIdentity = fs.lstatSync(target);
  const verifyOwned = () => {
    verifyParent();const current = fs.lstatSync(target);
    if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(current, stageIdentity)) throw new Error('Owned stage changed');
  };
  try {
    for (const [name, bytes] of payload) { verifyOwned(); const file = path.join(target, name);fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o644 }); }
    assertCurrent();verifyOwned();
    if (!read('package.json').equals(original)) throw new Error('Source manifest changed');
  } catch (error) {
    try { verifyOwned();fs.rmSync(target, { recursive: true, force: true }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Publication failed; stage ownership prevents cleanup'); }
    throw error;
  }
  return { kind: 'afs-js-publication-stage', manifest, sourceManifestSHA256: sha(original),
    inventory: [...payload].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha(bytes), mode: 0o644 })).sort((a,b) => a.path.localeCompare(b.path)),
    buildQualified: false, consumerQualified: false, sourceQualified: false, releaseQualified: false };
}
module.exports = { emitClientPublication };
