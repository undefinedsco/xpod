import { cc, FFIType, ptr } from 'bun:ffi';
import { closeSync, constants, fstatSync, lstatSync, openSync, writeFileSync } from 'node:fs';

/** macOS build tool: create relative to an owned directory FD, never rewalk its pathname. */
export function openPrivateEvidence(parent: string, name: string): { write(bytes: string): void; close(): void } {
  if (process.platform !== 'darwin' || !name || name === '.' || name === '..' || /[\/\\\0]/.test(name)) throw new Error('Invalid evidence target');
  const before = lstatSync(parent);
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0) throw new Error('Evidence directory must be private and owned');
  let directory = -1;
  let file = -1;
  const libc = cc({ source: new URL('./evidence-openat.c', import.meta.url), symbols: { xpod_evidence_openat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32,
  } } });
  try {
    directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const held = fstatSync(directory);
    if (held.dev !== before.dev || held.ino !== before.ino || held.uid !== before.uid || (held.mode & 0o077) !== 0) throw new Error('Evidence directory changed');
    const filename = Buffer.from(`${name}\0`);
    file = libc.symbols.xpod_evidence_openat(directory, ptr(filename), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW);
    if (file < 0) throw new Error('Cannot exclusively create evidence in held directory');
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== held.uid || (stat.mode & 0o077) !== 0) throw new Error('Invalid evidence object');
  } catch (error) {
    if (file >= 0) closeSync(file);
    throw error;
  } finally { if (directory >= 0) closeSync(directory); libc.close(); }
  let closed = false;
  return {
    write(bytes) {
      if (closed) throw new Error('Evidence object closed');
      const current = lstatSync(parent), held = fstatSync(file);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
        || current.uid !== before.uid || (current.mode & 0o077) !== 0 || held.nlink !== 1 || held.size !== 0) throw new Error('Evidence authority changed during probes');
      // This check improves failure reporting; the held FD, not this pathname check, authorizes the write.
      writeFileSync(file, bytes);
    },
    close() { if (!closed) { closed = true; closeSync(file); } },
  };
}
