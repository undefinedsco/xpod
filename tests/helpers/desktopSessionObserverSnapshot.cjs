const { closeSync, openSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/**
 * Publish an observer snapshot atomically: a concurrent reader sees either the
 * previous complete document or the new complete one, never a truncated file.
 *
 * Writes the whole document to a unique temporary in the SAME directory with
 * `wx` (exclusive create, 0600), closes it, then `rename`s over the destination.
 * `rename` within one directory is atomic, so no reader window exists.
 *
 * Failure semantics: only a temporary this call created is removed - an
 * existing foreign file at the chosen name (EEXIST) is never ours and never
 * deleted. The previous snapshot is left untouched and the original error is
 * rethrown; a failed cleanup is reported as such instead of being hidden.
 */
function writeSnapshotAtomic(destination, serialized) {
  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  let owned = false;
  try {
    handle = openSync(temporary, 'wx', 0o600);
    owned = true;
    writeFileSync(handle, serialized);
    closeSync(handle);
    handle = undefined;
    renameSync(temporary, destination);
  } catch (error) {
    let cleanupFailure;
    if (handle !== undefined) {
      try { closeSync(handle); } catch (closeError) { cleanupFailure = closeError; }
    }
    // `owned` is set the instant the exclusive create succeeded, so a failed
    // write/close/rename still removes the temporary this call created.
    if (owned) {
      try { unlinkSync(temporary); } catch (unlinkError) { cleanupFailure = unlinkError; }
    }
    if (cleanupFailure !== undefined) {
      throw new AggregateError([error, cleanupFailure], 'Snapshot publication failed and its owned temporary could not be removed');
    }
    throw error;
  }
}

module.exports = { writeSnapshotAtomic };
