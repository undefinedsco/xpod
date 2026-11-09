const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
function canonicalMember(value) {
  return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(x => x && x !== '.' && x !== '..');
}
async function readOpenFile(file, expected, limit) {
  if (!expected.isFile() || expected.isSymbolicLink() || !Number.isSafeInteger(expected.size) || expected.size > limit) throw new Error('Evidence member exceeds budget or is not regular');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.ino !== expected.ino || before.dev !== expected.dev || before.size !== expected.size || before.mtimeMs !== expected.mtimeMs || before.ctimeMs !== expected.ctimeMs) throw new Error('Evidence changed before read');
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Evidence changed while reading');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
async function readCanonicalFile(root, name, limit = 1048576) {
  if (!canonicalMember(name)) throw new Error('Noncanonical source path');
  const rootStat = await fs.lstat(root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Source root symlink');
  let current = await fs.realpath(root); const parts = name.split('/');
  for (const part of parts.slice(0, -1)) { current = path.join(current, part); const st = await fs.lstat(current); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Source directory symlink'); }
  const file = path.join(current, parts.at(-1)); const st = await fs.lstat(file); return readOpenFile(file, st, limit);
}
/** Admit the complete safe tree by lstat before decoding any member. */
async function createModeEvidenceReader(root, { memberBytes = 1048576, totalBytes = 16777216, maxFiles = 512 } = {}) {
  const originalRoot = path.resolve(root); const rootStat = await fs.lstat(originalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Evidence root is not an owned directory');
  const canonicalRoot = await fs.realpath(originalRoot); const admitted = new Map(); let total = 0;
  async function walk(directory, prefix, depth) {
    if (depth > 16) throw new Error('Evidence directory depth exceeded');
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || await fs.realpath(directory) !== directory) throw new Error('Evidence directory symlink rejected');
    for (const entry of await fs.readdir(directory)) {
      const name = prefix ? `${prefix}/${entry}` : entry;
      if (!canonicalMember(name)) throw new Error('Noncanonical evidence path');
      const file = path.join(directory, entry); const st = await fs.lstat(file);
      if (st.isSymbolicLink()) throw new Error('Evidence symlink rejected');
      if (st.isDirectory()) await walk(file, name, depth + 1);
      else {
        if (!st.isFile() || !name.endsWith('.json') || st.size > memberBytes || !Number.isSafeInteger(st.size)) throw new Error('Evidence member not admissible');
        total += st.size;
        if (total > totalBytes || admitted.size >= maxFiles) throw new Error('Evidence total budget exceeded');
        admitted.set(name, st);
      }
    }
  }
  await walk(canonicalRoot, '', 0); const cache = new Map();
  return { files: [...admitted.keys()], totalBytes: total, async read(name) {
    if (!canonicalMember(name) || !admitted.has(name)) throw new Error('Undeclared evidence member');
    if (cache.has(name)) return cache.get(name);
    const parts = name.split('/'); let parent = canonicalRoot;
    for (const part of parts.slice(0, -1)) { parent = path.join(parent, part); const st = await fs.lstat(parent); if (!st.isDirectory() || st.isSymbolicLink() || await fs.realpath(parent) !== parent) throw new Error('Evidence directory changed'); }
    const file = path.join(canonicalRoot, ...parts); const current = await fs.lstat(file); const expected = admitted.get(name);
    if (current.isSymbolicLink() || current.ino !== expected.ino || current.dev !== expected.dev || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs || current.ctimeMs !== expected.ctimeMs) throw new Error('Evidence member changed after admission');
    const bytes = await readOpenFile(file, expected, memberBytes); cache.set(name, bytes); return bytes;
  } };
}
module.exports = { canonicalMember, createModeEvidenceReader, readCanonicalFile };
