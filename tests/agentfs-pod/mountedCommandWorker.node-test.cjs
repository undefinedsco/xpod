const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const { runMountedCommand } = require('./support/mountedCommandWorker.cjs');
const parent = path.resolve('.test-data/mounted-worker'); fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, 'evidence-'));
console.log(JSON.stringify({ evidenceRoot: root }));
const save = (name, value) => fs.writeFileSync(path.join(root, name + '.json'), JSON.stringify(value, null, 2) + '\n');
const options = extra => ({ command: process.execPath, args: ['-e', ''], cwd: root, env: { ...process.env }, timeoutMs: 2000, ...extra });
const bootstrap = code => (file, data) => new Worker(code + '\nrequire(' + JSON.stringify(file) + ')', { eval: true, workerData: data });

test('synchronous prelaunch blocks inline loopback but owned worker keeps the same HTTP server responsive', async () => {
  let workerRequests = 0, heartbeats = 0;
  const server = http.createServer((req, res) => { if (req.url === '/worker') workerRequests++; setTimeout(() => res.end('served'), 50); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  const heartbeat = setInterval(() => heartbeats++, 5);
  try {
    const control = spawnSync('/usr/bin/curl', ['--silent', '--max-time', '0.2', url + '/inline'], { encoding: 'utf8', timeout: 1000 });
    assert.equal(control.status, 28); // Main-thread synchronous launch cannot serve its own callback.
    const before = heartbeats;
    const script = "process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1),marker:process.env.WORKER_TEST_MARKER,removed:process.env.WORKER_TEST_REMOVE??null}));process.stderr.write('exact-stderr')";
    const result = await runMountedCommand(options({ args: ['-e', script, 'original-argv'], env: { ...process.env, WORKER_TEST_MARKER: 'original-env', WORKER_TEST_REMOVE: undefined } }), bootstrap(`
const cp=require('node:child_process'), original=cp.spawn;
cp.spawn=(...args)=>{const probe=cp.spawnSync('/usr/bin/curl',['--silent','--max-time','1',${JSON.stringify(url + '/worker')}],{timeout:1500});if(probe.status!==0)throw Object.assign(Error('prelaunch-loopback-timeout'),{code:'ETIMEDOUT'});return original(...args)};`));
    assert.equal(result.state, 'closed'); assert.equal(result.actualExit, 0); assert.equal(workerRequests, 1); assert.ok(heartbeats > before);
    assert.deepEqual(JSON.parse(result.stdout), { cwd: root, args: ['original-argv'], marker: 'original-env', removed: null });
    assert.equal(result.stderr, 'exact-stderr'); assert.ok(result.pid > 0); assert.equal(result.workerFacts.actualWait, true);
    assert.equal(result.workerFacts.childCloseObserved, true); assert.deepEqual(result.workerFacts.pipeEOF, [true, true]); assert.equal(result.workerFacts.workerExit, 0);
    save('loopback-comparison', { inline: { code: control.status, signal: control.signal }, workerRequests, heartbeatsDuringWorker: heartbeats - before, result, scope: 'Real loopback with simulated synchronous prelaunch; no actual NFS mount or proof of the remote failure cause.' });
  } finally { clearInterval(heartbeat); await new Promise(resolve => server.close(resolve)); }
});
test('synchronous launch throw preserves original errno without inventing a child close', async () => {
  const result = await runMountedCommand(options(), bootstrap("require('node:child_process').spawn=()=>{throw Object.assign(Error('spawn ETIMEDOUT'),{code:'ETIMEDOUT',errno:-60,syscall:'spawn'})}"));
  assert.equal(result.state, 'pending'); assert.equal(result.workerFacts.launchState, 'threw');
  assert.equal(result.workerFacts.launchError.code, 'ETIMEDOUT'); assert.equal(result.workerFacts.launchError.errno, -60);
  assert.equal(result.workerFacts.actualWait, false); assert.equal(result.workerFacts.childCloseObserved, false); assert.equal(result.pid, undefined);
  save('launch-threw', result);
});
test('nonzero child exit retains stdout/stderr, wait/close and both EOF observations', async () => {
  const result = await runMountedCommand(options({ args: ['-e', "process.stdout.write('original-out');process.stderr.write('original-err');process.exitCode=7"] }));
  assert.equal(result.state, 'closed'); assert.equal(result.actualExit, 7); assert.equal(result.stdout, 'original-out'); assert.equal(result.stderr, 'original-err');
  assert.equal(result.workerFacts.actualWait, true); assert.equal(result.workerFacts.childCloseObserved, true); assert.deepEqual(result.workerFacts.pipeEOF, [true, true]); save('exit7', result);
});
test('deadline includes worker startup and actual child kill/close stays explicit', async () => {
  const result = await runMountedCommand(options({ args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 150, waitBudgetMs: 1000 }));
  assert.equal(result.workerFacts.timeoutObserved, true); assert.equal(result.state, 'closed'); assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.actualExit, null); assert.equal(result.workerFacts.actualWait, true); assert.equal(result.workerFacts.childCloseObserved, true); save('deadline', result);
});
test('late PID after expired wait budget is stopped, and earlier unknown snapshot never becomes accepted', async () => {
  let worker; const events = [];
  const factory = (file, data) => {
    worker = bootstrap('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);')(file, data);
    return worker;
  };
  const result = await runMountedCommand(options({ args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 30, waitBudgetMs: 80, onEvent: row => events.push(row) }), factory);
  assert.equal(result.state, 'pending'); assert.equal(result.pid, undefined); assert.equal(result.workerFacts.actualWait, false);
  await Promise.race([once(worker, 'exit'), new Promise((_, reject) => setTimeout(() => reject(Error('late worker did not close')), 1500))]);
  assert.ok(events.some(e => e.type === 'launch-returned' && e.pid > 0)); assert.ok(events.some(e => e.type === 'close'));
  assert.equal(result.workerFacts.actualWait, false); assert.equal(result.workerFacts.childCloseObserved, false); save('late-pid', { result, events });
});
test('worker fault or termination alone never proves a child close', async () => {
  const fault = await runMountedCommand(options(), () => new Worker("throw Error('worker-primary')", { eval: true }));
  assert.equal(fault.state, 'pending'); assert.equal(fault.workerFacts.actualWait, false); assert.equal(fault.workerFacts.childCloseObserved, false);
  assert.ok(fault.workerFacts.errors.some(e => /worker-primary/.test(e.message)));
  let worker;
  const unknown = await runMountedCommand(options({ timeoutMs: 30, waitBudgetMs: 80 }), () => worker = new Worker('setInterval(()=>{},1000)', { eval: true }));
  await worker.terminate();
  assert.equal(unknown.state, 'pending'); assert.equal(unknown.workerFacts.actualWait, false); assert.equal(unknown.workerFacts.childCloseObserved, false);
  save('worker-unknown', { fault, unknown });
});
test('child exit7 remains explicit when worker teardown adds a secondary failure', async () => {
  const factory = bootstrap("require('node:worker_threads').parentPort.close=()=>setImmediate(()=>{throw Error('worker-secondary')});");
  const result = await runMountedCommand(options({ args: ['-e', 'process.exitCode=7'] }), factory);
  assert.equal(result.state, 'pending'); assert.equal(result.workerFacts.observedChildExit, 7);
  assert.equal(result.workerFacts.actualWait, true); assert.equal(result.workerFacts.childCloseObserved, true);
  assert.ok(result.workerFacts.errors.some(e => /worker-secondary/.test(e.message))); save('child-primary-worker-secondary', result);
});
test('worker exit0 without an actual child launch/exit/EOF/close never becomes a closed command', async () => {
  const result = await runMountedCommand(options(), () => new Worker('', { eval: true }));
  assert.equal(result.state, 'pending'); assert.equal(result.workerFacts.workerExit, 0);
  assert.equal(result.workerFacts.actualWait, false); assert.equal(result.workerFacts.childCloseObserved, false); save('worker-only-exit0', result);
});
