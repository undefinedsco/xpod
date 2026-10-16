const fs = require('node:fs');
const path = require('node:path');
const { runPublicationCommand } = require('../../../../scripts/lib/afs-publication-command.cjs');
const crypto = require('node:crypto');
const RAW_LIMIT = 128 * 1024, PROGRESS_LIMIT = 128 * 1024, RECEIPT_LIMIT = 32 * 1024;
const TOTAL_LIMIT = 1024 * 1024;
const errorValue = error => ({ name: error.name, message: String(error.message).slice(0, 1024), code: error.code ?? null });


function openRegular(file, limit, { live = false } = {}) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw new Error('Diagnostic member type or byte budget exceeded');
  if (!Number.isInteger(fs.constants.O_NONBLOCK)) throw new Error('Nonblocking diagnostic open unavailable');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const current = fs.fstatSync(fd);
    if (!current.isFile() || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino) throw new Error('Diagnostic member identity changed while opening');
    if (current.size > limit) throw new Error('Diagnostic member byte budget exceeded while opening');
    if (live ? current.size < before.size : current.size !== before.size) throw new Error('Diagnostic member size changed while opening');
    return { fd, stat: current };
  } catch (primary) {
    try { fs.closeSync(fd); } catch (secondary) { throw new AggregateError([primary, secondary], 'Diagnostic open and close failed', { cause: primary }); }
    throw primary;
  }
}

// Test evidence only. The original single-test deadline remains authoritative.
async function runLifetimeCommand(command, args, { cwd, evidence, label, deadline, sampleMs = 500 }) {
  if (!/^(client|module)$/.test(label) || args.length > 64 || Buffer.byteLength(JSON.stringify({ command, args, cwd, evidence })) > 8 * 1024) throw new Error('Invalid lifetime command input budget');
  const started = Date.now();
  const timeoutMs = deadline - started - 3000;
  if (timeoutMs < 1) throw new Error('Lifetime regression budget exhausted before ' + label);
  const events = fs.openSync(path.join(evidence, label + '.progress.jsonl'), 'wx', 0o600);
  let samples = 0, progressBytes = 0, lastOutput, timer, result, primary, progressClosed = false;
  const diagnostics = [];
  const persist = row => {
    const line = JSON.stringify({ at: new Date().toISOString(), elapsedMs: Date.now() - started, ...row }) + '\n';
    const bytes = Buffer.byteLength(line);
    if (progressBytes + bytes > PROGRESS_LIMIT) throw new Error('Lifetime progress byte budget exceeded');
    const written = fs.writeSync(events, line);
    progressBytes += written;
    if (written !== bytes) throw new Error('Lifetime progress short write');
    fs.fsyncSync(events);
  };
  const tail = kind => {
    const file = path.join(evidence, label + '.' + kind + '.raw.log');
    let fd, value, failure;
    try {
      const opened = openRegular(file, RAW_LIMIT, { live: true });
      fd = opened.fd;
      const stat = opened.stat;
      const bytes = Buffer.alloc(Math.min(stat.size, 4096));
      const count = fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, stat.size - bytes.length));
      if (count !== bytes.length) throw new Error('Diagnostic live tail shortened during read');
      const after = fs.fstatSync(fd);
      if (after.size > RAW_LIMIT || after.size < stat.size) throw new Error('Diagnostic live tail size outside budget or truncated');
      value = { bytes: stat.size, tail: bytes.toString('utf8') };
    } catch (error) {
      if (error.code === 'ENOENT') value = { bytes: 0, pending: true };
      else failure = error;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (error) { diagnostics.push(error); }
    }
    if (failure) throw failure;
    return value;
  };
  const sample = () => {
    if (samples++ >= 512 || diagnostics.length) return;
    try {
      const output = { stdout: tail('stdout'), stderr: tail('stderr') };
      const key = JSON.stringify(output);
      if (key === lastOutput) return;
      lastOutput = key;
      persist({ event: 'output-observation', ...output });
    }
    catch (error) { diagnostics.push(error); }
  };
  try {
    persist({ event: 'start', command, args, cwd, timeoutMs, deadline, evidence, descendantClosureVerified: false });
    timer = setInterval(sample, sampleMs);
    result = await runPublicationCommand(command, args, { cwd, env: process.env, evidence, label, timeoutMs, rawLimit: RAW_LIMIT });
  } catch (error) { primary = error; }
  finally {
    clearInterval(timer);
    sample(); // Final sampling must participate in the final verdict.
    try {
      persist(primary || diagnostics.length
        ? { event: 'failed', primary: primary ? errorValue(primary) : null, diagnostics: diagnostics.map(errorValue), outcome: primary?.outcome ?? result ?? null }
        : { event: 'closed', outcome: result });
    } catch (error) { diagnostics.push(error); }
    try { fs.closeSync(events); progressClosed = true; } catch (error) { diagnostics.push(error); }
  }
  const outcome = primary?.outcome ?? result ?? null;
  try {
    const receipt = JSON.stringify({
      accepted: !primary && diagnostics.length === 0, primary: primary ? errorValue(primary) : null,
      diagnostics: diagnostics.map(errorValue), outcome, progressClosed, descendantClosureVerified: false,
    }, null, 2) + '\n';
    if (Buffer.byteLength(receipt) > RECEIPT_LIMIT) throw new Error('Lifetime diagnostic receipt budget exceeded');
    fs.writeFileSync(path.join(evidence, label + '.diagnostic.receipt.json'), receipt, { flag: 'wx', mode: 0o600 });
  } catch (error) { diagnostics.push(error); }
  if (primary || diagnostics.length) {
    if (primary && diagnostics.length === 0) throw primary;
    throw Object.assign(new AggregateError(primary ? [primary, ...diagnostics] : diagnostics,
      'Lifetime command or diagnostics failed', { cause: primary ?? diagnostics[0] }), { outcome });
  }
  return result;
}


function assertDirectoryChain(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Non-directory or linked diagnostic ancestor');
  }
}

// Only this job's exact source and export directories are admitted. No glob or recursion.
function exportLifetimeDiagnostics({ root, sourceSHA, buildOutcome }) {
  assertDirectoryChain(root);
  const source = path.join(root, 'lifetime-diagnostics');
  const exportRoot = path.join(root, 'export');
  if (!fs.existsSync(exportRoot)) fs.mkdirSync(exportRoot, { mode: 0o700 });
  assertDirectoryChain(exportRoot);
  const destination = path.join(exportRoot, 'lifetime-diagnostics');
  fs.mkdirSync(destination, { mode: 0o700 });
  const errors = [], files = [], snapshots = new Map();
  let total = 0, sourcePresent = false;
  const names = new Map();
  for (const label of ['client', 'module']) {
    for (const kind of ['stdout', 'stderr']) names.set(label + '.' + kind + '.raw.log', RAW_LIMIT);
    names.set(label + '.progress.jsonl', PROGRESS_LIMIT);
    names.set(label + '.receipt.json', RECEIPT_LIMIT);
    names.set(label + '.diagnostic.receipt.json', RECEIPT_LIMIT);
  }
  try {
    // lstat also rejects dangling links, which existsSync would treat as absent.
    try { fs.lstatSync(source); sourcePresent = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (sourcePresent) {
      assertDirectoryChain(source);
      const members = fs.readdirSync(source);
      if (members.length > names.size) throw new Error('Diagnostic member count exceeded');
      for (const name of members) {
        if (!names.has(name)) { errors.push(new Error('Unexpected diagnostic member')); continue; }
        let fd;
        try {
          const opened = openRegular(path.join(source, name), names.get(name));
          fd = opened.fd;
          const before = opened.stat;
          if (total + before.size > TOTAL_LIMIT - RECEIPT_LIMIT) throw new Error('Diagnostic total byte budget exceeded');
          const data = Buffer.alloc(before.size);
          let offset = 0;
          while (offset < data.length) {
            const count = fs.readSync(fd, data, offset, data.length - offset, offset);
            if (!count) throw new Error('Diagnostic member shortened while reading');
            offset += count;
          }
          const after = fs.fstatSync(fd);
          const stable = before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs;
          if (!stable) errors.push(new Error('Diagnostic member changed during snapshot'));
          fs.writeFileSync(path.join(destination, name), data, { flag: 'wx', mode: 0o600 });
          total += data.length; snapshots.set(name, data);
          files.push({ name, bytes: data.length, snapshotSHA256: crypto.createHash('sha256').update(data).digest('hex'), snapshotStable: stable, closedOutput: false });
        } catch (error) { errors.push(error); }
        finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (error) { errors.push(error); } }
      }
    }
  } catch (error) { errors.push(error); }
  for (const label of ['client', 'module']) {
    const bytes = snapshots.get(label + '.receipt.json');
    if (!bytes) continue;
    try {
      const receipt = JSON.parse(bytes.toString('utf8'));
      for (const kind of ['stdout', 'stderr']) {
        const name = label + '.' + kind + '.raw.log', file = files.find(row => row.name === name);
        const ref = receipt.raw?.find(row => row.path === name);
        if (file && file.snapshotStable && receipt.actualWait && receipt.actualClose && receipt.groupAbsent && receipt.rawClosed && receipt.rawClosedBeforeHash && receipt.rawComplete) {
          if (!ref || ref.bytes !== file.bytes || ref.sha256 !== file.snapshotSHA256) throw new Error('Closed diagnostic raw binding mismatch');
          file.closedOutput = true;
        }
      }
    } catch (error) { errors.push(error); }
  }
  const manifest = { sourceSHA, buildOutcome, sourcePresent, files, errors: errors.map(errorValue),
    diagnosticOnly: true, accepted: false, rawPerStreamLimit: RAW_LIMIT, progressPerRunLimit: PROGRESS_LIMIT,
    totalSnapshotLimit: TOTAL_LIMIT, snapshotBytes: total, descendantClosureVerified: false,
    note: 'snapshotSHA256 binds exported bytes only. closedOutput requires actual closed command receipt and matching raw binding. Missing/unclosed files remain incomplete; this export grants no build qualification.' };
  const text = JSON.stringify(manifest, null, 2) + '\n';
  try {
    if (Buffer.byteLength(text) > RECEIPT_LIMIT || total + Buffer.byteLength(text) > TOTAL_LIMIT) throw new Error('Diagnostic export manifest budget exceeded');
    fs.writeFileSync(path.join(destination, 'export.safe.json'), text, { flag: 'wx', mode: 0o600 });
  } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Lifetime diagnostic export failed; original build outcome: ' + buildOutcome);
  return manifest;
}
function createLifetimeDiagnostics(repo, root) {
  if (!root) return fs.mkdtempSync(path.join(repo, '.test-data/afs-lifetime-diagnostics-'));
  assertDirectoryChain(root);
  const directory = path.join(root, 'lifetime-diagnostics');
  fs.mkdirSync(directory, { mode: 0o700 });
  return directory;
}
module.exports = { createLifetimeDiagnostics, runLifetimeCommand, exportLifetimeDiagnostics, RAW_LIMIT, PROGRESS_LIMIT, RECEIPT_LIMIT, TOTAL_LIMIT };
