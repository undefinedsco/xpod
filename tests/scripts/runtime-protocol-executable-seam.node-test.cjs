'use strict';
// The ORIGINAL production failure: Bun 1.4.2 realpathSync('/usr/bin/python3')
// intermittently returns the sibling hardlink name '/usr/bin/git'; the command
// replay then exec'd git with python flags ("git -I" -> unknown option).
// This test deterministically simulates that substitution and proves the
// production selector used by commandReplay/ABI replay now executes the
// requested command, while a sibling hardlink is still never granted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const roots = [];
function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seam-')));
  roots.push(dir);
  // Genuine multicall stub: dispatch depends on the invoked basename, exactly
  // like Apple's /usr/bin/python3 /usr/bin/git shared inode.
  const stub = [
    '#!/bin/sh',
    'case "$(basename "$0")" in',
    '  git) echo "GIT:$*"; exit 7;;',
    '  python3.11|python3) echo "PY:$*"; exit 0;;',
    '  *) echo "OTHER:$(basename "$0")"; exit 9;;',
    'esac',''].join('\n');
  const real = path.join(dir, 'python3.11');
  fs.writeFileSync(real, stub); fs.chmodSync(real, 0o755);
  const sibling = path.join(dir, 'git');
  fs.linkSync(real, sibling);                    // SAME inode, different name
  const requested = path.join(dir, 'python3');
  fs.symlinkSync('python3.11', requested);       // Linux-style leaf link
  return {dir, real, sibling, requested};
}
test.after(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, {recursive: true, force: true}); });

test('simulated Bun sibling substitution never changes the executed command', () => {
  const {real, sibling, requested} = fixture();
  // Deterministic stand-in for the Bun 1.4.2 defect: realpath on the requested
  // leaf returns the sibling hardlink name. Scoped to this child process.
  const realRealpath = fs.realpathSync;
  fs.realpathSync = (target, ...rest) => (target === requested ? sibling : realRealpath(target, ...rest));
  const {resolveExecutableIdentityPath, executableIdentityMatches} =
    require('../../scripts/lib/executable-identity-path.cjs');
  const selected = resolveExecutableIdentityPath(requested);
  assert.equal(selected, real, 'selection must be the requested python, not the sibling');
  assert.equal(path.basename(selected), 'python3.11');
  assert.equal(executableIdentityMatches(requested, sibling), false);
  assert.equal(fs.statSync(selected).ino, fs.statSync(sibling).ino, 'fixture must share the inode');
  assert.equal(execFileSync(selected, ['-I', '-S', '-B', '-c', 'x'], {encoding: 'utf8'}).trim(),
    'PY:-I -S -B -c x', 'the child must run Python semantics, not git');
  // The exact pre-fix failure shape is still reachable if the wrong name is used.
  let code = 0, out = '';
  try { execFileSync(sibling, ['-I'], {encoding: 'utf8'}); } catch (error) { code = error.status; out = String(error.stdout || ''); }
  assert.equal(code, 7, 'the sibling name really is git to the multicall stub: ' + out);
});
