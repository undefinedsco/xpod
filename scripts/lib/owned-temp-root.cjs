const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The handle only removes the exact root it created; input and output paths
// never determine cleanup ownership. rmSync removes a replaced symlink itself.
function assertOwnedTempParent(options) {
  const { parent, identity } = options;
  if (typeof parent !== 'string' || !path.isAbsolute(parent) || path.resolve(parent) !== parent || !identity) throw new Error('Explicit verified temporary parent required');
  let current = path.parse(parent).root;
  const check = file => { const stat = fs.lstatSync(file); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Temporary parent must have ordinary directory ancestors'); return stat; };
  let stat = check(current);
  for (const part of parent.slice(current.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); stat = check(current); }
  if (stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error('Temporary parent identity changed');
  return parent;
}
function createOwnedTempRoot(prefix, options) {
  const parent = options ? assertOwnedTempParent(options) : os.tmpdir();
  const root = fs.mkdtempSync(path.join(parent, prefix));
  const owned = options ? fs.lstatSync(root) : null;
  const assertOwned = () => {
    assertOwnedTempParent(options);
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== owned.dev || stat.ino !== owned.ino || stat.dev !== options.identity.dev) throw new Error('Temporary root ownership changed');
  };
  if (options) assertOwned();
  return { path: root, cleanup(failure) {
    try { if (options) assertOwned(); fs.rmSync(root, { recursive: true, force: true }); }
    catch (error) {
      if (failure) throw new AggregateError([failure.error, error], 'Operation and temporary cleanup failed', { cause: failure.error });
      throw error;
    }
  } };
}

async function withOwnedTempRoot(prefix, operation, options) {
  const owned = createOwnedTempRoot(prefix, options);
  let failure;
  try { return await operation(owned.path); }
  catch (error) { failure = { error }; throw error; }
  finally { owned.cleanup(failure); }
}
module.exports = { createOwnedTempRoot, withOwnedTempRoot, assertOwnedTempParent };
