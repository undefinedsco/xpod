const fs = require('node:fs');
const path = require('node:path');
const ownership = require('./test-runner-ownership.json');
const testFileNames = require('./test-file-names.json');
const isTestFile = name => testFileNames.kinds.some(kind => testFileNames.extensions.some(extension => name.endsWith(`.${kind}.${extension}`)));
const vitestExcludedPaths = ownership.map(group => group.file ?? group.directory + '/**');
function collectModuleTests(root, selectedGroup) {
  if (selectedGroup && !ownership.some(g => g.gate === 'modules' && g.name === selectedGroup)) throw new Error('Unknown module test group');
  const result = { bun: [], node: [] }; const seen = new Set();
  const visit = (entry, files) => {
    for (const item of fs.readdirSync(entry, { withFileTypes: true })) {
      const file = path.join(entry, item.name);
      if (item.isSymbolicLink()) throw new Error('Test ownership source symlink');
      if (item.isDirectory()) visit(file, files);
      else if (isTestFile(item.name)) files.push(file);
    }
  };
  for (const group of ownership.filter(g => g.gate === 'modules' && (!selectedGroup || selectedGroup === g.name))) {
    const files = [];
    if (group.file) files.push(path.join(root, group.file));
    else visit(path.join(root, group.directory), files);
    if (!files.length) throw new Error('Owned module test group is empty: ' + group.name);
    for (const file of files) {
      if (seen.has(file)) throw new Error('Duplicate module test ownership'); seen.add(file);
      const text = fs.readFileSync(file, 'utf8');
      const bun = /from\s*['"]bun:test['"]/u.test(text);
      const node = /from\s*['"]node:test['"]/u.test(text);
      if (bun === node) throw new Error('Ambiguous or missing test runner: ' + file);
      result[bun ? 'bun' : 'node'].push(file);
    }
  }
  result.bun.sort(); result.node.sort(); return result;
}
module.exports = { testFileNames, isTestFile, ownership, vitestExcludedPaths, collectModuleTests };
