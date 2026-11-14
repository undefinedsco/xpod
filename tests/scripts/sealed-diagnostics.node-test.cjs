const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../../scripts/sealed-diagnostics.cjs');
const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args],
  { encoding: 'utf8', env: { ...process.env, XPOD_DIAGNOSTICS_PUBLIC_KEY: '', ...env } });

test('sealed diagnostics round-trip only with the private key and never contain plaintext', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-diag-'));
  try {
    const keys = path.join(dir, 'keys');
    fs.mkdirSync(keys);
    assert.equal(run(['keygen', '--private', `${keys}/a.pem`, '--public', `${keys}/a.pub`]).status, 0);
    assert.equal(run(['keygen', '--private', `${keys}/b.pem`, '--public', `${keys}/b.pub`]).status, 0);
    const input = path.join(dir, 'private');
    fs.mkdirSync(input);
    fs.writeFileSync(path.join(input, 'failure-private.json'), '{"message":"SECRET-ERROR-DETAIL"}');
    const sealed = path.join(dir, 'out/diagnostics.sealed');
    const result = run(['seal', '--in', input, '--in', path.join(dir, 'absent'), '--out', sealed],
      { XPOD_DIAGNOSTICS_PUBLIC_KEY: fs.readFileSync(`${keys}/a.pub`, 'utf8') });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.readFileSync(sealed).includes('SECRET-ERROR-DETAIL'));

    assert.notEqual(run(['open', '--key', `${keys}/b.pem`, '--in', sealed, '--out', `${dir}/wrong`]).status, 0);
    const opened = run(['open', '--key', `${keys}/a.pem`, '--in', sealed, '--out', `${dir}/open`]);
    assert.equal(opened.status, 0, opened.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'open/0-private/failure-private.json'), 'utf8'),
      '{"message":"SECRET-ERROR-DETAIL"}');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sealing without a public key or without inputs never fails the job or writes plaintext', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-diag-'));
  try {
    fs.mkdirSync(path.join(dir, 'private'));
    const noKey = run(['seal', '--in', path.join(dir, 'private'), '--out', path.join(dir, 'x.sealed')]);
    assert.equal(noKey.status, 0);
    assert.match(noKey.stdout, /XPOD_DIAGNOSTICS_PUBLIC_KEY is not set/);
    assert.ok(!fs.existsSync(path.join(dir, 'x.sealed')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
