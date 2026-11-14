const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withOwnedTempRoot, assertOwnedTempParent } = require('./owned-temp-root.cjs');
// Layout isolation only: upstream commands/configuration are not overridden.
async function withExternalProducerWorkspace(repository, operation) {
  const root = fs.realpathSync(repository), parent = fs.realpathSync(os.tmpdir());
  if (parent === root || parent.startsWith(root + path.sep)) throw new Error('External producer temporary parent is inside the host repository');
  const stat = fs.lstatSync(parent), checked = { parent, identity: { dev: stat.dev, ino: stat.ino } };
  const result = await withOwnedTempRoot('xpod-external-producer-', async directory => {
    const owned = fs.lstatSync(directory);
    const value = await operation(directory);
    return { value, directory, identity: { dev: owned.dev, ino: owned.ino } };
  }, checked);
  assertOwnedTempParent(checked);
  try { fs.lstatSync(result.directory); throw new Error('External producer source still exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { value: result.value, cleanup: { directory: result.directory, identity: result.identity, parent: checked, removed: true } };
}
module.exports = { withExternalProducerWorkspace };
