#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { digest } = require('./lib/build-inputs.cjs');
function inventory(directory) {
  return fs.readdirSync(directory).filter(file => /\.(dmg|zip|blockmap)$/.test(file) || file === 'latest-mac.yml').sort().map(file => {
    const absolute = path.join(directory, file); const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error('desktop_artifact_invalid_file');
    return { file, size: stat.size, sha256: digest(fs.readFileSync(absolute)) };
  });
}
function binding(sourceSha, version, runId) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) || !/^\d+$/.test(runId)) throw new Error('desktop_artifact_invalid_binding');
  return { sourceSha, version, runId };
}
function create(directory, sourceSha, version, runId) {
  const files = inventory(directory);
  if (files.filter(row => row.file.endsWith('.zip')).length !== 1 || files.filter(row => row.file.endsWith('.dmg')).length !== 1) throw new Error('desktop_artifact_missing_archive');
  const manifest = { schemaVersion: 1, ...binding(sourceSha, version, runId), files };
  fs.writeFileSync(path.join(directory, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return digest(JSON.stringify(manifest));
}
function verify(directory, sourceSha, version, runId, expectedDigest) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'build-manifest.json')));
  const expected = binding(sourceSha, version, runId);
  if (!/^[a-f0-9]{64}$/.test(expectedDigest || '') || digest(JSON.stringify(manifest)) !== expectedDigest || manifest.schemaVersion !== 1
    || Object.entries(expected).some(([key, value]) => manifest[key] !== value)
    || JSON.stringify(manifest.files) !== JSON.stringify(inventory(directory))) throw new Error('desktop_artifact_binding_mismatch');
  return manifest;
}
module.exports = { inventory, create, verify };
if (require.main === module) {
  try {
    const [mode, directory, sha, version, runId, expectedDigest] = process.argv.slice(2);
    if (mode === 'create') { const manifestDigest = create(directory, sha, version, runId); if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `manifest_digest=${manifestDigest}\n`); console.log(manifestDigest); }
    else if (mode === 'verify') { verify(directory, sha, version, runId, expectedDigest); console.log('desktop_artifact_verified'); }
    else throw new Error('desktop_artifact_invalid_mode');
  } catch { console.error('desktop_artifact_verification_failed'); process.exitCode = 1; }
}
