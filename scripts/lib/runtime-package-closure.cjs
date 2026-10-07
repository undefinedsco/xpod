'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');
const esbuild = require('esbuild');
const ts = require('typescript');

function resolveInstalledPackage(name, from) {
  for (let current = from; ; current = path.dirname(current)) {
    const candidate = path.join(current, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (current === path.dirname(current)) break;
  }
  throw new Error(`Required runtime package is missing: ${name}`);
}

// Preserve ESM exports, import.meta-relative assets, and dependency versions.
// These packages are loaded lazily and cannot be discovered from Components.js.
async function stageRuntimePackageClosure(name, sourceRoot, stageRoot) {
  const staged = new Map();
  const packages = [];
  function stage(packageName, sourceParent, stageParent) {
    const source = resolveInstalledPackage(packageName, sourceParent);
    let target;
    for (let current = stageParent; ; current = path.dirname(current)) {
      const candidate = path.join(current, 'node_modules', packageName);
      if (staged.has(candidate)) {
        if (staged.get(candidate) === source) return candidate;
        break;
      }
      if (current === stageRoot || current === path.dirname(current)) break;
    }
    const hoisted = path.join(stageRoot, 'node_modules', packageName);
    target = staged.has(hoisted) && staged.get(hoisted) !== source
      ? path.join(stageParent, 'node_modules', packageName) : hoisted;
    if (staged.get(target) === source) return target;
    staged.set(target, source);
    fs.cpSync(source, target, { recursive: true, dereference: true, filter(file) {
      const relative = path.relative(source, file);
      if (!relative) return true;
      const parts = relative.split(path.sep);
      const excluded = ['node_modules', '.git', 'test', 'tests'];
      if (packageName !== name) excluded.push('docs', 'examples');
      return !parts.some(part => excluded.includes(part))
        && !relative.endsWith('.map') && !relative.endsWith('.d.ts');
    } });
    const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    packages.push({ name: metadata.name, version: metadata.version, path: path.relative(stageRoot, target) });
    for (const dependency of Object.keys(metadata.dependencies || {})) stage(dependency, source, target);
    return target;
  }
  stage(name, sourceRoot, stageRoot);
  const builtins = new Set(builtinModules.flatMap(value => [value, `node:${value}`]));
  const destinationFor = source => {
    const match = [...staged].sort((a, b) => b[1].length - a[1].length).find(([, directory]) => source === directory || source.startsWith(directory + path.sep));
    return match && path.join(match[0], path.relative(match[1], source));
  };
  await esbuild.build({ stdin: { contents: '', resolveDir: sourceRoot }, write: false, platform: 'node',
    plugins: [{ name: 'extracted-runtime-imports', setup(build) {
      build.onStart(async () => {
        for (const [target, source] of staged) {
          const pending = [target];
          while (pending.length) {
            const directory = pending.pop();
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
              const file = path.join(directory, entry.name);
              if (entry.isDirectory()) {
                if (!['node_modules', 'docs', 'examples'].includes(entry.name)) pending.push(file);
                continue;
              }
              if (!/\.(?:c|m)?js$/.test(entry.name)) continue;
              const original = fs.readFileSync(file, 'utf8');
              const syntax = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
              const literals = [];
              function visit(node) {
                if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
                  && ts.isStringLiteral(node.moduleSpecifier)) literals.push([node.moduleSpecifier, 'import-statement']);
                if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
                  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) literals.push([node.arguments[0], 'dynamic-import']);
                  if (ts.isIdentifier(node.expression) && node.expression.text === 'require') literals.push([node.arguments[0], 'require-call']);
                }
                ts.forEachChild(node, visit);
              }
              visit(syntax);
              const edits = [];
              for (const [literal, kind] of literals) {
                const specifier = literal.text;
                if (specifier.startsWith('.') || path.isAbsolute(specifier) || builtins.has(specifier)) continue;
                const sourceFile = path.join(source, path.relative(target, file));
                const resolved = await build.resolve(specifier, { resolveDir: path.dirname(sourceFile), kind });
                let destination;
                if (!resolved.external && resolved.path && fs.existsSync(resolved.path)) {
                  const resolvedFile = fs.realpathSync(resolved.path);
                  destination = destinationFor(resolvedFile);
                  if (!destination) {
                    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
                    if (!packages.some(entry => entry.name === name)) continue;
                    stage(name, path.dirname(sourceFile), target);
                    destination = destinationFor(resolvedFile);
                  }
                }
                // Optional imports retain the package's own unavailable-feature handling.
                if (!destination) continue;
                let relative = path.relative(path.dirname(file), destination).split(path.sep).join('/');
                if (!relative.startsWith('.')) relative = './' + relative;
                edits.push({ start: literal.getStart(syntax), end: literal.end, value: JSON.stringify(relative) });
              }
              let rewritten = original;
              for (const edit of edits.sort((a, b) => b.start - a.start)) rewritten = rewritten.slice(0, edit.start) + edit.value + rewritten.slice(edit.end);
              if (rewritten !== original) fs.writeFileSync(file, rewritten);
            }
          }
        }
      });
    } }], logLevel: 'silent' });
  return packages;
}

module.exports = { stageRuntimePackageClosure };
