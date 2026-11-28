#!/usr/bin/env node
/**
 * CI-REPAIR-ONLY diagnostic wrapper around desktop/scripts/packaged-update-acceptance.mjs.
 *
 * The acceptance helper creates its private userData with
 * `fs.mkdtempSync(os.tmpdir()/xpod-update-*)` and always deletes it in its
 * `finally` cleanup, so a failing self-update leaves nothing behind: the gate
 * reports one compound message and the four facts that name the actual stage are
 * removed before the workflow regains control.
 *
 * This wrapper changes NOTHING about the helper, its cleanup contract or the gate:
 *   - it spawns the REAL helper with the caller's exact arguments;
 *   - it learns the private userData path from the helper's own complete printed
 *     line and refuses any path outside `os.tmpdir()/xpod-update-*`;
 *   - it copies only four small allowlisted files, read from ONE already-open
 *     descriptor, size-bounded, never following a symlink and never writing into
 *     userData;
 *   - it forwards SIGINT/SIGTERM to that exact child and keeps running until the
 *     child closes, so the helper's own cleanup still executes;
 *   - it never prints file contents, and exits with the helper's status (128+signum
 *     when the child died from a signal).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Exactly the four facts that distinguish the self-update failure stages. */
const ALLOWLIST = [
  'update-events.log',
  'accepted-version.txt',
  'install-requested.txt',
  'updates/install.log',
];
const MAX_FILE_BYTES = 512 * 1024;
/** Read one byte past the cap so growth beyond it is detected and rejected. */
const READ_CAP = MAX_FILE_BYTES + 1;
const POLL_MS = 200;
const MARKER = 'Isolated userData: ';
const MAX_MARKER_LINE = 4096;

function parse(argv) {
  let snapshotDir;
  let index = 0;
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--snapshot-dir') { snapshotDir = argv[index + 1]; index += 1; continue; }
    if (arg === '--') { index += 1; break; }
    throw new Error(`unexpected argument ${arg}`);
  }
  if (!snapshotDir) throw new Error('--snapshot-dir is required');
  const passthrough = argv.slice(index);
  if (passthrough.length === 0) throw new Error('helper path is required after --');
  return { snapshotDir, passthrough };
}

/**
 * The helper's temp root must be the real tmpdir. If TMPDIR itself is a symlink,
 * compare canonical parents so a redirecting ancestor cannot smuggle a path in.
 */
function realTmpRoot() {
  try { return fs.realpathSync(os.tmpdir()); } catch { return path.resolve(os.tmpdir()); }
}

/** Accept only `<realTmpdir>/xpod-update-*`, with no redirecting ancestor. */
function acceptUserData(candidate) {
  if (!candidate || !path.isAbsolute(candidate)) return undefined;
  const resolved = path.resolve(candidate);
  const basename = path.basename(resolved);
  if (!basename.startsWith('xpod-update-')) return undefined;
  // Every ancestor up to the tmp root must already be the real path: a symlinked
  // tmpdir itself is tolerated, but nothing below it may redirect.
  let parent;
  try { parent = fs.realpathSync(path.dirname(resolved)); } catch { return undefined; }
  if (parent !== realTmpRoot()) return undefined;
  let info;
  try { info = fs.lstatSync(resolved); } catch { return undefined; }
  if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
  return resolved;
}

/**
 * Verify the parent of a known allowlisted relative path stays inside userData.
 *
 * `updates/install.log` has a real intermediate directory, so a symlinked
 * `updates/` could redirect the read even though O_NOFOLLOW only protects the
 * leaf. The canonical parent must equal the canonical, already-verified userData.
 */
function parentIsConfined(userData, relative) {
  const parent = path.dirname(path.join(userData, relative));
  let realParent;
  let realRoot;
  try {
    realParent = fs.realpathSync(parent);
    realRoot = fs.realpathSync(userData);
  } catch {
    return false;
  }
  // The parent must be the userData root itself (flat names) or a REAL
  // subdirectory that canonicalizes to a path strictly inside it.
  if (realParent === realRoot) return true;
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (!realParent.startsWith(prefix)) return false;
  // A symlinked intermediate directory would not canonicalize inside the root,
  // but check the entry itself too so a link cannot smuggle a real sibling in.
  try {
    const entry = fs.lstatSync(parent);
    if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Copy ONE allowlisted file from a single O_RDONLY|O_NOFOLLOW descriptor.
 *
 * Size and content come from the SAME descriptor, so a swap between fstat and
 * read cannot pass a different byte range. Returns true when a fresh snapshot was
 * written. Diagnostic I/O never escapes: any failure just leaves the previous
 * snapshot in place.
 */
function copyOne(userData, relative, snapshotDir, facts) {
  if (!parentIsConfined(userData, relative)) {
    facts.files[relative] = { rejected: 'parent-redirected' };
    return false;
  }
  const source = path.join(userData, relative);
  let handle;
  try {
    handle = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  let buffer;
  let total = 0;
  try {
    const info = fs.fstatSync(handle);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_FILE_BYTES) return false;
    buffer = Buffer.allocUnsafe(READ_CAP);
    for (;;) {
      const read = fs.readSync(handle, buffer, total, READ_CAP - total, total);
      if (read <= 0) break;
      total += read;
      if (total >= READ_CAP) break;
    }
    if (total > MAX_FILE_BYTES) { facts.files[relative] = { rejected: 'grew' }; return false; }
    if (total !== info.size) { facts.files[relative] = { rejected: 'size-changed' }; return false; }
  } finally {
    try { fs.closeSync(handle); } catch { /* already closed */ }
  }
  try {
    const target = path.join(snapshotDir, relative.replaceAll('/', '__'));
    const out = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT
      | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(out, buffer, 0, total); } finally { fs.closeSync(out); }
  } catch {
    // A blocked target (for example a directory at the snapshot path) must not
    // abort the remaining files or change the helper's exit status.
    facts.files[relative] = { rejected: 'snapshot-write-failed' };
    return false;
  }
  facts.files[relative] = { bytes: total };
  return true;
}

/**
 * Refresh the snapshot on every poll. The helper rewrites these files as the
 * update progresses, so a first-seen value must never be frozen: the last
 * successfully read, non-empty content wins, and if the helper deletes its
 * userData in cleanup the previous snapshot is simply retained.
 */
function snapshotFacts(userData, snapshotDir, facts) {
  if (!userData) return;
  const confined = acceptUserData(userData);
  if (!confined) return;
  for (const relative of ALLOWLIST) {
    try {
      copyOne(confined, relative, snapshotDir, facts);
    } catch {
      // One bad file must never crash the wrapper or orphan the helper.
    }
  }
}

function main() {
  const { snapshotDir, passthrough } = parse(process.argv.slice(2));
  fs.mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(snapshotDir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('snapshot dir is not a real directory');

  const facts = {
    schema: 'xpod-selfupdate-diagnostics/1',
    classification: 'NOT_ACCEPTANCE',
    helperExit: null,
    helperSignal: null,
    userDataObserved: false,
    files: {},
  };
  let userData;

  const child = spawn(process.execPath, passthrough, { stdio: ['ignore', 'pipe', 'pipe'] });

  // Bounded rolling line buffer: only a COMPLETE newline-terminated line may be
  // parsed, so a split marker cannot yield a truncated path.
  let pending = '';
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    if (userData) return;
    pending += chunk.toString('utf8');
    if (pending.length > MAX_MARKER_LINE * 4) pending = pending.slice(-MAX_MARKER_LINE);
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.length > MAX_MARKER_LINE) continue;
      const at = line.indexOf(MARKER);
      if (at < 0) continue;
      const accepted = acceptUserData(line.slice(at + MARKER.length).trim());
      if (accepted) { userData = accepted; facts.userDataObserved = true; }
    }
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  const timer = setInterval(() => snapshotFacts(userData, snapshotDir, facts), POLL_MS);

  // Forward termination to the EXACT owned child only, and keep running until it
  // closes so the helper's own finally-cleanup still runs.
  let forwarded = false;
  const forward = (signal) => {
    if (forwarded) return;
    forwarded = true;
    try { child.kill(signal); } catch { /* child already gone */ }
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  let finished = false;
  const finish = (code, signal) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    // Best effort: a throwing final capture must never replace the helper status.
    try { snapshotFacts(userData, snapshotDir, facts); } catch { /* advisory only */ }
    facts.helperExit = code;
    facts.helperSignal = signal ?? null;
    try {
      fs.writeFileSync(path.join(snapshotDir, 'diagnostics-facts.json'),
        `${JSON.stringify(facts, null, 2)}\n`, { mode: 0o600 });
    } catch { /* facts are advisory only */ }
    // A signal death is reported the shell way (128+signum), never masked as 0.
    const signum = signal ? (os.constants.signals[signal] ?? 0) : 0;
    process.exitCode = typeof code === 'number' ? code : (signum > 0 ? 128 + signum : 1);
  };
  child.once('error', () => finish(1, null));
  child.once('close', (code, signal) => finish(code, signal));
}

try {
  main();
} catch (error) {
  process.stderr.write(`self-update diagnostics wrapper failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
