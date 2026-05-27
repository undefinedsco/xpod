#!/usr/bin/env node
/**
 * Post-install script to patch jose for Bun compatibility.
 * Changes jose's "bun" exports from dist/browser to dist/node/esm
 * to avoid the "non-extractable CryptoKey" issue.
 */

const fs = require('fs');
const path = require('path');

const nodeModulesPath = path.join(__dirname, '..', 'node_modules');

function findJosePackages(root) {
  const results = [];
  const queue = [root];
  const ignored = new Set(['.cache', '.vite']);

  while (queue.length > 0) {
    const current = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || ignored.has(entry.name)) {
        continue;
      }

      const entryPath = path.join(current, entry.name);
      if (entry.name === 'jose') {
        const packagePath = path.join(entryPath, 'package.json');
        if (fs.existsSync(packagePath)) {
          results.push(packagePath);
        }
        continue;
      }

      queue.push(entryPath);
    }
  }

  return results;
}

if (!fs.existsSync(nodeModulesPath)) {
  console.log('[patch-jose] node_modules not found, skipping');
  process.exit(0);
}

try {
  let patched = 0;
  let alreadyPatched = 0;
  let skipped = 0;

  for (const josePkgPath of findJosePackages(nodeModulesPath)) {
    let content = fs.readFileSync(josePkgPath, 'utf8');
    const original = content;
    const packageRoot = path.dirname(josePkgPath);
    const nodeEsmEntry = path.join(packageRoot, 'dist', 'node', 'esm', 'index.js');

    if (!fs.existsSync(nodeEsmEntry)) {
      skipped++;
      continue;
    }

    // Replace all bun exports from browser to node/esm.
    content = content.replace(/"bun": "\.\/dist\/browser\//g, '"bun": "./dist/node/esm/');

    if (content !== original) {
      fs.writeFileSync(josePkgPath, content);
      patched++;
    } else {
      alreadyPatched++;
    }
  }

  console.log(`[patch-jose] Patched ${patched} jose package(s); ${alreadyPatched} already patched; ${skipped} skipped`);
} catch (err) {
  console.error('[patch-jose] Failed to patch jose:', err.message);
  process.exit(1);
}
