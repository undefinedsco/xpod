const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const errorValue = error => ({ name: error.name, message: error.message, code: error.code, errno: error.errno, syscall: error.syscall });
let child, exited = false, spawnError, code = null, signal = null;
const eof = [false, false];
parentPort.on('message', row => {
  if (row?.type === 'kill' && child && !exited) {
    try { child.kill('SIGKILL'); } catch (error) { parentPort.postMessage({ type: 'control-error', error: errorValue(error) }); }
  }
});
try {
  // This synchronous OS launch must not block the Pod HTTP server's thread.
  // cwd/argv/env and process-group membership are the original command's.
  child = spawn(workerData.command, workerData.args, { cwd: workerData.cwd, env: workerData.env, stdio: ['ignore', 'pipe', 'pipe'] });
  parentPort.postMessage({ type: 'launch-returned', pid: child.pid ?? null });
  for (const [index, stream] of [child.stdout, child.stderr].entries()) {
    stream.on('data', bytes => parentPort.postMessage({ type: 'output', index, bytes }));
    stream.once('end', () => { eof[index] = true; });
    stream.once('error', error => parentPort.postMessage({ type: 'pipe-error', index, error: errorValue(error) }));
  }
  child.once('error', error => { spawnError = errorValue(error); parentPort.postMessage({ type: 'spawn-error', error: spawnError }); });
  child.once('exit', (value, why) => { exited = true; code = value; signal = why; parentPort.postMessage({ type: 'exit', code, signal }); });
  child.once('close', () => {
    parentPort.postMessage({ type: 'close', pid: child.pid ?? null, exitObserved: exited, code, signal, eof, spawnError });
    parentPort.close();
  });
} catch (error) {
  parentPort.postMessage({ type: 'launch-threw', error: errorValue(error) });
  parentPort.close();
}
