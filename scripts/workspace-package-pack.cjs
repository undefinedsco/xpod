const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getNpmInvocation } = require('./run-npm-pack.cjs');

function normalizeWorkspaceDependencies(root, source) {
  const manifest = structuredClone(source);
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
    for (const [name, value] of Object.entries(manifest[field] || {})) {
      if (typeof value !== 'string' || /^(?:file:|link:)/.test(value)) throw new Error(`Unsupported dependency: ${name}`);
      if (!value.startsWith('workspace:')) continue;
      if (!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`Invalid workspace identity: ${name}`);
      const dependency = JSON.parse(fs.readFileSync(path.join(root, 'packages', name.split('/').pop(), 'package.json'), 'utf8'));
      if (dependency.name !== name || typeof dependency.version !== 'string'
        || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(dependency.version)) throw new Error(`Workspace identity/version mismatch: ${name}`);
      manifest[field][name] = dependency.version;
    }
  }
  return manifest;
}

function packWorkspacePackages(root, names, destination, sha) {
  fs.mkdirSync(destination, { recursive: true });
  const tarballs = {};
  for (const name of names) {
    const directory = path.join(root, 'packages', name);
    const manifestPath = path.join(directory, 'package.json');
    const source = fs.readFileSync(manifestPath, 'utf8');
    const manifest = normalizeWorkspaceDependencies(root, JSON.parse(source));
    if (manifest.private) throw new Error(`Private package: ${manifest.name}`);
    if (sha) manifest.gitHead = sha;
    try {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      const invocation = getNpmInvocation(['pack', '--ignore-scripts', '--json', '--pack-destination', destination]);
      const packed = JSON.parse(execFileSync(invocation.command, invocation.args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
      tarballs[manifest.name] = path.join(destination, packed[0].filename);
    } finally { fs.writeFileSync(manifestPath, source); }
  }
  return tarballs;
}
module.exports = { packWorkspacePackages, normalizeWorkspaceDependencies };
