#!/usr/bin/env bun
'use strict';
// Development evidence only. Never consumed by release acceptance or CI gates.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { hashTree } = require('./lib/build-inputs.cjs');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const safePath = file => !/(^|\/)(?:\.env(?:\..*)?|node_modules|dist)(\/|$)/.test(file)
  && !/^(?:logs|local|data|\.test-data|\.xpod|\.git)(\/|$)/.test(file)
  && !/^desktop\/(?:release|runtime)(\/|$)/.test(file)
  && !/^desktop\/runtime-pack(?:-budget)?\.json$/.test(file)
  && !/^static\/(?:app|dashboard|settings)\/(?:assets\/|(?:auth|dashboard|settings|auth-callback)\.html$)/.test(file)
  && !/\.(?:pem|key|p12|sqlite(?:-wal|-shm)?)$/.test(file);
function files(root) {
  return [...new Set(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].filter(safePath).sort();
}
function tool(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`toolchain_unavailable:${command}`);
  return result.stdout.trim();
}
function optionalTool(command, args) { try { return tool(command, args); } catch { return 'unavailable'; } }
function outputFingerprint(root) {
  return hash(JSON.stringify(['app', 'dashboard', 'settings'].map(name => {
    const directory = path.join(root, 'static', name);
    return [name, fs.existsSync(directory) ? hashTree(directory) : []];
  })));
}
function counts(stdout) {
  const lines = String(stdout || '').replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  return lines.filter(line => /^\s*(?:Tests|Test Files)\s|^# (?:pass|fail|skipped|cancelled) \d+/.test(line)).flatMap(line => {
    const tap = /^# (pass|fail|skipped|cancelled) (\d+)/.exec(line);
    if (tap) return [{ count: Number(tap[2]), result: { pass: 'passed', fail: 'failed' }[tap[1]] || tap[1] }];
    return [...line.matchAll(/(\d+)\s+(passed|failed|skipped|cancelled)/g)].map(match => ({ count: Number(match[1]), result: match[2] }));
  });
}
function fingerprint(root, environment, toolchain) {
  if (!/^[A-Za-z0-9._:/-]{1,160}$/.test(environment || '')) throw new Error('environment_revision_required');
  return hash(JSON.stringify({ root: fs.realpathSync(root), environment, platform: process.platform, arch: process.arch,
    toolchain: toolchain || { node: process.version, bun: tool('bun', ['--version']), tsc: tool('bun', ['x', '--no-install', 'tsc', '--version']), npm: optionalTool('npm', ['--version']) },
    flags: ['NODE_ENV', 'XPOD_TEST_TRANSPORT', 'XPOD_RUN_INTEGRATION_TESTS'].map(key => [key, process.env[key] || '']),
    inputs: files(root).map(file => {
      const absolute = path.join(root, file);
      if (!fs.existsSync(absolute)) return [file, 'deleted'];
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('unsupported_input_requires_explicit_validation');
      return [file, stat.mode & 0o777, stat.isSymbolicLink() ? fs.readlinkSync(absolute) : hash(fs.readFileSync(absolute))];
    }),
  }));
}
function changed(root, base) {
  // Include committed branch changes, staged/unstaged edits and nonignored new files.
  return [...new Set([...git(root, ['diff', '--name-only', '-z', `${base}...HEAD`]).split('\0'),
    ...git(root, ['diff', '--name-only', '-z', 'HEAD']).split('\0'),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(Boolean))];
}
function contractTargets(root, inputs) {
  if (!root) return { vitest: ['tests/scripts'], node: [] };
  const candidates = fs.readdirSync(path.join(root, 'tests/scripts')).filter(file => /(?:\.test\.ts|\.node-test\.(?:cjs|mjs))$/.test(file)).sort();
  const selected = new Set(); let unknown = false;
  for (const file of inputs.filter(file => /^(?:scripts\/|tests\/scripts\/|\.github\/|AGENTS\.md|docs\/(?:RELEASE|testing\/|superpowers\/))/.test(file))) {
    if (file.startsWith('tests/scripts/') && candidates.includes(path.basename(file))) { selected.add(path.basename(file)); continue; }
    const name = path.basename(file);
    const stem = name.replace(/\.(?:cjs|mjs|ts|md|yml)$/, '');
    const matches = candidates.filter(test => fs.readFileSync(path.join(root, 'tests/scripts', test), 'utf8').includes(file.startsWith('.github/') ? name : stem));
    if (matches.length) matches.forEach(test => selected.add(test));
    else if (/^docs\/superpowers\//.test(file) || file === 'AGENTS.md' || file.startsWith('docs/testing/')) {
      // Process rules affect all release contracts even when no test names this new document.
      candidates.filter(test => /release|candidate-workflow|development-validation|desktop-permission-workflow/.test(test)).forEach(test => selected.add(test));
    } else unknown = true;
  }
  const targets = (unknown ? candidates : [...selected]).map(file => `tests/scripts/${file}`);
  return { vitest: targets.filter(file => file.endsWith('.test.ts')), node: targets.filter(file => /\.node-test\./.test(file)), unknown };
}
function select(input, root) {
  const groups = new Set();
  const reasons = [];
  for (const file of input) {
    let group;
    if (/^(AGENTS\.md|docs\/(RELEASE|testing\/|superpowers\/))/.test(file)) group = 'contracts';
    else if (/\.md$/.test(file)) group = 'docs';
    else if (/^scripts\/(?:build-|lib\/bun-single|helpers\/packaged-desktop)/.test(file)) group = 'boundary';
    else if (/^(\.github\/|scripts\/|tests\/scripts\/)/.test(file)) group = 'contracts';
    else if (/^(ui\/|tests\/ui\/)/.test(file)) group = 'ui';
    else if (/^(desktop\/|bin\/|qlever\/)/.test(file)) group = 'boundary';
    else if (/^(src\/(storage|identity|http|auth|util|runtime|logging)|packages\/|config\/|patches\/|bun\.lock|package\.json|tsconfig|vitest|Dockerfile)/.test(file)) group = 'broad';
    else if (/^src\//.test(file) && /auth|permission|session|webid|credential|task|runstate|pod.store/i.test(file)) group = 'broad';
    else if (/^src\//.test(file)) group = 'backend';
    else group = 'broad';
    groups.add(group); reasons.push(`${file}:${group}`);
  }
  if (!groups.size) groups.add('docs');
  const commands = [];
  const add = args => { if (!commands.some(row => JSON.stringify(row) === JSON.stringify(args))) commands.push(args); };
  const documents = input.filter(file => file.endsWith('.md'));
  if (documents.length) add(['node', 'scripts/check-document-links.cjs', ...documents]);
  const nodeContracts = () => {
    if (root) add(['node', '--test', ...fs.readdirSync(path.join(root, 'tests/scripts')).filter(file => /\.node-test\.(cjs|mjs)$/.test(file)).sort().map(file => `tests/scripts/${file}`)]);
  };
  if (groups.has('broad') || groups.has('boundary')) {
    add(['bun', 'run', 'build:packages']); add(['bun', 'run', 'build:ts']); add(['bun', 'run', 'typecheck:test']);
    add(['bun', 'run', 'build:components']);
    if (groups.has('broad') || groups.has('ui')) add(['bun', 'run', 'build:ui']);
    add(['bun', 'run', 'check:platform-package-version']);
    add(['bun', 'x', '--no-install', 'tsc', '--noEmit', '-p', 'packages/xpod-cli/tsconfig.json']);
    add(['bun', 'run', '--filter', '@undefineds.co/xpod-cli', 'test']);
    nodeContracts();
    add(['bun', 'run', 'test:run']);
    // TypeScript and Components.js were built above; retain the runtime probe without rebuilding them.
    add(['env', 'XPOD_TEST_TRANSPORT=port', 'bun', 'scripts/run-bun-runtime-smoke.ts']);
    add(['bun', 'run', 'test:bun']);
    if (groups.has('broad') || groups.has('ui')) add(['bun', 'run', 'test:account-layout']);
    if (groups.has('boundary')) {
      if (input.some(file => file.startsWith('desktop/'))) add(['bun', 'run', '--filter', '@undefineds.co/xpod-desktop', 'test']);
      if (input.some(file => file.startsWith('qlever/'))) { add(['bun', 'run', 'check:abi']); add(['bun', 'run', 'check:qlever-real-runtime']); }
      reasons.push('boundary: compiled bootstrap contracts execute with Node tooling tests; native changes additionally require real ABI/runtime probe; installed artifacts require separate acceptance');
    }
    if (groups.has('broad')) add(['bun', 'run', 'test:integration']);
  } else {
    if (groups.has('backend') || groups.has('ui')) {
      add(['bun', 'run', 'build:packages']);
      if (groups.has('backend')) add(['bun', 'run', 'build:ts']);
      if (groups.has('ui')) add(['bun', 'run', 'build:ui']);
      add(['bun', 'run', 'typecheck:test']);
      if (groups.has('ui')) add(['bun', 'run', 'test:run', '--', 'tests/ui']);
      if (groups.has('ui')) add(['bun', 'run', 'test:account-layout']);
      if (groups.has('backend')) {
        const targets = input.filter(file => file.startsWith('src/')).map(file => `tests/${file.slice(4).replace(/\.ts$/, '.test.ts')}`);
        if (root && targets.length && targets.every(file => fs.existsSync(path.join(root, file)))) add(['bun', 'run', 'test:run', '--', ...targets]);
        else { add(['bun', 'run', 'test:run']); reasons.push('backend: no exact test mapping; conservatively run unit consumers'); }
      }
    }
    if (groups.has('contracts')) {
      // Use direct Vitest: dependency-state may otherwise rebuild unrelated product packages.
      const targets = contractTargets(root, input);
      if (targets.unknown) reasons.push('contracts: no reliable direct contract mapping; run all script contracts');
      if (targets.vitest.length) add(['bun', 'x', '--no-install', 'vitest', 'run', ...targets.vitest]);
      if (targets.node.length) add(['node', '--test', ...targets.node]);
    }
  }
  add(['git', 'diff', '--check']);
  return { groups: [...groups].sort(), reasons, commands };
}
function seal(receipt, key) { return crypto.createHmac('sha256', key).update(JSON.stringify(receipt)).digest('hex'); }
function valid(envelope, key, input, commands, outputs) {
  if (!envelope?.receipt || !key) return false;
  const row = envelope.receipt;
  return envelope.signature === seal(row, key) && row.schemaVersion === 1 && row.purpose === 'development-only'
    && row.status === 'passed' && row.fingerprint === input && JSON.stringify(row.commands) === JSON.stringify(commands)
    && Array.isArray(row.results) && row.results.length === commands.length && row.results.every(result => result.status === 'passed' && result.exitCode === 0)
    && Boolean(row.startedAt && row.finishedAt)
    && (row.outputFingerprint === undefined || row.outputFingerprint === outputs);
}
function run(root, mode, environment, plan, executor = args => { const result = spawnSync(args[0], args.slice(1), { cwd: root, stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr); return result; }) {
  const directory = path.join(root, '.test-data/development-validation');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = path.join(directory, 'local-key');
  if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
  const key = fs.readFileSync(keyPath);
  const input = fingerprint(root, environment);
  const currentPath = path.join(directory, `${mode}.json`);
  let previous;
  try { previous = JSON.parse(fs.readFileSync(currentPath)); } catch {}
  if (valid(previous, key, input, plan.commands, outputFingerprint(root))) { console.log(`development-only: reused ${mode} receipt ${previous.receipt.id}`); return previous.receipt; }
  if (mode === 'frozen') {
    let quick;
    try { quick = JSON.parse(fs.readFileSync(path.join(directory, 'quick.json'))); } catch {}
    if (quick?.receipt && valid(quick, key, input, quick.receipt.commands, outputFingerprint(root))) {
      const results = plan.commands.map(command => quick.receipt.results.find(result => JSON.stringify(result.command) === JSON.stringify(command)));
      if (results.every(Boolean)) {
        const receipt = { ...quick.receipt, id: crypto.randomUUID(), reusedFrom: quick.receipt.id, groups: plan.groups, commands: plan.commands, results };
        // Source integration and installed/compiled artifact groups have independent bindings.
        delete receipt.outputFingerprint;
        fs.writeFileSync(currentPath, JSON.stringify({ receipt, signature: seal(receipt, key) }, null, 2), { mode: 0o600 });
        fs.appendFileSync(path.join(directory, 'events.jsonl'), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
        console.log(`development-only: reused successful quick integration ${quick.receipt.id}`); return receipt;
      }
    }
  }
  if (mode === 'check') throw new Error('no_valid_frozen_receipt');
  const receipt = { schemaVersion: 1, purpose: 'development-only', id: crypto.randomUUID(), environment,
    source: { headSha: git(root, ['rev-parse', 'HEAD']).trim(), committedTree: git(root, ['rev-parse', 'HEAD^{tree}']).trim() },
    groups: plan.groups, commands: plan.commands, fingerprint: input, startedAt: new Date().toISOString(), status: 'running', results: [], skipped: [] };
  const save = () => { const envelope = { receipt, signature: seal(receipt, key) }; fs.writeFileSync(`${currentPath}.tmp`, JSON.stringify(envelope, null, 2), { mode: 0o600 }); fs.renameSync(`${currentPath}.tmp`, currentPath); };
  save();
  for (const command of plan.commands) {
    const startedAt = new Date().toISOString(); const start = performance.now();
    console.log(`development-only: ${command.join(' ')}`);
    let result;
    try { result = executor(command); } catch { result = { status: 1 }; }
    const status = result.signal ? 'cancelled' : result.status === 0 ? 'passed' : 'failed';
    receipt.results.push({ command, startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - start), exitCode: result.status, status, counts: counts(result.stdout) });
    if (status !== 'passed') { receipt.status = status; receipt.skipped = plan.commands.slice(receipt.results.length).map(command => ({ command, reason: 'previous-command-failed-or-cancelled' })); break; }
  }
  if (receipt.status === 'running') receipt.status = fingerprint(root, environment) === input ? 'passed' : 'invalidated';
  receipt.finishedAt = new Date().toISOString(); save();
  if (mode === 'quick') { receipt.outputFingerprint = outputFingerprint(root); save(); }
  fs.appendFileSync(path.join(directory, 'events.jsonl'), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  if (receipt.status !== 'passed') throw new Error(`validation_${receipt.status}`);
  return receipt;
}
const frozen = { groups: ['frozen-integration'], commands: [['bun', 'run', 'test:integration']] };
function main() {
  const args = process.argv.slice(2); const mode = args[0] || 'quick';
  if (!['quick', 'frozen', 'check'].includes(mode)) throw new Error('invalid_mode');
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const root = process.cwd(); const environment = option('--environment');
  const plan = mode === 'quick' ? select(changed(root, option('--base') || 'origin/staging'), root) : frozen;
  console.log(JSON.stringify(plan, null, 2));
  if (args.includes('--github-output')) {
    if (!process.env.GITHUB_OUTPUT) throw new Error('github_output_missing');
    const browser = plan.commands.some(command => command.includes('test:run') || command.includes('test:account-layout') || command.some(value => /rc-light-web-browser|tests\/scripts$/.test(value)));
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `browser=${browser}\n`);
  }
  if (args.includes('--plan')) return;
  if (mode === 'check') {
    const directory = path.join(root, '.test-data/development-validation');
    let envelope; let key;
    try { envelope = JSON.parse(fs.readFileSync(path.join(directory, 'frozen.json'))); key = fs.readFileSync(path.join(directory, 'local-key')); } catch {}
    if (!valid(envelope, key, fingerprint(root, environment), frozen.commands)) throw new Error('no_valid_frozen_receipt');
    console.log(`development-only: valid frozen receipt ${envelope.receipt.id}`); return;
  }
  run(root, mode, environment, plan);
}
module.exports = { safePath, files, fingerprint, outputFingerprint, counts, select, contractTargets, valid, seal, run, frozen };
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
