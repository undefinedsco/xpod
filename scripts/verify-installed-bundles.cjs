const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// Explicit minimum release acceptance set: same leaf versions can contain
// different bundled builds, so successful imports alone cannot prove freshness.
const BUNDLES = ['ai-connections', 'extension-sdk', 'shared-ui', 'solid-sdk', 'drizzle-solid', 'extensions'];
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function verifyInstalledBundles(tarball, installedRoot, evidenceRoot) {
  const tar = (args) => execFileSync('tar', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const names = tar(['tzf', tarball]).trimEnd().split('\n');
  const modes = tar(['tvzf', tarball]).trimEnd().split('\n');
  // Validate before extraction. Reject links, special files and ambiguous
  // names, so an archive cannot write outside our newly created scratch root.
  if (names.length !== modes.length || names.some((name, i) => !name.startsWith('package/')
    || /[\\\r\n\u0000]/u.test(name) || name.split('/').some((part) => part === '..' || part === '.')
    || !['-', 'd'].includes(modes[i][0]))) throw new Error('Unsafe bundle proof archive');
  const realRoot = fs.realpathSync(installedRoot);
  const scratch = fs.mkdtempSync(path.join(evidenceRoot, 'bundle-proof-'));
  fs.chmodSync(scratch, 0o700);
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  try {
    const directories = BUNDLES.map((name) => `package/node_modules/@undefineds.co/${name}`);
    tar(['xzf', tarball, '-C', scratch, '--', ...directories]);
    return BUNDLES.map((name) => {
      const prefix = `package/node_modules/@undefineds.co/${name}/`;
      const files = names.filter((entry, i) => entry.startsWith(prefix) && modes[i][0] === '-');
      if (!files.includes(`${prefix}package.json`)) throw new Error(`Missing bundled package ${name}`);
      const inventory = crypto.createHash('sha256');
      for (const entry of files.sort()) {
        const expected = path.join(scratch, entry);
        const installed = path.join(installedRoot, entry.slice('package/'.length));
        let real;
        try { real = fs.realpathSync(installed); } catch { throw new Error(`Missing installed bundle file: ${entry}`); }
        if (!inside(realRoot, real) || !fs.statSync(real).isFile()) throw new Error(`Installed bundle escaped Xpod: ${entry}`);
        const digest = hash(expected);
        if (hash(real) !== digest) throw new Error(`Installed bundle bytes differ: ${entry}`);
        inventory.update(`${entry}\0${digest}\n`);
      }
      return { name: `@undefineds.co/${name}`, files: files.length, sha256: inventory.digest('hex'), bytesMatched: true, containedInInstalledXpod: true };
    });
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
module.exports = { verifyInstalledBundles };
