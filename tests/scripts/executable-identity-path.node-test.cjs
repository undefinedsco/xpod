'use strict';
// Shared executable-path identity: real filesystem, real child execution.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {resolveExecutableIdentityPath, executableIdentityMatches} = require('../../scripts/lib/executable-identity-path.cjs');

const roots = [];
function root() {
  const value = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'exec-id-')));
  roots.push(value);
  return value;
}
function executable(file, body = '#!/bin/sh\nprintf "executed:%s\\n" "$(basename "$0")"\n') {
  fs.writeFileSync(file, body); fs.chmodSync(file, 0o755); return file;
}
test.after(() => { for (const value of roots.splice(0)) fs.rmSync(value, {recursive: true, force: true}); });

test('linux-style symlinked python3 selects and executes the resolved target', () => {
  const dir = root();
  const target = executable(path.join(dir, 'python3.11'));
  const requested = path.join(dir, 'python3');
  fs.symlinkSync('python3.11', requested);
  const resolved = resolveExecutableIdentityPath(requested);
  assert.equal(resolved, target);
  assert.equal(executableIdentityMatches(requested, resolved), true);
  assert.equal(execFileSync(resolved, [], {encoding: 'utf8'}).trim(), 'executed:python3.11');
});

test('AFS module-registry-consumer budget recognises the resolved python and rejects a sibling hardlink', () => {
  const dir = root();
  const target = executable(path.join(dir, 'python3.11'));
  const requested = path.join(dir, 'python3');
  fs.symlinkSync('python3.11', requested);
  const sibling = path.join(dir, 'git');
  fs.linkSync(target, sibling); // same dev/ino as python3.11
  const resolved = resolveExecutableIdentityPath(requested);
  // The selector contract (shared with scripts/lib/afs-publication-command.cjs):
  // only the executable actually selected by the fixed requested path matches.
  assert.equal(executableIdentityMatches(requested, resolved), true);
  assert.equal(executableIdentityMatches(requested, sibling), false);
  assert.equal(fs.statSync(resolved).ino, fs.statSync(sibling).ino); // inode equality alone is not identity
  assert.equal(execFileSync(resolved, [], {encoding: 'utf8'}).trim(), 'executed:python3.11');
});

test('an intermediate directory symlink escaping the canonical parent is refused', () => {
  const dir = root();
  const outside = root();
  executable(path.join(outside, 'tool'));
  fs.symlinkSync(outside, path.join(dir, 'sub'));
  const leaf = path.join(dir, 'leaf');
  fs.symlinkSync('sub/tool', leaf); // lexically dir/sub/tool, really outside/tool
  assert.throws(() => resolveExecutableIdentityPath(leaf), /contained|directory/u);
  // The matcher is a boolean contract: an escaping path simply never matches.
  assert.equal(executableIdentityMatches(leaf, path.join(outside, 'tool')), false);
});

test('a hardlink basename is preserved for the requested leaf and really executed', () => {
  const dir = root();
  const real = executable(path.join(dir, 'python3.11'));
  const alias = path.join(dir, 'git');
  fs.linkSync(real, alias);
  const resolved = resolveExecutableIdentityPath(alias);
  assert.equal(resolved, alias);
  assert.equal(execFileSync(resolved, [], {encoding: 'utf8'}).trim(), 'executed:git');
  assert.equal(executableIdentityMatches(alias, resolved), true);
});

test('changed target identity and link loops are rejected', () => {
  const dir = root();
  const first = executable(path.join(dir, 'first'));
  const second = executable(path.join(dir, 'second'));
  const requested = path.join(dir, 'python3');
  fs.symlinkSync('first', requested);
  const retained = fs.lstatSync(resolveExecutableIdentityPath(requested), {bigint: true});
  assert.equal(resolveExecutableIdentityPath(requested), first);
  fs.unlinkSync(first); fs.linkSync(second, first); // replace the resolved inode
  const current = fs.lstatSync(resolveExecutableIdentityPath(requested), {bigint: true});
  assert.notEqual(current.ino, retained.ino);
  fs.unlinkSync(requested); fs.symlinkSync('second', requested);
  assert.equal(resolveExecutableIdentityPath(requested), second);
  const a = path.join(dir, 'a'), b = path.join(dir, 'b');
  fs.symlinkSync('b', a); fs.symlinkSync('a', b);
  assert.throws(() => resolveExecutableIdentityPath(a), /depth bound/u);
  assert.throws(() => resolveExecutableIdentityPath('python3'), /absolute/u);
});
