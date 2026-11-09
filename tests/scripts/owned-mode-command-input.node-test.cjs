'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {mkdtemp, mkdir, rm} = require('node:fs/promises');
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
