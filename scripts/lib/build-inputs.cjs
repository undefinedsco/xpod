'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function hashTree(root, accept = () => true) {
  const result = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name); const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (/^(node_modules|\.git|\.test-data|\.xpod)$/.test(entry.name) || /^(logs|local|data)(\/|$)/.test(relative) || /(^|\/)\.env(?:\.|$)/.test(relative)) continue;
      if (entry.isSymbolicLink()) { if (accept(relative)) result.push([relative, 'symlink', fs.readlinkSync(absolute)]); continue; }
      if (entry.isDirectory()) { if (!/^(dist|release|runtime)(\/|$)/.test(relative)) walk(absolute); }
      else if (accept(relative)) result.push([relative, fs.statSync(absolute).mode & 0o777, digest(fs.readFileSync(absolute))]);
    }
  };
  walk(root); return result;
}
module.exports = { digest, hashTree };
