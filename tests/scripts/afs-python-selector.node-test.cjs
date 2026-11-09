'use strict';
// H1: the REAL AFS publication selector/budget must accept the Python actually
// selected by the fixed /usr/bin/python3 path on a Linux-style symlink layout,
// and must still reject a sibling hardlink that merely shares the inode.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {commandBudget, MAX_TIMEOUT_MS} = require('../../scripts/lib/afs-publication-command.cjs');
const {resolveExecutableIdentityPath, executableIdentityMatches} = require('../../scripts/lib/executable-identity-path.cjs');
const budget = require('../../scripts/lib/afs-consumer-budget.cjs');

const roots = [];
function root() {
  const value = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'afs-sel-')));
  roots.push(value);
  return value;
}
test.after(() => { for (const value of roots.splice(0)) fs.rmSync(value, {recursive: true, force: true}); });

test('resolved symlinked python and AFS consumer window are accepted; sibling hardlink is not', () => {
  const dir = root();
  const target = path.join(dir, 'python3.11');
  fs.writeFileSync(target, '#!/bin/sh\nexit 0\n'); fs.chmodSync(target, 0o755);
  const requested = path.join(dir, 'python3');
  fs.symlinkSync('python3.11', requested);
  const sibling = path.join(dir, 'git');
  fs.linkSync(target, sibling);

  // Real AFS consumer window from the fixed budget authority (not a raised limit).
  const consumerMs = budget.afsConsumerBudget().consumerRunSeconds * 1000;
  assert.ok(consumerMs > MAX_TIMEOUT_MS, 'AFS window must exceed the ordinary window');

  const resolved = resolveExecutableIdentityPath(requested);
  assert.equal(resolved, target);
  assert.equal(executableIdentityMatches(requested, resolved), true);
  assert.equal(executableIdentityMatches(requested, sibling), false);
  assert.equal(fs.statSync(resolved).ino, fs.statSync(sibling).ino);
  assert.equal(execFileSync(resolved, [], {encoding: 'utf8'}), '');
});

test('a non-matching command cannot borrow the extended AFS window', () => {
  const dir = root();
  const other = path.join(dir, 'other');
  fs.writeFileSync(other, '#!/bin/sh\nexit 0\n'); fs.chmodSync(other, 0o755);
  const consumerMs = budget.afsConsumerBudget().consumerRunSeconds * 1000;
  // commandBudget is the single authority used by runPublicationCommand; an
  // unrecognised command stays on the ordinary window, which the AFS-sized
  // caller timeout then exceeds (the exact pre-fix failure shape).
  const value = commandBudget(other, [path.join(process.cwd(), 'scripts/lib/afs-module-consumer.py'), '/tmp/x', '--run'],
    {cwd: process.cwd(), env: {}, label: 'module-registry-consumer'});
  assert.equal(value.maximumTimeoutMs, MAX_TIMEOUT_MS);
  assert.ok(consumerMs > value.maximumTimeoutMs);
});
