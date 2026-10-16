const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runLifetimeCommand } = require('./helpers/lifetime-command.cjs');
const repo = path.resolve(__dirname, '../../..');
fs.mkdirSync(path.join(repo, '.test-data'), { recursive: true });
const evidenceRoot = fs.mkdtempSync(path.join(repo, '.test-data/afs-lifetime-diagnostic-injection-'));
process.stdout.write(JSON.stringify({ evidenceRoot }) + '\n');
const fixture = name => { const p = path.join(evidenceRoot, name); fs.mkdirSync(p); return p; };
const waitFor = async predicate => {
  const deadline = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'live evidence did not arrive'); await new Promise(resolve => setTimeout(resolve, 10)); }
};

test('start and inner-stage output persist while the producer is still alive', async () => {
  const evidence = fixture('live');
  const running = runLifetimeCommand(process.execPath, ['-e', "process.stdout.write('stage-start\\n');process.stderr.write('inner-stage-start\\n');setTimeout(()=>process.stdout.write('stage-end\\n'),250)"], { cwd: repo, evidence, label: 'client', deadline: Date.now() + 5000, sampleMs: 20 });
  const progress = path.join(evidence, 'client.progress.jsonl');
  await waitFor(() => fs.existsSync(progress) && fs.readFileSync(progress, 'utf8').includes('inner-stage-start'));
  assert.equal(fs.existsSync(path.join(evidence, 'client.receipt.json')), false);
  const row = await running;
  assert.equal(row.code, 0); assert.equal(row.actualClose, true); assert.equal(row.rawComplete, true);
  const events = fs.readFileSync(progress, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events[0].event, 'start'); assert.equal(events.at(-1).event, 'closed');
  assert.equal(events.at(-1).outcome.descendantClosureVerified, false);
});

test('a stuck stage keeps pre-deadline originals and records actual timeout closure', async () => {
  const evidence = fixture('timeout');
  let failure;
  try { await runLifetimeCommand(process.execPath, ['-e', "process.stdout.write('components-start\\n');setInterval(()=>{},1000)"], { cwd: repo, evidence, label: 'module', deadline: Date.now() + 3250, sampleMs: 20 }); }
  catch (error) { failure = error; }
  assert.ok(failure); assert.match(failure.message, /deadline/);
  const row = failure.outcome;
  assert.equal(row.signal, 'SIGTERM'); assert.equal(row.actualWait, true); assert.equal(row.actualClose, true); assert.equal(row.groupAbsent, true);
  assert.match(fs.readFileSync(path.join(evidence, 'module.stdout.raw.log'), 'utf8'), /components-start/);
  const events = fs.readFileSync(path.join(evidence, 'module.progress.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e => e.event === 'output-observation' && e.stdout.tail.includes('components-start')));
  assert.equal(events.at(-1).event, 'failed');
});

test('nonzero inner-stage failure retains stderr and actual outcome', async () => {
  const evidence = fixture('nonzero');
  await assert.rejects(runLifetimeCommand(process.execPath, ['-e', "process.stderr.write('generator-failure\\n');process.exitCode=7"], { cwd: repo, evidence, label: 'module', deadline: Date.now() + 5000 }), error => error.outcome.code === 7 && error.outcome.actualClose && error.outcome.rawComplete);
  assert.match(fs.readFileSync(path.join(evidence, 'module.stderr.raw.log'), 'utf8'), /generator-failure/);
});

test('client then module share a single deadline and never start with exhausted budget', async () => {
  const evidence = fixture('sequence'); const deadline = Date.now() + 5000;
  for (const label of ['client', 'module']) await runLifetimeCommand(process.execPath, ['-e', "process.stdout.write('ok\\n')"], { cwd: repo, evidence, label, deadline });
  const client = JSON.parse(fs.readFileSync(path.join(evidence, 'client.progress.jsonl'), 'utf8').split('\n')[0]);
  const module = JSON.parse(fs.readFileSync(path.join(evidence, 'module.progress.jsonl'), 'utf8').split('\n')[0]);
  assert.equal(client.deadline, module.deadline); assert.ok(module.timeoutMs <= client.timeoutMs);
  const before = fs.readdirSync(evidence);
  await assert.rejects(runLifetimeCommand(process.execPath, ['-e', 'throw Error()'], { cwd: repo, evidence, label: 'client', deadline: Date.now() + 100 }), /budget exhausted/);
  assert.deepEqual(fs.readdirSync(evidence), before);
});

// Replay the three independent peer counterexamples against the unchanged helper source.
const vm = require('node:vm');
async function injectDiagnosticFailure(kind) {
  const source = fs.readFileSync(path.join(__dirname, 'helpers/lifetime-command.cjs'), 'utf8');
  const primary = Object.assign(new Error('original-command-failed'), { outcome: { code: 7 } });
  const events = [];
  const mock = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 2048 },
    openSync(p) { return String(p).endsWith('jsonl') ? 1 : 2; },
    lstatSync() { return { size: 0, dev: 1, ino: 1, nlink: 1, isFile: () => true, isSymbolicLink: () => false }; },
    fstatSync() { if (kind === 'final-sample') throw new Error('sample-read-failed'); return this.lstatSync(); },
    readSync() { return 0; },
    writeSync(fd, line) {
      const row = JSON.parse(line);
      if (kind === 'failed-persist' && row.event === 'failed') throw new Error('persist-failed');
      events.push(row); return Buffer.byteLength(line);
    },
    writeFileSync() {}, fsyncSync() {},
    closeSync(fd) { if (kind === 'close' && fd === 1) throw new Error('close-failed'); },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { require(name) {
    if (name === 'node:fs') return mock;
    if (name.startsWith('node:')) return require(name);
    return { runPublicationCommand: async () => { if (kind !== 'final-sample') throw primary; return { code: 0 }; } };
  }, module, Buffer, Date, process, setInterval, clearInterval });
  let error;
  try { await module.exports.runLifetimeCommand('fake', [], { cwd: '.', evidence: '.', label: 'client', deadline: Date.now() + 5000 }); }
  catch (value) { error = value; }
  return { error, primary, events };
}
for (const kind of ['failed-persist', 'close', 'final-sample']) test('peer replay fails closed and retains primary: ' + kind, async () => {
  const { error, primary, events } = await injectDiagnosticFailure(kind);
  assert.ok(error);
  if (kind !== 'final-sample') {
    assert.equal(error.cause, primary); assert.equal(error.outcome.code, 7);
    assert.ok(error.errors.includes(primary));
  } else {
    assert.equal(error.outcome.code, 0);
    assert.ok(error.errors.some(e => e.message === 'sample-read-failed'));
    assert.equal(events.some(e => e.event === 'closed'), false);
  }
});

const { exportLifetimeDiagnostics, createLifetimeDiagnostics, RAW_LIMIT, TOTAL_LIMIT } = require('./helpers/lifetime-command.cjs');
test('exact export preserves incomplete snapshots without granting closure', () => {
  const root = fixture('incomplete-export'); const source = createLifetimeDiagnostics(repo, root);
  fs.writeFileSync(path.join(source, 'module.stdout.raw.log'), 'still-live-stage\n');
  const manifest = exportLifetimeDiagnostics({ root, sourceSHA: 'fixture', buildOutcome: 'failure' });
  assert.equal(manifest.buildOutcome, 'failure'); assert.equal(manifest.files[0].closedOutput, false);
  assert.equal(manifest.accepted, false); assert.ok(manifest.snapshotBytes < TOTAL_LIMIT);
  assert.match(fs.readFileSync(path.join(root, 'export/lifetime-diagnostics/module.stdout.raw.log'), 'utf8'), /still-live/);
});
test('export verifies closed raw receipt binding and the exact source directory', async () => {
  const root = fixture('closed-export'); const source = createLifetimeDiagnostics(repo, root);
  await runLifetimeCommand(process.execPath, ['-e', "process.stdout.write('closed-stage\\n')"], { cwd: repo, evidence: source, label: 'client', deadline: Date.now() + 5000 });
  const manifest = exportLifetimeDiagnostics({ root, sourceSHA: 'fixture', buildOutcome: 'success' });
  assert.equal(manifest.files.find(f => f.name === 'client.stdout.raw.log').closedOutput, true);
  assert.equal(manifest.accepted, false);
});
test('export rejects links, unexpected names, oversize and preserves original build outcome', () => {
  for (const kind of ['link', 'unexpected', 'oversize']) {
    const root = fixture('rejected-export-' + kind); const source = createLifetimeDiagnostics(repo, root);
    if (kind === 'link') fs.symlinkSync(path.join(repo, '.git'), path.join(source, 'client.stdout.raw.log'));
    if (kind === 'unexpected') fs.writeFileSync(path.join(source, 'foreign.txt'), 'foreign');
    if (kind === 'oversize') fs.writeFileSync(path.join(source, 'client.stdout.raw.log'), Buffer.alloc(RAW_LIMIT + 1));
    assert.throws(() => exportLifetimeDiagnostics({ root, sourceSHA: 'fixture', buildOutcome: 'failure' }), /original build outcome: failure/);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'export/lifetime-diagnostics/export.safe.json'), 'utf8'));
    assert.equal(manifest.buildOutcome, 'failure'); assert.ok(manifest.errors.length); assert.equal(manifest.files.length, 0);
  }
});
test('export rejects a linked source ancestor and never traverses it', () => {
  const root = fixture('linked-source'), foreign = fixture('foreign-source');
  fs.writeFileSync(path.join(foreign, 'client.stdout.raw.log'), 'untouched');
  fs.symlinkSync(foreign, path.join(root, 'lifetime-diagnostics'));
  assert.throws(() => exportLifetimeDiagnostics({ root, sourceSHA: 'fixture', buildOutcome: 'failure' }), /original build outcome/);
  assert.equal(fs.readFileSync(path.join(foreign, 'client.stdout.raw.log'), 'utf8'), 'untouched');
});

const { runPublicationCommand, RAW_LIMIT: ORIGINAL_RAW_LIMIT } = require('../../../scripts/lib/afs-publication-command.cjs');
test('shared runner preserves default cap and allows only a lower positive integer cap', async () => {
  const evidence = fixture('raw-default');
  const row = await runPublicationCommand(process.execPath, ['-e', "process.stdout.write('ok')"], { cwd: repo, evidence, label: 'default', timeoutMs: 1000 });
  assert.equal(row.rawBudgetPerStream, ORIGINAL_RAW_LIMIT);
  for (const rawLimit of [0, -1, 1.5, ORIGINAL_RAW_LIMIT + 1, NaN, '128']) {
    await assert.rejects(runPublicationCommand(process.execPath, ['-e', ''], { cwd: repo, evidence, label: 'invalid', timeoutMs: 1000, rawLimit }), /Invalid command raw budget/);
  }
  const small = await runPublicationCommand(process.execPath, ['-e', "process.stdout.write('ok')"], { cwd: repo, evidence, label: 'small', timeoutMs: 1000, rawLimit: 8 });
  assert.equal(small.rawBudgetPerStream, 8);
});
test('lower raw cap retains bounded originals and observes controlled shutdown', async () => {
  const evidence = fixture('raw-overflow'); let failure;
  try { await runPublicationCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(256));setInterval(()=>{},1000)"], { cwd: repo, evidence, label: 'overflow', timeoutMs: 2000, rawLimit: 16 }); }
  catch (error) { failure = error; }
  assert.ok(failure); assert.match(failure.message, /raw budget exceeded/);
  assert.equal(failure.outcome.rawComplete, false); assert.equal(failure.outcome.groupAbsent, true);
  assert.equal(failure.outcome.actualClose, true); assert.equal(failure.outcome.actualWait, true);
  assert.equal(fs.statSync(path.join(evidence, 'overflow.stdout.raw.log')).size, 16);
  assert.equal(failure.outcome.raw[0].status, 'truncated'); assert.equal('sha256' in failure.outcome.raw[0], false);
});
test('JSON escaped progress is byte bounded and budget errors retain original command cause', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'helpers/lifetime-command.cjs'), 'utf8');
  const primary = Object.assign(new Error('original-command-failed'), { outcome: { code: 7 } });
  let tick, total = 0, value = 0;
  const mock = { constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 2048 }, openSync(p) { return String(p).endsWith('jsonl') ? 1 : 2; },
    lstatSync() { return { size: 4096, dev: 1, ino: 1, nlink: 1, isFile: () => true, isSymbolicLink: () => false }; },
    fstatSync() { return this.lstatSync(); }, readSync(fd, buffer) { buffer[0] = ++value; return 4096; },
    writeSync(fd, data) { const bytes = Buffer.byteLength(data); total += bytes; return bytes; },
    fsyncSync() {}, closeSync() {}, writeFileSync() {} };
  const module = { exports: {} };
  vm.runInNewContext(source, { require(name) {
    if (name === 'node:fs') return mock;
    if (name.startsWith('node:')) return require(name);
    return { runPublicationCommand: async () => { for (let i = 0; i < 10; i++) tick(); throw primary; } };
  }, module, Buffer, Date, process, setInterval(fn) { tick = fn; return 1; }, clearInterval() {} });
  await assert.rejects(module.exports.runLifetimeCommand('fake', [], { cwd: '.', evidence: '.', label: 'client', deadline: Date.now() + 5000 }), error => {
    assert.equal(error.cause, primary); assert.equal(error.outcome.code, 7);
    assert.ok(error.errors.some(e => /progress byte budget/.test(e.message))); return true;
  });
  assert.ok(total <= module.exports.PROGRESS_LIMIT);
});
test('all allowed files at hard caps keep originals plus export within the whole-regression budget', () => {
  const { PROGRESS_LIMIT, RECEIPT_LIMIT } = require('./helpers/lifetime-command.cjs');
  const root = fixture('whole-budget'), source = createLifetimeDiagnostics(repo, root);
  let originalBytes = 0;
  for (const label of ['client', 'module']) {
    for (const kind of ['stdout', 'stderr']) { fs.writeFileSync(path.join(source, label + '.' + kind + '.raw.log'), Buffer.alloc(RAW_LIMIT)); originalBytes += RAW_LIMIT; }
    fs.writeFileSync(path.join(source, label + '.progress.jsonl'), Buffer.alloc(PROGRESS_LIMIT)); originalBytes += PROGRESS_LIMIT;
    for (const suffix of ['.receipt.json', '.diagnostic.receipt.json']) {
      const text = '{"rawComplete":false}' + ' '.repeat(RECEIPT_LIMIT - 21);
      assert.equal(Buffer.byteLength(text), RECEIPT_LIMIT);
      fs.writeFileSync(path.join(source, label + suffix), text); originalBytes += RECEIPT_LIMIT;
    }
  }
  const manifest = exportLifetimeDiagnostics({ root, sourceSHA: 'fixture', buildOutcome: 'failure' });
  const target = path.join(root, 'export/lifetime-diagnostics');
  const exportedBytes = fs.readdirSync(target).reduce((sum, name) => sum + fs.statSync(path.join(target, name)).size, 0);
  assert.ok(originalBytes < TOTAL_LIMIT); assert.ok(exportedBytes <= TOTAL_LIMIT);
  assert.ok(originalBytes + exportedBytes <= 2 * TOTAL_LIMIT);
  assert.equal(manifest.files.length, 10); assert.ok(manifest.files.every(row => row.closedOutput === false));
});

const { spawnSync } = require('node:child_process');
test('allowed-name FIFO is rejected by an actual bounded exporter child', async () => {
  const root = fixture('fifo-export'), source = createLifetimeDiagnostics(repo, root), evidence = fixture('fifo-child');
  const made = spawnSync('mkfifo', [path.join(source, 'client.stdout.raw.log')], { timeout: 1000 });
  assert.equal(made.status, 0); assert.equal(made.signal, null);
  const helper = path.join(__dirname, 'helpers/lifetime-command.cjs');
  const script = `const {exportLifetimeDiagnostics}=require(${JSON.stringify(helper)});try{exportLifetimeDiagnostics({root:${JSON.stringify(root)},sourceSHA:'fixture',buildOutcome:'failure'});process.exitCode=2}catch(error){console.log(error.message)}`;
  const row = await runPublicationCommand(process.execPath, ['-e', script], { cwd: repo, evidence, label: 'fifo', timeoutMs: 1000, rawLimit: 4096 });
  assert.equal(row.actualWait, true); assert.equal(row.actualClose, true); assert.equal(row.groupAbsent, true);
  assert.match(fs.readFileSync(path.join(evidence, 'fifo.stdout.raw.log'), 'utf8'), /diagnostic export failed/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'export/lifetime-diagnostics/export.safe.json'), 'utf8'));
  assert.equal(manifest.files.length, 0); assert.ok(manifest.errors.some(e => /type or byte budget/.test(e.message)));
});
for (const replacement of ['regular', 'fifo']) test('identity replacement is nonblocking and rejected: ' + replacement, async () => {
  const root = fixture('race-' + replacement), source = createLifetimeDiagnostics(repo, root), evidence = fixture('race-child-' + replacement);
  const file = path.join(source, 'client.stdout.raw.log'); fs.writeFileSync(file, 'original');
  const helper = path.join(__dirname, 'helpers/lifetime-command.cjs');
  const script = `const fs=require('node:fs'),vm=require('node:vm'),cp=require('node:child_process');
const file=${JSON.stringify(file)}, root=${JSON.stringify(root)};let swapped=false,nonblocking=false;
const mock={...fs,openSync(p,flags,...args){if(p===file&&!swapped){swapped=true;nonblocking=!!(flags&fs.constants.O_NONBLOCK);fs.renameSync(file,file+'.old');if(${JSON.stringify(replacement)}==='fifo'){const r=cp.spawnSync('mkfifo',[file],{timeout:500});if(r.status!==0)throw Error('FIFO fixture failed')}else fs.writeFileSync(file,'replaced');}return fs.openSync(p,flags,...args)}};
const module={exports:{}};vm.runInNewContext(fs.readFileSync(${JSON.stringify(helper)},'utf8'),{require(name){if(name==='node:fs')return mock;if(name.startsWith('node:'))return require(name);return {}},module,Buffer,Date,process,setInterval,clearInterval});
try{module.exports.exportLifetimeDiagnostics({root,sourceSHA:'fixture',buildOutcome:'failure'});process.exitCode=2}catch(error){console.log(JSON.stringify({rejected:true,nonblocking,errors:error.errors.map(e=>e.message)}));if(!nonblocking)process.exitCode=3}`;
  const row = await runPublicationCommand(process.execPath, ['-e', script], { cwd: repo, evidence, label: 'race', timeoutMs: 1500, rawLimit: 4096 });
  assert.equal(row.actualWait, true); assert.equal(row.actualClose, true); assert.equal(row.groupAbsent, true);
  const value = JSON.parse(fs.readFileSync(path.join(evidence, 'race.stdout.raw.log'), 'utf8'));
  assert.equal(value.nonblocking, true); assert.equal(value.rejected, true);
  assert.ok(value.errors.some(message => /identity changed/.test(message)));
});

async function injectLiveGrowth(mode) {
  const evidence = fixture('live-growth-' + mode);
  const raw = path.join(evidence, 'client.stdout.raw.log');
  const helperSource = fs.readFileSync(path.join(__dirname, 'helpers/lifetime-command.cjs'), 'utf8');
  let grew = false;
  const mock = { ...fs, openSync(file, flags, ...args) {
    if (file === raw && !grew) {
      grew = true;
      if (mode === 'replacement') { fs.renameSync(raw, raw + '.old'); fs.writeFileSync(raw, 'replaced'); }
      else fs.appendFileSync(raw, mode === 'over-budget' ? Buffer.alloc(RAW_LIMIT + 1) : ' appended-while-opening');
    }
    return fs.openSync(file, flags, ...args);
  } };
  const module = { exports: {} };
  vm.runInNewContext(helperSource, { require(name) {
    if (name === 'node:fs') return mock;
    if (name.startsWith('node:')) return require(name);
    return { runPublicationCommand: async () => {
      fs.writeFileSync(raw, 'before'); fs.writeFileSync(path.join(evidence, 'client.stderr.raw.log'), '');
      return { code: 0, actualClose: true, groupAbsent: true, rawClosed: true };
    } };
  }, module, Buffer, Date, process, setInterval, clearInterval });
  let result, error;
  try { result = await module.exports.runLifetimeCommand('fixture-stub', [], { cwd: repo, evidence, label: 'client', deadline: Date.now() + 5000 }); }
  catch (value) { error = value; }
  return { evidence, result, error, grew };
}
test('live same-inode append during descriptor admission is valid diagnostic output', async () => {
  const { evidence, result, error, grew } = await injectLiveGrowth('bounded');
  assert.equal(error, undefined); assert.equal(result.code, 0); assert.equal(grew, true);
  const progress = fs.readFileSync(path.join(evidence, 'client.progress.jsonl'), 'utf8');
  assert.match(progress, /appended-while-opening/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(evidence, 'client.diagnostic.receipt.json'), 'utf8')).accepted, true);
});
for (const mode of ['over-budget', 'replacement']) test('live descriptor sampling still rejects ' + mode, async () => {
  const { result, error, grew } = await injectLiveGrowth(mode);
  assert.equal(result, undefined); assert.ok(error); assert.equal(grew, true); assert.equal(error.outcome.code, 0);
  assert.ok(error.errors.some(e => mode === 'replacement' ? /identity changed/.test(e.message) : /byte budget/.test(e.message)));
});
test('snapshot export still rejects same-inode size growth between lstat and open', () => {
  const root = fixture('snapshot-growth'), source = createLifetimeDiagnostics(repo, root), raw = path.join(source, 'client.stdout.raw.log');
  fs.writeFileSync(raw, 'before');
  const helperSource = fs.readFileSync(path.join(__dirname, 'helpers/lifetime-command.cjs'), 'utf8');
  let grew = false;
  const mock = { ...fs, openSync(file, flags, ...args) {
    if (file === raw && !grew) { grew = true; fs.appendFileSync(raw, ' appended'); }
    return fs.openSync(file, flags, ...args);
  } };
  const module = { exports: {} };
  vm.runInNewContext(helperSource, { require(name) {
    if (name === 'node:fs') return mock;
    if (name.startsWith('node:')) return require(name);
    return {};
  }, module, Buffer, Date, process, setInterval, clearInterval });
  assert.throws(() => module.exports.exportLifetimeDiagnostics({ root, sourceSHA: 'fixture', buildOutcome: 'failure' }), /diagnostic export failed/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'export/lifetime-diagnostics/export.safe.json'), 'utf8'));
  assert.equal(grew, true); assert.equal(manifest.files.length, 0);
  assert.ok(manifest.errors.some(e => /size changed/.test(e.message)));
});
