const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The handle only removes the exact root it created; input and output paths
// never determine cleanup ownership. rmSync removes a replaced symlink itself.
function createOwnedTempRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { path: root, cleanup(failure) {
    try { fs.rmSync(root, { recursive: true, force: true }); }
    catch (error) {
      if (failure) throw new AggregateError([failure.error, error], 'Operation and temporary cleanup failed', { cause: failure.error });
      throw error;
    }
  } };
}

async function withOwnedTempRoot(prefix, operation) {
  const owned = createOwnedTempRoot(prefix);
  let failure;
  try { return await operation(owned.path); }
  catch (error) { failure = { error }; throw error; }
  finally { owned.cleanup(failure); }
}
module.exports = { createOwnedTempRoot, withOwnedTempRoot };
