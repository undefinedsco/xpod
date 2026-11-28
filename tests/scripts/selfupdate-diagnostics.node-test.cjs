const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WRAPPER = path.resolve(__dirname, '../../scripts/diagnostics/capture-self-update-diagnostics.mjs');

/** A fake helper that behaves like packaged-update-acceptance: prints the private
 *  userData path, writes the four allowlisted artifacts, then exits with `code`. */
function fakeHelper(dir) {
  const file = path.join(dir, 'fake-helper.mjs');
  fs.writeFileSync(file, `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-update-'));
fs.mkdirSync(path.join(userData, 'updates'), { recursive: true });
fs.writeFileSync(path.join(userData, 'update-events.log'), 'checking-for-update\\nupdate-available\\n');
fs.writeFileSync(path.join(userData, 'accepted-version.txt'), '0.4.33');
fs.writeFileSync(path.join(userData, 'install-requested.txt'), '0.4.35');
fs.writeFileSync(path.join(userData, 'updates', 'install.log'), 'installer started\\n');
console.log('Isolated userData: ' + userData);
await new Promise((resolve) => setTimeout(resolve, 400));
fs.rmSync(userData, { recursive: true, force: true });
process.exit(Number(process.argv[2] || 0));
`);
  return file;
}

test('snapshots the four allowlisted facts, preserves the helper exit code, and never prints contents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfupdate-diag-test-'));
  try {
    const helper = fakeHelper(root);
    const snapshot = path.join(root, 'snapshot');
    const result = spawnSync(process.execPath, [WRAPPER, '--snapshot-dir', snapshot, '--', helper, '7'],
      { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 7, 'wrapper must propagate the helper exit code');
    assert.equal(result.stdout.includes('installer started'), false, 'never echo file contents');
    const facts = JSON.parse(fs.readFileSync(path.join(snapshot, 'diagnostics-facts.json'), 'utf8'));
    assert.equal(facts.classification, 'NOT_ACCEPTANCE');
    assert.equal(facts.userDataObserved, true);
    assert.equal(facts.helperExit, 7);
    assert.deepEqual(Object.keys(facts.files).sort(), [
      'accepted-version.txt', 'install-requested.txt', 'update-events.log', 'updates/install.log',
    ].sort());
    for (const name of Object.keys(facts.files)) {
      const copied = path.join(snapshot, name.replaceAll('/', '__'));
      assert.equal(fs.existsSync(copied), true, `${name} must be snapshotted`);
      assert.equal(fs.statSync(copied).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writes nothing outside the snapshot dir and leaves the helper cleanup untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfupdate-diag-test-'));
  try {
    const helper = fakeHelper(root);
    const snapshot = path.join(root, 'snapshot');
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('xpod-update-')).length;
    const result = spawnSync(process.execPath, [WRAPPER, '--snapshot-dir', snapshot, '--', helper, '0'],
      { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0);
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('xpod-update-')).length;
    assert.equal(after, before, 'the wrapper must not create or retain a userData dir itself');
    const entries = fs.readdirSync(snapshot).sort();
    assert.ok(entries.includes('diagnostics-facts.json'));
    for (const entry of entries) {
      assert.equal(entry.includes('..'), false);
      assert.equal(entry.startsWith('xpod-update-'), false, 'no raw userData directory is copied');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses to run without --snapshot-dir and does not spawn a helper', () => {
  const result = spawnSync(process.execPath, [WRAPPER, '--', 'unused.mjs'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--snapshot-dir is required/);
});

// ---------------------------------------------------------------------------
// Review follow-ups: signal forwarding, split marker, bounded reads, symlinks.
// ---------------------------------------------------------------------------

/** Helper that writes a cleanup marker from its OWN finally, then lingers. */
function lingeringHelper(dir) {
  const file = path.join(dir, 'linger.mjs');
  fs.writeFileSync(file, `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-update-'));
fs.writeFileSync(path.join(userData, 'accepted-version.txt'), '0.4.33');
const marker = ${JSON.stringify(path.join(dir, 'helper-cleanup.txt'))};
const stop = () => {
  fs.rmSync(userData, { recursive: true, force: true });
  fs.writeFileSync(marker, 'cleaned');
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
console.log('Isolated userData: ' + userData);
setInterval(() => {}, 1000);
`);
  return file;
}

test('forwards SIGTERM to the exact owned child and waits for its own cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfupdate-diag-test-'));
  try {
    const helper = lingeringHelper(root);
    const snapshot = path.join(root, 'snapshot');
    const marker = path.join(root, 'helper-cleanup.txt');
    const { spawn } = require('node:child_process');
    const wrapper = spawn(process.execPath, [WRAPPER, '--snapshot-dir', snapshot, '--', helper],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    // Wait until the helper announced its userData (proves it is running).
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('helper did not announce userData')), 10_000);
      wrapper.stdout.on('data', (chunk) => {
        if (String(chunk).includes('Isolated userData: ')) { clearTimeout(timer); resolve(); }
      });
      wrapper.once('error', reject);
    });
    wrapper.kill('SIGTERM');
    const code = await new Promise((resolve) => wrapper.once('close', resolve));
    assert.equal(code, 0, 'the helper exited cleanly through its own signal cleanup');
    assert.equal(fs.existsSync(marker), true, 'the helper finally-cleanup must have run');
    const facts = JSON.parse(fs.readFileSync(path.join(snapshot, 'diagnostics-facts.json'), 'utf8'));
    assert.equal(facts.helperExit, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parses a marker split across chunks and ignores an incomplete line', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfupdate-diag-test-'));
  try {
    const file = path.join(root, 'split.mjs');
    fs.writeFileSync(file, `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const real = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-update-'));
fs.writeFileSync(path.join(real, 'accepted-version.txt'), '0.4.33');
// A decoy line that never terminates must NOT be accepted, and the real marker
// must still be found when it is split across two writes.
process.stdout.write('Isolated userData: /tmp/xpod-update-NOT-REAL');
const line = '\\nIsolated userData: ' + real + '\\n';
process.stdout.write(line.slice(0, 9));
process.stdout.write(line.slice(9));
setTimeout(() => { fs.rmSync(real, { recursive: true, force: true }); process.exit(0); }, 300);
`);
    const snapshot = path.join(root, 'snapshot');
    const result = spawnSync(process.execPath, [WRAPPER, '--snapshot-dir', snapshot, '--', file],
      { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0);
    const facts = JSON.parse(fs.readFileSync(path.join(snapshot, 'diagnostics-facts.json'), 'utf8'));
    assert.equal(facts.userDataObserved, true, 'the complete line must be accepted');
    assert.equal(Object.keys(facts.files).includes('accepted-version.txt'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an oversize allowlisted file and keeps the helper exit code', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfupdate-diag-test-'));
  try {
    const file = path.join(root, 'oversize.mjs');
    fs.writeFileSync(file, `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-update-'));
fs.writeFileSync(path.join(userData, 'update-events.log'), 'x'.repeat(${512 * 1024 + 2048}));
console.log('Isolated userData: ' + userData);
setTimeout(() => { fs.rmSync(userData, { recursive: true, force: true }); process.exit(9); }, 400);
`);
    const snapshot = path.join(root, 'snapshot');
    const result = spawnSync(process.execPath, [WRAPPER, '--snapshot-dir', snapshot, '--', file],
      { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 9, 'helper exit code is preserved');
    const facts = JSON.parse(fs.readFileSync(path.join(snapshot, 'diagnostics-facts.json'), 'utf8'));
    assert.equal(facts.files['update-events.log'], undefined, 'oversize file is not snapshotted');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a symlinked allowlisted file and a symlinked updates directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfupdate-diag-test-'));
  try {
    const file = path.join(root, 'symlink.mjs');
    fs.writeFileSync(file, `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-update-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
fs.writeFileSync(path.join(outside, 'secret.txt'), 'do-not-copy');
fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(userData, 'update-events.log'));
fs.writeFileSync(path.join(outside, 'install.log'), 'MUST-NOT-BE-COPIED');
fs.symlinkSync(outside, path.join(userData, 'updates'));
fs.writeFileSync(path.join(userData, 'accepted-version.txt'), '0.4.33');
console.log('Isolated userData: ' + userData);
setTimeout(() => { fs.rmSync(userData, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); process.exit(0); }, 400);
`);
    const snapshot = path.join(root, 'snapshot');
    const result = spawnSync(process.execPath, [WRAPPER, '--snapshot-dir', snapshot, '--', file],
      { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0);
    const facts = JSON.parse(fs.readFileSync(path.join(snapshot, 'diagnostics-facts.json'), 'utf8'));
    // A refused entry records a rejection reason (never bytes), so nothing leaks.
    assert.equal(facts.files['update-events.log'], undefined, 'symlinked leaf file must not be captured');
    assert.notEqual(facts.files['updates/install.log'], undefined, 'the redirected parent is explicitly rejected');
    assert.equal(facts.files['updates/install.log'].bytes, undefined, 'no bytes may be recorded for a rejected parent');
    assert.match(String(facts.files['updates/install.log'].rejected), /parent-redirected/u);
    const leaked = path.join(snapshot, 'updates__install.log');
    assert.equal(fs.existsSync(leaked), false, 'the redirected parent must never be snapshotted');
    assert.equal(fs.existsSync(path.join(snapshot, 'update-events.log')), false,
      'the leaf symlink must never be snapshotted');
    assert.equal(facts.files['accepted-version.txt'] !== undefined, true, 'the real file is still captured');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Final-correction regressions: freshness (no frozen first-seen snapshot),
// real parent redirect, and a blocked snapshot target must not change the exit.
// ---------------------------------------------------------------------------

test('re-snapshots on every poll so the LATEST events and version are published', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfupdate-diag-test-'));
  try {
    const file = path.join(root, 'progressing.mjs');
    fs.writeFileSync(file, `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-update-'));
fs.mkdirSync(path.join(userData, 'updates'), { recursive: true });
// FIRST state: only the checking line, old version, no install yet.
fs.writeFileSync(path.join(userData, 'update-events.log'), 'checking-for-update\\n');
fs.writeFileSync(path.join(userData, 'accepted-version.txt'), '0.4.33');
console.log('Isolated userData: ' + userData);
await new Promise((r) => setTimeout(r, 300));
// FINAL state: full lifecycle, relaunched version, install markers.
fs.writeFileSync(path.join(userData, 'update-events.log'),
  'checking-for-update\\nupdate-available\\ndownloaded\\nquit-and-install\\nrelaunched-on-0.4.35\\n');
fs.writeFileSync(path.join(userData, 'accepted-version.txt'), '0.4.35');
fs.writeFileSync(path.join(userData, 'install-requested.txt'), '0.4.35');
fs.writeFileSync(path.join(userData, 'updates', 'install.log'), 'installer finished\\nrelaunch ok\\n');
await new Promise((r) => setTimeout(r, 500));
fs.rmSync(userData, { recursive: true, force: true });
process.exit(7);
`);
    const snapshot = path.join(root, 'snapshot');
    const result = spawnSync(process.execPath, [WRAPPER, '--snapshot-dir', snapshot, '--', file],
      { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 7, 'helper exit code preserved after userData deletion');
    const version = fs.readFileSync(path.join(snapshot, 'accepted-version.txt'), 'utf8');
    assert.equal(version, '0.4.35', 'the FINAL version must win, not the frozen first value');
    const events = fs.readFileSync(path.join(snapshot, 'update-events.log'), 'utf8');
    assert.match(events, /relaunched-on-0\.4\.35/u, 'final lifecycle events must be published');
    assert.match(events, /quit-and-install/u);
    const log = fs.readFileSync(path.join(snapshot, 'updates__install.log'), 'utf8');
    assert.match(log, /relaunch ok/u, 'final installer log must be published');
    const facts = JSON.parse(fs.readFileSync(path.join(snapshot, 'diagnostics-facts.json'), 'utf8'));
    assert.equal(facts.helperExit, 7);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a blocked snapshot target does not crash the wrapper or change the helper exit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfupdate-diag-test-'));
  try {
    const file = path.join(root, 'blocked.mjs');
    fs.writeFileSync(file, `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-update-'));
fs.writeFileSync(path.join(userData, 'update-events.log'), 'checking-for-update\\n');
fs.writeFileSync(path.join(userData, 'accepted-version.txt'), '0.4.33');
console.log('Isolated userData: ' + userData);
setTimeout(() => { fs.rmSync(userData, { recursive: true, force: true }); process.exit(7); }, 500);
`);
    const snapshot = path.join(root, 'snapshot');
    fs.mkdirSync(snapshot, { recursive: true });
    // A DIRECTORY sits where update-events.log would be written: open() throws EISDIR.
    fs.mkdirSync(path.join(snapshot, 'update-events.log'));
    const result = spawnSync(process.execPath, [WRAPPER, '--snapshot-dir', snapshot, '--', file],
      { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 7, 'a blocked target must not replace the helper status');
    // The other real file is still captured despite the collision.
    assert.equal(fs.readFileSync(path.join(snapshot, 'accepted-version.txt'), 'utf8'), '0.4.33');
    const facts = JSON.parse(fs.readFileSync(path.join(snapshot, 'diagnostics-facts.json'), 'utf8'));
    assert.equal(facts.helperExit, 7);
    assert.equal(result.stderr.includes('wrapper failed'), false, 'no wrapper crash');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a symlinked updates parent even when the outside file really exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfupdate-diag-test-'));
  try {
    const file = path.join(root, 'parentredirect.mjs');
    fs.writeFileSync(file, `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-update-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
fs.writeFileSync(path.join(outside, 'install.log'), 'MUST-NOT-BE-COPIED');
fs.symlinkSync(outside, path.join(userData, 'updates'));
fs.writeFileSync(path.join(userData, 'accepted-version.txt'), '0.4.35');
console.log('Isolated userData: ' + userData);
setTimeout(() => {
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  process.exit(0);
}, 500);
`);
    const snapshot = path.join(root, 'snapshot');
    const result = spawnSync(process.execPath, [WRAPPER, '--snapshot-dir', snapshot, '--', file],
      { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0);
    assert.equal(fs.existsSync(path.join(snapshot, 'updates__install.log')), false,
      'a redirected parent must never be copied');
    assert.equal(fs.readFileSync(path.join(snapshot, 'accepted-version.txt'), 'utf8'), '0.4.35');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
