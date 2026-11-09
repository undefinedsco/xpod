const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
/** ESRCH alone proves absence. Releasing our pipes never counts as child close. */
async function runOwnedModeCommand(binary, args, { cwd, env, timeoutMs, outputBytes, signal: cancellation, terminationGraceMs = 1000, finalObservationMs = terminationGraceMs + 3000, input }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000 || !Number.isSafeInteger(outputBytes) || outputBytes < 1 || outputBytes > 4194304 || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1000 || terminationGraceMs > 10000 || !Number.isSafeInteger(finalObservationMs) || finalObservationMs < terminationGraceMs + 1000 || finalObservationMs > 15000) throw new Error('Invalid owned command budget');
  const inputSupplied = input !== undefined;
  if (inputSupplied && (!Buffer.isBuffer(input) || input.length > 4194304)) throw new Error('Invalid owned command input');
  // Defensive copy before spawn; the caller reserves/charges this copy on the
  // same parent budget. Caller mutation after this point cannot alter delivery.
  const inputBytes = inputSupplied ? Buffer.from(input) : undefined;
  const started = Date.now(); const child = spawn(binary, args, { cwd, env, detached: true, stdio: [inputSupplied ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  const chunks = [[], []]; const sizes = [0, 0]; let forcedCleanup = false; let cancelled = false; let timedOut = false; let outputTruncated = false; let spawnFailed = false; let ownershipUnknown = false;
  let inputError = null; let inputEnded = false; let inputEndSucceeded = false;
  if (inputSupplied) {
    // Attach before any write so a fast EPIPE/error is never uncaught.
    child.stdin.on('error', error => { inputError ??= error?.code || error?.message || 'stdin-error'; inputEnded = true; });
    child.stdin.on('close', () => { inputEnded = true; });
  }
  let actualExit; child.once('exit', (code, signal) => { actualExit = { code, signal }; });
  let escalation; let finalTimer; let finalResolve;
  const finalObservation = new Promise(resolve => { finalResolve = resolve; });
  const signal = name => { if (child.pid) try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') ownershipUnknown = true; } };
  const abort = () => {
    signal('SIGTERM'); escalation ??= setTimeout(() => signal('SIGKILL'), terminationGraceMs);
    finalTimer ??= setTimeout(() => finalResolve({ closeObserved: false }), finalObservationMs);
  };
  const receive = (chunk, index) => {
    sizes[index] += chunk.length;
    if (sizes[index] > outputBytes) { outputTruncated = true; abort(); } else chunks[index].push(Buffer.from(chunk));
  };
  [child.stdout, child.stderr].forEach((stream, index) => {
    if (!inputSupplied) { stream.on('data', chunk => receive(chunk, index)); return; }
    // Input callers reserve one overflow-probe byte per stream. Pull bounded
    // logical reads rather than accepting an arbitrarily large data event.
    stream.on('readable', () => {
      while (!outputTruncated && !stream.destroyed) {
        const chunk = stream.read(Math.min(65536, outputBytes + 1 - sizes[index]));
        if (chunk === null) break;
        receive(chunk, index);
      }
      if (outputTruncated) { child.stdout.destroy(); child.stderr.destroy(); }
    });
  });
  child.once('error', () => { spawnFailed = true; });
  const close = new Promise(resolve => child.once('close', () => resolve({ closeObserved: true })));
  const cancel = () => { cancelled = true; abort(); };
  cancellation?.addEventListener('abort', cancel, { once: true }); if (cancellation?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  // Deliver only after every exit/error/close/cancel listener and the timeout
  // are installed. A pre-aborted caller never obtains successful delivery.
  if (inputSupplied) {
    if (cancellation?.aborted) { inputError ??= 'cancelled-before-input'; child.stdin.destroy(); }
    else try { child.stdin.end(inputBytes, error => { inputEnded = true; if (error) inputError ??= error?.code || 'stdin-end-error'; else if (!inputError) inputEndSucceeded = true; }); } catch (error) { inputError ??= error?.code || 'stdin-write-error'; inputEnded = true; child.stdin.destroy(); abort(); }
  }
  const observed = await Promise.race([close, finalObservation]);
  clearTimeout(timer); clearTimeout(escalation); clearTimeout(finalTimer); cancellation?.removeEventListener('abort', cancel);
  if (inputSupplied && !inputEnded) {
    // No reader consumed the complete payload (for example an early exit).
    inputError ??= 'input-not-consumed';
    child.stdin.destroy();
  }
  // A detached descendant may keep inherited pipes open after the direct child exited.
  // Freeze the negative observation before destroying only our reader handles.
  if (!observed.closeObserved) { ownershipUnknown = true; signal('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
  const absent = () => { if (!child.pid) return spawnFailed; try { process.kill(-child.pid, 0); return false; } catch (e) { if (e.code === 'ESRCH') return true; ownershipUnknown = true; return false; } };
  if (!absent()) {
    forcedCleanup = true; signal('SIGTERM');
    for (let n = 0; n < 40 && !absent(); n++) await new Promise(resolve => setTimeout(resolve, 25));
    if (!absent()) signal('SIGKILL');
    for (let n = 0; n < 40 && !absent(); n++) await new Promise(resolve => setTimeout(resolve, 25));
  }
  const groupAbsent = absent(); const raw = chunks.map(parts => Buffer.concat(parts));
  if (inputSupplied && !inputEndSucceeded) inputError ??= 'input-incomplete';
  const inputDelivered = inputSupplied ? inputEndSucceeded && !inputError : undefined;
  const eligible = observed.closeObserved && groupAbsent && !ownershipUnknown && (!inputSupplied || inputDelivered);
  const record = { timeoutMs, terminationGraceMs, finalObservationMs, code: actualExit?.code ?? null, signal: actualExit?.signal ?? null, exitObserved: !!actualExit, waitKnown: !!actualExit, closeObserved: observed.closeObserved, groupAbsent, timedOut, cancelled, forcedCleanup, outputTruncated, spawnFailed, ownershipUnknown, rawEligible: eligible, elapsedMs: Date.now() - started,
    stdoutSHA256: eligible ? hash(raw[0]) : null, stderrSHA256: eligible ? hash(raw[1]) : null };
  if (inputSupplied) { record.inputBytes = inputBytes.length; record.inputDelivered = !!inputDelivered; record.inputFailure = inputError ?? null;
    record.receivedStdoutBytes = sizes[0]; record.receivedStderrBytes = sizes[1]; }
  return { stdout: raw[0], stderr: raw[1], record };
}
module.exports = { runOwnedModeCommand };
