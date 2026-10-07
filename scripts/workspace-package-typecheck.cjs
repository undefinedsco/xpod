#!/usr/bin/env node
const path = require('node:path');
const { createRequire } = require('node:module');

function check(directory, names) {
  const ts = createRequire(path.join(directory, 'consumer.ts'))('typescript');
  const program = ts.createProgram([path.join(directory, 'consumer.ts')], {
    noEmit: true,
    types: [],
    skipLibCheck: false,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
  });
  const external = new Map();
  const failures = ts.getPreEmitDiagnostics(program).filter((diagnostic) => {
    const filename = diagnostic.file?.fileName;
    if (!filename || !filename.includes('/node_modules/')) return true;
    const packageName = filename.split('/node_modules/').pop().split('/').slice(0, filename.split('/node_modules/').pop().startsWith('@') ? 2 : 1).join('/');
    if (names.includes(packageName)) return true;
    external.set(packageName, (external.get(packageName) || 0) + 1);
    return false;
  });
  if (external.size) console.log('Existing external declaration diagnostics (excluded by package path):', JSON.stringify(Object.fromEntries(external)));
  if (failures.length) {
    const host = { getCanonicalFileName: (file) => file, getCurrentDirectory: () => directory, getNewLine: () => '\n' };
    throw new Error(ts.formatDiagnostics(failures, host));
  }
  console.log(`NodeNext declarations verified for consumer and ${names.length} packed packages`);
}
module.exports = { check };
if (require.main === module) {
  try { check(process.argv[2], JSON.parse(process.argv[3])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
