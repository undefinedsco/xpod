'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

/** Resolve public names with Node, including physical members of export patterns. */
function collectStagedPublicSpecifiers(stageRoot, names) {
  const root = fs.realpathSync(stageRoot);
  const resolver = createRequire(path.join(root, 'package.json'));
  const result = {};
  for (const name of names) {
    const packageRoot = path.join(root, 'node_modules', name);
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const exported = manifest.exports;
    const keys = exported && Object.keys(exported).some((key) => key.startsWith('.')) ? Object.keys(exported) : ['.'];
    const members = new Set();
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules') walk(file);
        else if (entry.isFile()) members.add('./' + path.relative(packageRoot, file).split(path.sep).join('/'));
      }
    };
    if (keys.some((key) => key.includes('*'))) walk(packageRoot);
    const expand = (key) => {
      if (!key.includes('*')) return [key];
      const candidates = new Set();
      const visit = (target) => {
        if (typeof target === 'string' && target.includes('*')) {
          const [prefix, suffix] = target.split('*');
          for (const member of members) {
            if (member.startsWith(prefix) && member.endsWith(suffix)) {
              const matched = member.slice(prefix.length, suffix ? -suffix.length : undefined);
              if (matched) candidates.add(key.replaceAll('*', matched));
            }
          }
        } else if (target && typeof target === 'object') Object.values(target).forEach(visit);
      };
      visit(exported[key]);
      return [...candidates];
    };
    for (const key of keys.flatMap(expand)) {
      const specifier = name + (key === '.' ? '' : key.slice(1));
      let file;
      try { file = resolver.resolve(specifier); }
      catch (error) {
        // Node's own exports authority excludes browser-only subpaths from
        // this CommonJS host. A selected export with missing bytes still fails.
        if (error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') continue;
        throw error;
      }
      if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) throw new Error(`Missing staged public export: ${specifier}`);
      result[specifier] = path.relative(root, file).split(path.sep).join('/');
    }
  }
  return result;
}

module.exports = { collectStagedPublicSpecifiers };
