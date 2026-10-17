import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { CliCommandError } from './lib/output';

const busy = () => new CliCommandError('module_busy', 'Another module operation is active; retry after it finishes.');

/** Local-store lock: the fixed database inode is never removed or replaced. */
export async function withModuleOwnedLock<T>(legacyPath: string, action: () => Promise<T>): Promise<T> {
  const owner = process.getuid?.();
  const directory = await lstat(path.dirname(legacyPath));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0
    || (owner !== undefined && directory.uid !== owner)) {
    throw new CliCommandError('module_lock_invalid', 'Module store must be a private owned directory.');
  }
  try { await lstat(legacyPath); throw busy(); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
  const filename = `${legacyPath}.sqlite`;
  try { const handle = await open(filename, 'wx', 0o600); await handle.close(); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
    || (owner !== undefined && stat.uid !== owner)) {
    throw new CliCommandError('module_lock_invalid', 'Module lock must be a private regular file.');
  }
  let sqlite: typeof import('node:sqlite');
  try { sqlite = await import('node:sqlite'); }
  catch { throw new CliCommandError('module_runtime_unsupported', 'Module operations require Bun or Node.js >=22.13 with SQLite support.'); }
  const database = new sqlite.DatabaseSync(filename);
  let acquired = false;
  try {
    database.exec('PRAGMA busy_timeout=0');
    try { database.exec('BEGIN IMMEDIATE'); acquired = true; }
    catch (cause) {
      const failure = cause as Error & { errcode?: number };
      // Extended SQLite results retain their primary result in the low byte.
      const primary = failure.errcode === undefined ? undefined : failure.errcode & 0xff;
      if (primary === 5 || primary === 6) throw busy();
      throw cause;
    }
    return await action();
  } finally {
    try { if (acquired) database.exec('ROLLBACK'); }
    finally { database.close(); }
  }
}
