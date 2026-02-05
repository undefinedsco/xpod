#!/usr/bin/env node
/**
 * Post-install script to patch jose for Bun compatibility.
 * Changes jose's "bun" exports from dist/browser to dist/node/esm
 * to avoid the "non-extractable CryptoKey" issue.
 */

const fs = require('fs');
const path = require('path');

const josePkgPath = path.join(__dirname, '..', 'node_modules', 'jose', 'package.json');

if (!fs.existsSync(josePkgPath)) {
  console.log('[patch-jose] jose not found, skipping');
  process.exit(0);
}

try {
  let content = fs.readFileSync(josePkgPath, 'utf8');
  const original = content;

  // Replace all bun exports from browser to node/esm
  content = content.replace(/"bun": "\.\/dist\/browser\//g, '"bun": "./dist/node/esm/');

  if (content !== original) {
    fs.writeFileSync(josePkgPath, content);
    console.log('[patch-jose] Patched jose exports for Bun compatibility');
  } else {
    console.log('[patch-jose] jose already patched');
  }
} catch (err) {
  console.error('[patch-jose] Failed to patch jose:', err.message);
  process.exit(1);
}
