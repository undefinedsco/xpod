#!/usr/bin/env node
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');

function checkRuntimeIdentity(lockPath, runtimeRoot) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(join(runtimeRoot, 'manifest.json'), 'utf8'));
  for (const key of ['repository', 'commit', 'patchSeriesSha256']) {
    if (typeof lock[key] !== 'string' || !lock[key] || manifest.qlever?.[key] !== lock[key]) {
      throw new Error(`QLever runtime ${key} does not match the current source lock; rebuild the native runtime first.`);
    }
  }
  const binaryPath = 'bin/xpod_qlever_local_runtime';
  const binary = readFileSync(join(runtimeRoot, binaryPath));
  const recorded = manifest.artifacts?.find((entry) => entry.path === binaryPath);
  if (!recorded || recorded.size !== binary.length ||
      recorded.sha256 !== createHash('sha256').update(binary).digest('hex')) {
    throw new Error('QLever runtime binary does not match its manifest.');
  }
}

module.exports = { checkRuntimeIdentity };

if (require.main === module) {
  const [lockPath, runtimeRoot] = process.argv.slice(2);
  if (!lockPath || !runtimeRoot) {
    throw new Error('Usage: check-qlever-runtime-identity.cjs <lock.json> <runtime-root>');
  }
  checkRuntimeIdentity(lockPath, runtimeRoot);
  console.log('QLever runtime source identity and binary digest verified.');
}
