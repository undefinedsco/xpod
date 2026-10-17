const fs = require('node:fs');
const path = require('node:path');
const { isTestFile } = require('./test-runner-ownership.cjs');
const roots = ['tests', 'scripts', 'ui/src', 'src'];
const skipped = new Set(['node_modules', 'dist', 'build', '.git', '.test-data', '.worktrees', 'external']);
const bunImport = /\bfrom\s*['"]bun:test['"]|\brequire\s*\(\s*['"]bun:test['"]\s*\)/u;
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
        if (relative.startsWith('tests/bun/') || bunImport.test(fs.readFileSync(file, 'utf8'))) found.push(file);
      }
    }
  }
  for (const directory of roots) visit(path.join(root, directory));
  return found.sort();
}
module.exports = { collectBunOnlyTests };
