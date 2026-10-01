#!/usr/bin/env bun
/** Materialize previously audited Cargo inventory candidates without guessing licenses. */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from '../src/manifest';

interface Inventory {
  target: string;
  packages: {
    name: string; version: string; source: string | null; licenseResolved: string | null;
    activeFeatures: string[]; rolesFromMetadataNotBuildUnits: string[];
    licenseFiles: { path: string; relativePath: string; sha256: string }[];
  }[];
}

const target = process.argv[2];
if (!/^(darwin|linux)-arm64$/.test(target ?? '') || !process.argv[3]) {
  throw new Error('Usage: collect-native-notices.ts <darwin-arm64|linux-arm64> <audited inventory JSON>');
}
const inventory = JSON.parse(readFileSync(process.argv[3], 'utf8')) as Inventory;
const expected = target === 'darwin-arm64' ? 'macos-arm64' : 'linux-arm64';
if (inventory.target !== expected) { throw new Error(`Inventory target mismatch: ${inventory.target}`); }
const root = fileURLToPath(new URL('../licenses/native/collection/', import.meta.url));
mkdirSync(path.join(root, 'objects'), { recursive: true });
function sourceOrigin(entry: Inventory['packages'][number]): string {
  if (entry.source?.startsWith('registry+')) {
    return `https://static.crates.io/crates/${entry.name}/${entry.name}-${entry.version}.crate`;
  }
  if (entry.name === 'agentfs-pod') { return 'workspace:tools/agentfs-pod'; }
  if (entry.name === 'agentfs' || entry.name === 'agentfs-sdk') {
    return 'https://github.com/tursodatabase/agentfs/tree/0a014ebd4918615baff589ed17486e557e7c6a23';
  }
  throw new Error(`Unrecognized package source: ${entry.name}@${entry.version}`);
}
const packages = inventory.packages.map((entry) => ({
  name: entry.name, version: entry.version, licenseExpression: entry.licenseResolved,
  // Keep the crate archive as provenance; do not publish workstation paths.
  source: sourceOrigin(entry),
  features: entry.activeFeatures, rolesAdvisory: entry.rolesFromMetadataNotBuildUnits,
  files: entry.licenseFiles.map((file) => {
    const sha = sha256File(file.path);
    if (sha !== file.sha256) { throw new Error(`Audited notice changed: ${entry.name}/${file.relativePath}`); }
    const object = `objects/${sha}.txt`;
    cpSync(file.path, path.join(root, object));
    return { originalPath: file.relativePath, object, sha256: sha };
  }),
}));
writeFileSync(path.join(root, `${target}.json`), `${JSON.stringify({
  schemaVersion: 1, target, status: 'partial-collection; not release clearance',
  scope: 'normal/build dependencies, not proof that every package is linked at runtime',
  packages,
}, null, 2)}\n`);
console.log(JSON.stringify({ target, packages: packages.length, files: packages.reduce((sum, entry) => sum + entry.files.length, 0),
  missingPackageOriginals: packages.filter((entry) => entry.files.length === 0).map((entry) => `${entry.name}@${entry.version}`) }));
