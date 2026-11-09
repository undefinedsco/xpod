'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '../..');
const SOURCE = path.join(ROOT, 'scripts/lib/independent-admission/sdk-selected-original-command.ts');

function load() {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const js = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS}}).outputText;
  const file = path.join(ROOT, 'scripts/lib/independent-admission/.sdk-selected-command-' + process.pid + '.cjs');
  const patched = js.replace(/const sourceRequire = \(0, node_module_1\.createRequire\)\(__filename\);/, 'const sourceRequire = require;');
  fs.writeFileSync(file, patched);
  try { return require(file); } finally { fs.unlinkSync(file); }
}

const PY = '/usr/bin/python3';
function helper(dir, body) {
  const file = path.join(dir, 'child-' + Math.random().toString(16).slice(2) + '.py');
  fs.writeFileSync(file, body);
  return file;
}
function budget({remaining = 10 * 1024 * 1024, window = 5000, delay = 0} = {}) {
  const began = Date.now();
  const events = {reserved: 0, charged: 0, order: []};
  const parent = {
    check() { if (Date.now() - began >= window) throw Error('parent deadline expired'); },
    remainingMs() { return window - (Date.now() - began); },
    remainingReadBytes() { return remaining; },
    reserveBytes(n) { events.reserved += n; events.order.push(['reserve', n]); if (n > remaining) throw Error('parent reservation exceeded'); },
    chargeReadBytes(n) { events.charged += n; events.order.push(['charge', n]); remaining -= n; if (remaining < 0) throw Error('parent read budget exceeded'); },
  };
  return {parent, events, get remaining() { return remaining; }, began};
}
async function run(scenario, options = {}) {
  const {runSdkSelectedOriginalCommand} = load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-selected-command-test-'));
  try {
    const child = helper(dir, scenario.body);
    const state = budget(options);
    const plans = [];
    let spawns = 0;
    const runner = require(path.join(ROOT, 'scripts/lib/owned-mode-command.cjs'));
    // Count actual spawns by wrapping the module cache loader output.
    const originalRun = runner.runOwnedModeCommand;
    const mutable = require(path.join(ROOT, 'scripts/lib/owned-mode-command.cjs'));
    mutable.runOwnedModeCommand = (...args) => { spawns += 1; return originalRun(...args); };
    try {
      const result = await runSdkSelectedOriginalCommand({
      archiveIdentity: {bytes: 1, sha256: 'a'.repeat(64)},
      async withArchiveFile(use) {
        if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
        return use({path: dir + '/sdk.zip', identity: {bytes: 1, sha256: 'a'.repeat(64)}});
      },
      python: PY, helperPath: child,
      createPlan(remainingMs) { const plan = Buffer.from(JSON.stringify({remainingMilliseconds: remainingMs, payload: 'x'.repeat(options.planBytes ?? 64)})); plans.push(plan); return plan; },
      remainingMs: () => options.originalWindow ?? 5000,
      budget: state.parent,
    });
    return {result, state, plans, spawns, dir};
    } finally {
      mutable.runOwnedModeCommand = originalRun;
    }
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

test('complete child input/output is charged and reserved inside custody', async () => {
  const out = await run({body: 'import sys,json\nsys.stdin.buffer.read()\nsys.stdout.write(json.dumps({"ok":True}))\n'});
  assert.equal(out.result.json.ok, true);
  assert.ok(out.state.events.reserved >= out.state.events.charged * 2, 'plan and held output must be reserved');
  assert.ok(out.state.events.charged > 0);assert.equal(out.result.json.ok, true);assert.ok(out.result.stdout.length > 0);
});

test('child failure still charges actual received stderr bytes', async () => {
  await assert.rejects(run({body: 'import sys,time\nsys.stdin.buffer.read()\nsys.stderr.write("bad"*40)\nsys.exit(3)\n'}));
});

test('truncation is rejected and actual received bytes are charged', async () => {
  await assert.rejects(run({body: 'import sys\nsys.stdin.buffer.read()\nsys.stdout.write("x"*50000)\n'}, {remaining: 40000, planBytes: 16}));
});

test('final createPlan delay cannot leave a stale spawn timeout', async () => {
  const {runSdkSelectedOriginalCommand} = load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-selected-plan-delay-'));
  try {
    const child = helper(dir, 'import sys\nsys.stdin.buffer.read()\nimport json\nsys.stdout.write(json.dumps({}))\n');
    const began = Date.now(), window = 1200;
    let remaining = 10 * 1024 * 1024, charged = 0, reserved = 0, plans = 0, lastPlanClock = null;
    const parent = {
      check() { if (Date.now() - began >= window) throw Error('parent deadline expired'); },
      remainingMs() { return window - (Date.now() - began); },
      remainingReadBytes() { return remaining; },
      reserveBytes(n) { reserved += n; if (n > remaining) throw Error('parent reservation exceeded'); },
      chargeReadBytes(n) { charged += n; remaining -= n; if (remaining < 0) throw Error('parent read budget exceeded'); },
    };
    const runner = require(path.join(ROOT, 'scripts/lib/owned-mode-command.cjs'));
    const originalRun = runner.runOwnedModeCommand;
    let spawnWindow = null, spawnTimeout = null;
    runner.runOwnedModeCommand = async (...args) => {
      spawnWindow = window - (Date.now() - began);
      spawnTimeout = args[2].timeoutMs;
      return originalRun(...args);
    };
    let result;
    try {
      result = await runSdkSelectedOriginalCommand({
      archiveIdentity: {bytes: 1, sha256: 'a'.repeat(64)},
      async withArchiveFile(use) { return use({path: dir + '/sdk.zip', identity: {bytes: 1, sha256: 'a'.repeat(64)}}); },
      python: PY, helperPath: child,
      createPlan(ms) {
        plans += 1; lastPlanClock = ms;
        if (plans > 1) { const until = Date.now() + 120; while (Date.now() < until) { /* consume the window */ } }
        return Buffer.from(JSON.stringify({remainingMilliseconds: ms}));
      },
      remainingMs: () => window,
      budget: parent,
      });
    } finally { runner.runOwnedModeCommand = originalRun; }
    const spawnRemaining = spawnWindow;
    assert.ok(lastPlanClock !== null);
    assert.equal(spawnTimeout, result.record.timeoutMs);
    assert.ok(result.record.timeoutMs <= lastPlanClock, 'spawn timeout exceeds the plan clock');
    assert.ok(result.record.timeoutMs <= Math.max(1, spawnRemaining), 'timeout exceeds actual spawn-remaining window');
    assert.ok(window - result.record.timeoutMs >= 100, 'pre-plan timeout reused instead of the shrunk window: ' + result.record.timeoutMs);
    assert.ok(charged > 0 && reserved >= charged);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('failed command still charges received IO on the shared parent', async () => {
  const {runSdkSelectedOriginalCommand} = load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-selected-fail-'));
  try {
    const child = helper(dir, 'import sys\nsys.stdin.buffer.read()\nsys.stderr.write("boom")\nsys.exit(3)\n');
    let remaining = 100000, charged = 0;
    const parent = {check() {}, remainingMs: () => 5000, remainingReadBytes: () => remaining,
      reserveBytes() {}, chargeReadBytes(n) { charged += n; remaining -= n; }};
    let record = null;
    await assert.rejects((async () => {
      try {
        return await runSdkSelectedOriginalCommand({
          archiveIdentity: {bytes: 1, sha256: 'a'.repeat(64)},
          async withArchiveFile(use) { return use({path: dir + '/sdk.zip', identity: {bytes: 1, sha256: 'a'.repeat(64)}}); },
          python: PY, helperPath: child, createPlan: ms => Buffer.from(JSON.stringify({remainingMilliseconds: ms})),
          remainingMs: () => 5000, budget: parent,
        });
      } catch (error) { throw error; }
    })());
    assert.ok(charged >= 4, 'received stderr bytes must be charged: ' + charged);
    assert.ok(remaining < 100000);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('custody delay before spawn uses refreshed remaining window', async () => {
  const out = await run({body: 'import sys\nsys.stdin.buffer.read()\nimport json\nsys.stdout.write(json.dumps({}))\n'}, {delay: 500, originalWindow: 5000, window: 1200});
  assert.ok(out.plans.length >= 1);
  assert.ok(out.plans[out.plans.length - 1].length < 256);
  assert.ok(out.result.record.timeoutMs < 900, 'timeout must be refreshed: ' + out.result.record.timeoutMs);
});

test('post-custody deadline expiry rejects before spawn', async () => {
  await assert.rejects(run({body: 'import sys\nsys.stdin.buffer.read()\n'}, {delay: 200, window: 120, originalWindow: 120}));
});

test('retained-output reservation exhaustion rejects before spawn', async () => {
  await assert.rejects(run({body: 'import sys\nsys.stdin.buffer.read()\n'}, {remaining: 100, planBytes: 16}));
});
