const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
/** ESRCH alone proves absence. Releasing our pipes never counts as child close. */
async function runOwnedModeCommand(binary, args, { cwd, env, timeoutMs, outputBytes, signal: cancellation, terminationGraceMs = 1000, finalObservationMs = terminationGraceMs + 3000 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000 || !Number.isSafeInteger(outputBytes) || outputBytes < 1 || outputBytes > 4194304 || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1000 || terminationGraceMs > 10000 || !Number.isSafeInteger(finalObservationMs) || finalObservationMs < terminationGraceMs + 1000 || finalObservationMs > 15000) throw new Error('Invalid owned command budget');
  const started = Date.now(); const child = spawn(binary, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [[], []]; const sizes = [0, 0]; let forcedCleanup = false; let cancelled = false; let timedOut = false; let outputTruncated = false; let spawnFailed = false; let ownershipUnknown = false;
  let actualExit; child.once('exit', (code, signal) => { actualExit = { code, signal }; });
  let escalation; let finalTimer; let finalResolve;
  const finalObservation = new Promise(resolve => { finalResolve = resolve; });
  const signal = name => { if (child.pid) try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') ownershipUnknown = true; } };
  const abort = () => {
    signal('SIGTERM'); escalation ??= setTimeout(() => signal('SIGKILL'), terminationGraceMs);
    finalTimer ??= setTimeout(() => finalResolve({ closeObserved: false }), finalObservationMs);
  };
  [child.stdout, child.stderr].forEach((stream, index) => stream.on('data', chunk => {
    sizes[index] += chunk.length;
    if (sizes[index] > outputBytes) { outputTruncated = true; abort(); } else chunks[index].push(Buffer.from(chunk));
  }));
  child.once('error', () => { spawnFailed = true; });
  const close = new Promise(resolve => child.once('close', () => resolve({ closeObserved: true })));
  const cancel = () => { cancelled = true; abort(); };
  cancellation?.addEventListener('abort', cancel, { once: true }); if (cancellation?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  const observed = await Promise.race([close, finalObservation]);
  clearTimeout(timer); clearTimeout(escalation); clearTimeout(finalTimer); cancellation?.removeEventListener('abort', cancel);
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
  const eligible = observed.closeObserved && groupAbsent && !ownershipUnknown;
  return { stdout: raw[0], stderr: raw[1], record: { timeoutMs, terminationGraceMs, finalObservationMs, code: actualExit?.code ?? null, signal: actualExit?.signal ?? null, exitObserved: !!actualExit, waitKnown: !!actualExit, closeObserved: observed.closeObserved, groupAbsent, timedOut, cancelled, forcedCleanup, outputTruncated, spawnFailed, ownershipUnknown, rawEligible: eligible, elapsedMs: Date.now() - started,
    stdoutSHA256: eligible ? hash(raw[0]) : null, stderrSHA256: eligible ? hash(raw[1]) : null } };
}
module.exports = { runOwnedModeCommand };
