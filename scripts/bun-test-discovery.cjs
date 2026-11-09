const fs = require('node:fs');
const path = require('node:path');
const { isTestFile } = require('./test-runner-ownership.cjs');
const roots = ['tests', 'scripts', 'ui/src', 'src'];
const skipped = new Set(['node_modules', 'dist', 'build', '.git', '.test-data', '.worktrees', 'external']);
function importsBunTest(file) {
  const text = fs.readFileSync(file, 'utf8');
  // The install-free bootstrap already has Bun's parser. Node/Vitest uses its
  // installed TypeScript parser; neither path matches comments or strings.
  if (globalThis.Bun) {
    const loader = /\.[cm]?tsx?$/.test(file) ? (file.endsWith('.tsx') ? 'tsx' : 'ts') : (file.endsWith('.jsx') ? 'jsx' : 'js');
    return new Bun.Transpiler({ loader }).scanImports(text).some(reference => reference.path === 'bun:test');
  }
  return require('typescript').preProcessFile(text, true, true).importedFiles.some(reference => reference.fileName === 'bun:test');
}
/** Shared by Vitest exclusions and the actual Bun gate; package tests have their own owners. */
function collectBunOnlyTests(root) {
  const found = [];
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || skipped.has(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && isTestFile(entry.name)) {
        const relative = path.relative(root, file).split(path.sep).join('/');
        if (relative.startsWith('tests/bun/') || importsBunTest(file)) found.push(file);
      }
    }
  }
  for (const directory of roots) visit(path.join(root, directory));
  return found.sort();
}
module.exports = { collectBunOnlyTests };
