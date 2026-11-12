/**
 * M2 regression: an IN-PROCESS consumer of buildPlatformPackage must observe a
 * real rejection when its producer child fails, so the caller's `finally`
 * cleanup still runs.
 *
 * This test never compiles anything: it loads the module in an isolated Node
 * child AFTER stubbing `child_process.spawnSync` to return a non-zero status, so
 * the very first producer step fails and we can assert the failure surfaces as a
 * catchable error rather than a process exit.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MODULE = path.resolve(__dirname, '../../scripts/build-platform-package.cjs');

/**
 * Run a snippet in a fresh Node process with spawnSync stubbed to fail.
 * `stubStatus` lets each case pick the failure shape.
 */
function runIsolated(body, { stubStatus = 2, stubError } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-producer-'));
  // A real file with a .tar.gz name satisfies the artifact PRECONDITION without
  // ever being extracted: the stubbed spawn fails first, which is the point.
  const artifact = path.join(dir, 'stub-runtime.tar.gz');
  fs.writeFileSync(artifact, 'stub');
  const harness = path.join(dir, 'harness.cjs');
  fs.writeFileSync(harness, `
'use strict';
const childProcess = require('node:child_process');
const realSpawnSync = childProcess.spawnSync;
const stub = { status: ${stubStatus}, signal: null, stdout: '', stderr: ''${stubError ? `, error: Object.assign(new Error('${stubError}'), { code: 'ENOENT' })` : ''} };
childProcess.spawnSync = (...args) => {
  // Record that the producer actually tried to spawn a child.
  (globalThis.__spawnCalls = globalThis.__spawnCalls || []).push([args[0], Array.isArray(args[1]) ? args[1] : []]);
  return stub;
};
void realSpawnSync;
${body}
`);
  const result = spawnSync(process.execPath, [harness], { encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, __ARTIFACT__: artifact } });
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

test('an imported producer child failure is catchable and the caller finally still runs', () => {
  const result = runIsolated(`
const { buildPlatformPackage } = require(${JSON.stringify(MODULE)});
let caught;
let finallyRan = false;
(async () => {
  try {
    await buildPlatformPackage('current', {
      stageDir: require('node:path').join(process.cwd(), '.test-data', 'm2-stage'),
      qleverRuntimeArtifactPath: process.env.__ARTIFACT__,
    });
  } catch (error) {
    caught = error;
  } finally {
    finallyRan = true;
  }
  process.stdout.write(JSON.stringify({
    caught: !!caught,
    message: caught && caught.message ? caught.message : null,
    isError: caught instanceof Error,
    finallyRan,
    spawnAttempted: (globalThis.__spawnCalls || []).length > 0,
  }));
})();
`);
  assert.equal(result.status, 0, `harness should complete normally, got ${result.status}: ${result.stderr}`);
  const observed = JSON.parse(result.stdout);
  // The failure must arrive as a REJECTION (not a process exit), so finally runs.
  assert.equal(observed.caught, true, 'producer failure must be catchable');
  assert.equal(observed.isError, true, 'the rejection is a real Error');
  assert.equal(observed.finallyRan, true, "the caller's finally must execute");
  assert.equal(observed.spawnAttempted, true, 'the producer really attempted a child spawn');
  assert.match(String(observed.message), /failed with status|ENOENT/i);
});

test('the module no longer exits the process on a producer child failure', () => {
  // If run() still called process.exit, the harness would die with the stub's
  // status instead of reaching the catch/finally and printing JSON.
  const result = runIsolated(`
const { buildPlatformPackage } = require(${JSON.stringify(MODULE)});
process.stdout.write('BEFORE\\n');
buildPlatformPackage('current', {
  stageDir: require('node:path').join(process.cwd(), '.test-data', 'm2-stage2'),
  qleverRuntimeArtifactPath: process.env.__ARTIFACT__,
})
  .then(() => { process.stdout.write('RESOLVED\\n'); })
  .catch(() => { process.stdout.write('REJECTED\\n'); });
`);
  assert.equal(result.status, 0, `must not exit with the child status (got ${result.status})`);
  assert.match(result.stdout, /BEFORE/);
  assert.match(result.stdout, /REJECTED/, 'the promise must reject instead of exiting');
});

test('the CLI entry point still fails the process on a producer child failure', () => {
  // Run the REAL script as the main module (so require.main === module), with a
  // require-hook that stubs child_process.spawnSync to fail. The CLI branch must
  // turn the thrown producer failure into a non-zero exit.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-cli-'));
  const artifact = path.join(dir, 'stub-runtime.tar.gz');
  fs.writeFileSync(artifact, 'stub');
  const preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, `
'use strict';
const childProcess = require('node:child_process');
childProcess.spawnSync = () => ({ status: 3, signal: null, stdout: '', stderr: '' });
`);
  const result = spawnSync(process.execPath, ['-r', preload, MODULE,
    '--target', 'current',
    '--stage-dir', path.join(dir, 'stage'),
    '--qlever-runtime-artifact', artifact], { encoding: 'utf8', timeout: 60_000 });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.notEqual(result.status, 0, 'CLI must exit non-zero when the producer child fails');
});
