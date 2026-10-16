const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectTarballBuffer } = require('./workspace-package-payload.cjs');
const ARCHIVE_LIMIT = 128 * 1024 ** 2;
const TAR_LIMITS = { expandedBytes: 256 * 1024 ** 2, members: 100000, gnuLongNames: true };

// Explicit minimum release acceptance set: same leaf versions can contain
// different bundled builds, so successful imports alone cannot prove freshness.
// `ai-connections` carries both the applet and the interoperability contract it
// owns, and `pod-collections` carries the Pod collection runtime, so their bytes
// have to be proven just like the rest.
const BUNDLES = ['ai-connections', 'extension-sdk', 'pod-collections', 'shared-ui', 'solid-sdk', 'drizzle-solid', 'extensions'];
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function verifyInstalledBundles(tarball, installedRoot, evidenceRoot) {
  const compressed = require('./lib/root-registry-supply.cjs').readRegular(tarball, ARCHIVE_LIMIT);
  // Binary names and types remain authoritative, including literal CR/LF bytes.
  // There is no platform-specific tar listing protocol or extraction step.
  const { entries } = inspectTarballBuffer(compressed, TAR_LIMITS);
  if (entries.some(entry => !entry.path.startsWith('package/') || /[\u0000-\u001f\u007f]/u.test(entry.path))) throw new Error('Unsafe bundle proof archive');
  const realRoot = fs.realpathSync(installedRoot);
  const directoryNames = new Map();
  function installedPath(entry) {
    let current = installedRoot;
    for (const part of entry.slice('package/'.length).split('/')) {
      if (!directoryNames.has(current)) directoryNames.set(current, new Set(fs.readdirSync(current)));
      if (!directoryNames.get(current).has(part)) throw new Error(`Missing installed bundle file: ${entry}`);
      current = path.join(current, part);
    }
    return current;
  }
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return BUNDLES.map((name) => {
    const prefix = `package/node_modules/@undefineds.co/${name}/`;
    const files = entries.filter(entry => entry.path.startsWith(prefix) && entry.type === 'file');
    if (!files.some(entry => entry.path === `${prefix}package.json`)) throw new Error(`Missing bundled package ${name}`);
    const inventory = crypto.createHash('sha256');
    for (const member of files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
      const entry = member.path;
      let real;
      try { real = fs.realpathSync(installedPath(entry)); } catch { throw new Error(`Missing installed bundle file: ${entry}`); }
      if (!inside(realRoot, real) || !fs.statSync(real).isFile()) throw new Error(`Installed bundle escaped Xpod: ${entry}`);
      const digest = member.sha256;
      if (hash(real) !== digest) throw new Error(`Installed bundle bytes differ: ${entry}`);
      inventory.update(`${entry}\0${digest}\n`);
    }
    return { name: `@undefineds.co/${name}`, files: files.length, sha256: inventory.digest('hex'), bytesMatched: true, containedInInstalledXpod: true };
  });
}
module.exports = { BUNDLES, verifyInstalledBundles };
