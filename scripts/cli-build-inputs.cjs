'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const CLI_ENTRIES = ['src', 'scripts', 'tests', 'licenses', 'tsconfig.json', 'tsconfig.core.json', 'tsconfig.client.json', 'tsconfig.build-tools.json', 'package.json', 'README.md', 'LICENSE'];
const CLIENT_ENTRIES = ['src', 'scripts', 'tests', 'licenses', 'tsconfig.json', 'package.json', 'README.md', 'LICENSE'];
function copyCliBuildInputs(root, source) {
  const files = [];
  function copy(relative) {
    fs.cpSync(path.join(root, relative), path.join(source, relative), { recursive: true });
    function visit(file) {
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) { for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name)); return; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('CLI input must be regular');
      files.push({ path: path.relative(root, file).split(path.sep).join('/'), bytes: stat.size,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
    }
    visit(path.join(root, relative));
  }
  for (const entry of CLI_ENTRIES) copy('packages/xpod-cli/' + entry);
  for (const entry of CLIENT_ENTRIES) copy('packages/xpod-client/' + entry);
  copy('types/bun'); copy('LICENSE');
  for (const relative of require(path.join(root, 'packages/xpod-cli/scripts/canonical-host-sources.json'))) {
    if (!/^[A-Za-z0-9/_-]+\.ts$/.test(relative) || relative.includes('..')) throw new Error('cli_host_source_invalid');
    copy('src/' + relative);
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}
module.exports = { copyCliBuildInputs, CLI_ENTRIES, CLIENT_ENTRIES };
