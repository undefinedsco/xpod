const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function packWorkspacePackages(root, names, destination, sha) {
  fs.mkdirSync(destination, { recursive: true });
  const tarballs = {};
  for (const name of names) {
    const directory = path.join(root, 'packages', name);
    const manifestPath = path.join(directory, 'package.json');
    const source = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(source);
    if (manifest.private) throw new Error(`Private package: ${manifest.name}`);
    if (sha) manifest.gitHead = sha;
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
      for (const [dependencyName, value] of Object.entries(manifest[field] || {})) {
        if (!value.startsWith('workspace:')) continue;
        const dependency = JSON.parse(fs.readFileSync(path.join(root, 'packages', dependencyName.split('/').pop(), 'package.json'), 'utf8'));
        manifest[field][dependencyName] = dependency.version;
      }
    }
    try {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
      tarballs[manifest.name] = path.join(destination, packed[0].filename);
    } finally { fs.writeFileSync(manifestPath, source); }
  }
  return tarballs;
}
module.exports = { packWorkspacePackages };
