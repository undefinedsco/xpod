const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function runFixture(t, mode, workflowFile) {
  const root = path.resolve(__dirname, '../../.test-data/npm-latest-test'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'run-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workflow = fs.readFileSync(workflowFile || path.resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8');
  const section = workflow.split('      - name: Guard and promote npm latest only after consumer verification\n')[1].split('\n  promote_image:')[0];
  const shell = section.split('        run: |\n')[1].split('\n').map(line => line.slice(10)).join('\n');
  fs.writeFileSync(path.join(dir, 'npm'), `#!${process.execPath}
const fs=require('node:fs'); const p=process.env.FIXTURE_STATE;
const s=fs.existsSync(p)?JSON.parse(fs.readFileSync(p)): {reads:{}, writes:{}};
const a=process.argv.slice(2); const name=a[0]==='view'?a[1]:a[2].slice(0,a[2].lastIndexOf('@'));
if(a[0]==='dist-tag') s.writes[name]=(s.writes[name]||0)+1;
else { s.reads[name]=(s.reads[name]||0)+1;
let value='0.4.5';
if(process.env.FIXTURE_MODE==='newer-native' && name.endsWith('arm64')) value='0.4.10';
else if(process.env.FIXTURE_MODE!=='timeout' && s.writes[name] && s.reads[name]>3) value='0.4.9';
process.stdout.write(JSON.stringify(value)); }
fs.writeFileSync(p,JSON.stringify(s));
`, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const state = path.join(dir, 'state.json');
  const result = spawnSync('bash', ['-c', shell], { encoding: 'utf8', timeout: 15000, env: { ...process.env,
    PATH: `${dir}:${path.dirname(process.execPath)}:${process.env.PATH}`, RELEASE_VERSION: '0.4.9',
    XPOD_PUBLISH_REGISTRY: 'https://fixture.invalid', FIXTURE_MODE: mode, FIXTURE_STATE: state } });
  return { ...result, state: JSON.parse(fs.readFileSync(state)) };
}
test('stale reads recover for root and native with exactly one write each', t => {
  const r=runFixture(t, 'recover', process.env.XPOD_LATEST_TEST_WORKFLOW);
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.deepEqual(Object.values(r.state.writes),[1,1]);
  assert.match(r.stdout,/root and native confirmed/);
});
test('bounded stale reads fail diagnostically without rewriting tags', t => {
  const r=runFixture(t, 'timeout'); assert.equal(r.status,1,r.stderr);
  assert.deepEqual(Object.values(r.state.writes),[1,1]);
  assert.deepEqual(Object.values(r.state.reads),[31,31]);
  assert.match(r.stdout,/propagation timed out/);
});
test('newer native latest prevents all mutations', t => {
  const r=runFixture(t, 'newer-native'); assert.equal(r.status,1);
  assert.deepEqual(r.state.writes,{}); assert.match(r.stderr,/newer than release/);
});
