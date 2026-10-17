const path = require('node:path');
const { Worker } = require('node:worker_threads');
const OUTPUT_LIMIT = 8 * 1024 * 1024;
/** Mounted-consumer-only launch bridge; no command rewriting or fallback. */
function runMountedCommand({ command, args, cwd, env, timeoutMs, waitBudgetMs = timeoutMs + 15000, onEvent }, createWorker = (file, data) => new Worker(file, { workerData: data })) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(waitBudgetMs) || waitBudgetMs < timeoutMs) throw new Error('Invalid mounted command budget');
  const started = performance.now();
  return new Promise(resolve => {
    const channels = [[], []], bytes = [0, 0], errors = [];
    let worker, settled = false, timeoutObserved = false, launchState = 'not-observed', pid, closeFact, workerExit = null, launchError, outputComplete = true;
    let deadline, waitDeadline;
    const elapsed = () => Math.round((performance.now() - started) * 1000) / 1000;
    const event = row => { try { onEvent?.({ ...row, elapsedMs: elapsed() }); } catch (error) { errors.push({ message: error.message, source: 'observer' }); } };
    const stop = () => { try { worker?.postMessage({ type: 'kill' }); } catch (error) { errors.push({ message: error.message, source: 'control' }); } };
    const finish = () => {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(waitDeadline);
      // A Worker exit alone is never evidence of the child's exit, pipe EOF or close.
      const closed = launchState === 'returned' && Number.isInteger(pid) && pid > 0 && closeFact?.pid === pid && workerExit === 0 && closeFact?.exitObserved && closeFact.eof.every(Boolean) && !closeFact.spawnError && outputComplete && errors.length === 0;
      const state = closed ? 'closed' : closeFact?.spawnError && workerExit === 0 ? 'spawn-error' : 'pending';
      resolve({ state, actualExit: closed ? closeFact.code : null, status: closed ? closeFact.code ?? 1 : 1,
        stdout: Buffer.concat(channels[0]).toString('utf8'), stderr: Buffer.concat(channels[1]).toString('utf8'),
        signal: closed ? closeFact.signal : null, pid,
        workerFacts: { launchState, launchError: launchError ?? null, workerExit, actualWait: closeFact?.exitObserved === true,
          childCloseObserved: Boolean(closeFact), observedChildExit: closeFact?.code ?? null, observedChildSignal: closeFact?.signal ?? null, pipeEOF: closeFact?.eof ?? [false, false], timeoutObserved,
          elapsedMs: elapsed(), timeoutMs, waitBudgetMs, outputComplete, bytes: [...bytes], errors: [...errors], descendantClosureVerified: false },
      });
      if (workerExit === null) worker?.unref(); // Unknown remains unknown; do not erase its scene or invent closure.
    };
    // Start budgets before Worker creation and synchronous OS launch, on the server thread.
    deadline = setTimeout(() => { timeoutObserved = true; event({ type: 'deadline' }); stop(); }, timeoutMs);
    waitDeadline = setTimeout(finish, waitBudgetMs);
    try { worker = createWorker(path.join(__dirname, 'mountedCommandWorkerThread.cjs'), { command, args, cwd, env }); }
    catch (error) { launchError = { message: error.message, code: error.code }; errors.push({ ...launchError, source: 'worker-start' }); finish(); return; }
    worker.on('message', row => {
      if (row.type === 'launch-returned') { launchState = 'returned'; pid = row.pid ?? undefined; if (timeoutObserved) stop(); event(row); }
      else if (row.type === 'launch-threw') { launchState = 'threw'; launchError = row.error; event(row); }
      else if (row.type === 'output') {
        const value = Buffer.from(row.bytes), retained = value.subarray(0, Math.max(0, OUTPUT_LIMIT - bytes[row.index]));
        bytes[row.index] += retained.length; channels[row.index].push(retained);
        if (retained.length !== value.length) { outputComplete = false; stop(); }
      } else if (row.type === 'close') { closeFact = row; event(row); }
      else if (row.type === 'pipe-error' || row.type === 'control-error') { errors.push({ ...row.error, source: row.type }); event(row); }
      else if (row.type === 'spawn-error') { launchError = row.error; event(row); }
      else event(row);
    });
    worker.once('error', error => { errors.push({ message: error.message, code: error.code, source: 'worker' }); event({ type: 'worker-error' }); });
    worker.once('exit', value => { workerExit = value; event({ type: 'worker-exit', code: value }); finish(); });
  });
}
module.exports = { runMountedCommand, OUTPUT_LIMIT };
