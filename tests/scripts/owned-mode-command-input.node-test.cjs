'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {mkdtemp, mkdir, rm} = require('node:fs/promises');
const {existsSync} = require('node:fs');
const {join} = require('node:path');
const {runOwnedModeCommand} = require('../../scripts/lib/owned-mode-command.cjs');

const NODE = process.execPath;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const base = () => ({cwd: process.cwd(), env: {...process.env}, timeoutMs: 10000, outputBytes: 4194304, terminationGraceMs: 1000});

test('complete binary stdin is echoed and defensively snapshotted', async () => {
  const input = Buffer.from([0x00, 0xff, 0x01, 0x80, 0x7f]);
  const result = runOwnedModeCommand(NODE, ['-e', 'const c=[];process.stdin.on("data",b=>c.push(b));process.stdin.on("end",()=>process.stdout.write(Buffer.concat(c)));'], {...base(), input});
  input.fill(0x41); // caller mutation immediately after start must not alter the copy
  const done = await result;
  assert.equal(done.record.rawEligible, true);
  assert.equal(done.record.inputDelivered, true);
  assert.equal(done.record.inputBytes, 5);
  assert.deepEqual(done.stdout, Buffer.from([0x00, 0xff, 0x01, 0x80, 0x7f]));
  assert.equal(done.record.stdoutSHA256, hash(done.stdout));
});

test('invalid type and oversize input reject before spawn', async () => {
  for (const input of ['text', 12, {}, Buffer.alloc(4194305)]) {
    await assert.rejects(runOwnedModeCommand(NODE, ['-e', 'process.exit(0)'], {...base(), input}), /Invalid owned command input/);
  }
});

test('child exit 0 without consuming input is a delivery failure', async () => {
  const result = await runOwnedModeCommand(NODE, ['-e', 'process.exit(0)'], {...base(), input: Buffer.alloc(2 * 1024 ** 2, 0x61)});
  assert.equal(result.record.code, 0);
  assert.equal(result.record.rawEligible, false);
  assert.ok(result.record.inputFailure);
});

test('pre-aborted signal never yields successful delivery or eligibility', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runOwnedModeCommand(NODE, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'], {...base(), input: Buffer.from('data'), signal: controller.signal});
  assert.equal(result.record.cancelled, true);
  assert.equal(result.record.rawEligible, false);
  assert.notEqual(result.record.inputFailure, null);
});

test('descendant holding stdin/stdio after parent exit is torn down and observed absent', async () => {
  const parent=join(process.cwd(),'.test-data','owned-mode-input'); await mkdir(parent,{recursive:true});
  const directory = await mkdtemp(join(parent, 'case-'));
  try {
    const pidFile = join(directory, 'descendant.pid');
    const script = [
      'const {spawn}=require("node:child_process");',
      'const fs=require("node:fs");',
      `const c=spawn(${JSON.stringify(NODE)},["-e","process.stdin.resume();setInterval(()=>{},1000)"],{detached:false,stdio:"inherit"});`,
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));`,
      'process.exit(0);',
    ].join('');
    const startedAt = Date.now();
    const result = await runOwnedModeCommand(NODE, ['-e', script], {...base(), timeoutMs: 1200, finalObservationMs: 4000, input: Buffer.from('held')});
    const pid = Number(require('node:fs').readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    let alive = true;
    for (let attempt = 0; attempt < 120 && alive; attempt++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(alive, false, 'descendant process must be absent');
    assert.equal(result.record.timedOut, true);
    assert.equal(result.record.groupAbsent, true);
    assert.equal(result.record.closeObserved, true);
    assert.ok(Date.now() - startedAt < 15000);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('without input the existing record shape and behavior are preserved', async () => {
  const result = await runOwnedModeCommand(NODE, ['-e', 'process.stdout.write("ok")'], base());
  assert.equal(result.record.rawEligible, true);
  assert.equal(result.stdout.toString(), 'ok');
  for (const key of ['inputBytes', 'inputDelivered', 'inputFailure']) assert.equal(Object.hasOwn(result.record, key), false);
});

// The exact owned-command gate the mode matrix applies (accept-service-image-modes.ts command()).
const commandGate = row => Boolean(row.closeObserved && row.exitObserved && row.rawEligible && !row.forcedCleanup
  && !row.cancelled && !row.spawnFailed && !row.ownershipUnknown && !row.outputTruncated && !row.timedOut
  && row.code === 0 && !row.signal && row.groupAbsent);

test('a short-lived same-group descendant drains naturally: no forced signal, gate passes', async () => {
  const parent = join(process.cwd(), '.test-data', 'owned-mode-input');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'drain-'));
  try {
    const pidFile = join(directory, 'descendant.pid');
    const signalFile = join(directory, 'descendant.signalled');
    const readyFile = join(directory, 'descendant.ready');
    // Same process group, no stdio inheritance. It records any catchable
    // termination signal (SIGKILL cannot be caught, so it is not claimed),
    // announces readiness, then exits on its own after 300ms.
    const childScript = [
      'const fs=require("node:fs");',
      'for (const name of ["SIGTERM","SIGINT","SIGQUIT"]) { try { process.on(name, () => { fs.writeFileSync(process.env.SIGNAL_FILE, name); process.exit(0); }); } catch {} }',
      'fs.writeFileSync(process.env.READY_FILE, "ready");',
      'setTimeout(() => process.exit(0), 300);',
    ].join('');
    // The parent starts the descendant's own lifetime only after it is ready,
    // using a bounded async poll rather than a busy loop or a fixed sleep, and
    // fails loudly if readiness never arrives.
    const script = [
      'const {spawn}=require("node:child_process");',
      'const fs=require("node:fs");',
      `const c=spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{detached:false,stdio:"ignore",env:{...process.env,SIGNAL_FILE:${JSON.stringify(signalFile)},READY_FILE:${JSON.stringify(readyFile)}}});`,
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));`,
      '(async()=>{',
      `  const deadline=Date.now()+5000;`,
      `  while(!fs.existsSync(${JSON.stringify(readyFile)})&&Date.now()<deadline) await new Promise(r=>setTimeout(r,20));`,
      `  if(!fs.existsSync(${JSON.stringify(readyFile)})) { process.stderr.write("descendant never became ready"); process.exit(3); }`,
      '  process.stdout.write("parent-ok");',
      '  process.exit(0);',
      '})();',
    ].join('\n');
    const startedAt = Date.now();
    const result = await runOwnedModeCommand(NODE, ['-e', script], base());
    const elapsed = Date.now() - startedAt;
    assert.equal(result.record.code, 0);
    assert.equal(result.record.signal, null);
    assert.equal(result.record.timedOut, false);
    assert.equal(result.record.groupAbsent, true, 'group must be gone by its own exit');
    assert.equal(result.record.forcedCleanup, false, 'no forced signal may be recorded');
    assert.equal(existsSync(signalFile), false, 'the descendant must never receive a catchable termination signal');
    assert.equal(commandGate(result.record), true, 'the unchanged matrix gate must accept this record');
    assert.equal(result.stdout.toString(), 'parent-ok');
    assert.equal(existsSync(pidFile), true);
    // The natural drain is bounded by the supplied grace only.
    assert.ok(elapsed < 10000, `drain must stay inside the supplied grace, took ${elapsed}ms`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a permanently lingering same-group leak still fails closed: forced signal, gate rejects, process cleaned', async () => {
  const parent = join(process.cwd(), '.test-data', 'owned-mode-input');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'leak-'));
  try {
    const pidFile = join(directory, 'descendant.pid');
    const childScript = [
      'process.on("SIGTERM", () => {});', // ignore graceful termination: only SIGKILL ends it
      'setInterval(() => {}, 1000);',
    ].join('');
    const script = [
      'const {spawn}=require("node:child_process");',
      'const fs=require("node:fs");',
      `const c=spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{detached:false,stdio:"ignore"});`,
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));`,
      'process.exit(0);',
    ].join('');
    const result = await runOwnedModeCommand(NODE, ['-e', script], {...base(), terminationGraceMs: 1000});
    const pid = Number(require('node:fs').readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.equal(result.record.code, 0);
    assert.equal(result.record.timedOut, false);
    assert.equal(result.record.groupAbsent, true, 'the leak must actually be cleaned');
    assert.equal(result.record.forcedCleanup, true, 'a real leak must keep reporting the forced cleanup');
    assert.equal(commandGate(result.record), false, 'the unchanged matrix gate must reject a forced cleanup');
    let alive = true;
    for (let attempt = 0; attempt < 120 && alive; attempt++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(alive, false, 'leaked descendant must be gone');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failing direct child does not get the natural drain: immediate forced cleanup', async () => {
  const parent = join(process.cwd(), '.test-data', 'owned-mode-input');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'fail-'));
  try {
    const pidFile = join(directory, 'descendant.pid');
    const childScript = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
    const script = [
      'const {spawn}=require("node:child_process");',
      'const fs=require("node:fs");',
      `const c=spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{detached:false,stdio:"ignore"});`,
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));`,
      'process.exit(7);', // a failed command must never receive the success-only wait
    ].join('');
    const startedAt = Date.now();
    const result = await runOwnedModeCommand(NODE, ['-e', script], {...base(), terminationGraceMs: 8000});
    const elapsed = Date.now() - startedAt;
    const pid = Number(require('node:fs').readFileSync(pidFile, 'utf8'));
    assert.equal(result.record.code, 7);
    assert.equal(result.record.groupAbsent, true);
    assert.equal(result.record.forcedCleanup, true);
    assert.equal(commandGate(result.record), false);
    // The 8000ms grace must NOT have been spent waiting for a failed command.
    assert.ok(elapsed < 4000, `failed command must escalate immediately, took ${elapsed}ms`);
    let alive = true;
    for (let attempt = 0; attempt < 120 && alive; attempt++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(alive, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancellation after the direct parent really exited is not lost during the natural drain', async () => {
  const parent = join(process.cwd(), '.test-data', 'owned-mode-input');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'cancel-'));
  try {
    const parentPidFile = join(directory, 'parent.pid');
    const pidFile = join(directory, 'descendant.pid');
    const readyFile = join(directory, 'descendant.ready');
    // The descendant ignores SIGTERM, so cleanup must reach SIGKILL.
    const childScript = 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.env.READY_FILE, "ready"); setInterval(() => {}, 1000);';
    const script = [
      'const {spawn}=require("node:child_process");',
      'const fs=require("node:fs");',
      `const c=spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{detached:false,stdio:"ignore",env:{...process.env,READY_FILE:${JSON.stringify(readyFile)}}});`,
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));`,
      `fs.writeFileSync(${JSON.stringify(parentPidFile)},String(process.pid));`,
      '(async()=>{',
      '  const deadline=Date.now()+5000;',
      `  while(!fs.existsSync(${JSON.stringify(readyFile)})&&Date.now()<deadline) await new Promise(r=>setTimeout(r,20));`,
      `  if(!fs.existsSync(${JSON.stringify(readyFile)})) process.exit(3);`,
      '  process.stdout.write("parent-ok");',
      '  process.exit(0);',
      '})();',
    ].join('\n');
    const controller = new AbortController();
    const running = runOwnedModeCommand(NODE, ['-e', script],
      {...base(), terminationGraceMs: 8000, signal: controller.signal});
    // Observe the REAL direct-parent exit (ESRCH on its own PID); a marker alone
    // would not prove the parent was gone before the abort.
    const parentPid = await waitForPidFile(parentPidFile);
    const deadline = Date.now() + 5000;
    let parentAlive = true;
    while (parentAlive && Date.now() < deadline) {
      try { process.kill(parentPid, 0); } catch (error) { if (error.code === 'ESRCH') parentAlive = false; else throw error; }
      if (parentAlive) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(parentAlive, false, 'the direct parent must be provably gone before the abort');
    const descendantPid = Number(require('node:fs').readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    assert.doesNotThrow(() => process.kill(descendantPid, 0), 'descendant must still be alive inside the drain window');
    controller.abort();
    const result = await running;
    assert.equal(result.record.cancelled, true, 'the cancellation must be observed, not dropped during the drain');
    assert.equal(result.record.groupAbsent, true, 'the group must be cleaned after cancellation');
    assert.equal(result.record.forcedCleanup, true, 'a cancelled run still reports forced cleanup');
    assert.equal(commandGate(result.record), false, 'the unchanged matrix gate must reject a cancelled run');
    let alive = true;
    for (let attempt = 0; attempt < 120 && alive; attempt++) {
      try { process.kill(descendantPid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(alive, false, 'descendant must be cleaned after cancellation');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForPidFile(file) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const value = Number(require('node:fs').readFileSync(file, 'utf8'));
      if (Number.isSafeInteger(value) && value > 1) return value;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`PID file did not appear: ${file}`);
}
