const fs = require('node:fs');
const path = require('node:path');

function writeBunEntry(directory) {
  const source = fs.readFileSync(path.join(directory, 'index.js'), 'utf8');
  const sessionExport = /^export \* from '\.\/session\.js';$/gm;
  if ([...source.matchAll(sessionExport)].length !== 1) {
    throw new Error('Bun SDK entry requires exactly one session reexport');
  }
  if (!fs.statSync(path.join(directory, 'session.cjs')).isFile()) {
    throw new Error('Bun SDK entry requires the compiled session.cjs');
  }
  // Only the Inrupt boundary needs synchronous CJS loading in Bun. Reuse the
  // other ESM modules so root/subpath React contexts and stores stay identical.
  fs.writeFileSync(path.join(directory, 'index.bun.js'),
    source.replace(sessionExport, "export * from './session.cjs';"));
}

module.exports = { writeBunEntry };
if (require.main === module) writeBunEntry(path.resolve(__dirname, '../dist'));
