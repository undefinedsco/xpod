#!/usr/bin/env bun
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hashTree, digest } = require('./lib/build-inputs.cjs');

const packageDirectories = ['solid-sdk', 'shared-ui', 'pod-collections', 'extension-sdk', 'ai-connections', 'pod-settings', 'tasks'];
function graph(root) {
  const rows = packageDirectories.map(directory => ({ directory: `packages/${directory}`, ...JSON.parse(fs.readFileSync(path.join(root, 'packages', directory, 'package.json'))) }));
  const names = new Set(rows.map(row => row.name));
  return rows.map(row => ({ ...row, upstream: Object.keys({ ...row.dependencies, ...row.devDependencies, ...row.peerDependencies }).filter(name => names.has(name)) }));
}
function order(rows, selected) {
  const result = []; const seen = new Set(); const active = new Set();
  const visit = name => {
    if (seen.has(name)) return;
    if (active.has(name)) throw new Error('workspace_dependency_cycle');
    const row = rows.find(row => row.name === name);
    if (!row) throw new Error(`unknown_workspace:${name}`);
    active.add(name); row.upstream.forEach(visit); active.delete(name); seen.add(name); result.push(row);
  };
  (selected.length ? selected : rows.map(row => row.name)).forEach(visit);
  return result;
}
function build(root, selected = [], execute = row => spawnSync('bun', ['run', 'build'], { cwd: path.join(root, row.directory), stdio: 'inherit' })) {
  const rows = order(graph(root), selected); const results = [];
  const cache = path.join(root, '.test-data/workspace-builds'); fs.mkdirSync(cache, { recursive: true });
  const tools = ['bun', 'node'].map(command => { const result = spawnSync(command, ['--version'], { encoding: 'utf8' }); if (result.status !== 0) throw new Error('toolchain_unavailable'); return result.stdout.trim(); });
  // Include build helpers and all root configuration rather than guessing their dependencies.
  const shared = digest(JSON.stringify({ tools, platform: process.platform, arch: process.arch,
    inputs: ['scripts/fix-dist-js-imports.mjs', 'scripts/build-workspace-packages.cjs', 'scripts/lib/build-inputs.cjs', 'bun.lock', 'package.json',
      ...fs.readdirSync(root).filter(file => /^tsconfig[^/]*$/.test(file))].filter(file => fs.existsSync(path.join(root, file))).map(file => [file, digest(fs.readFileSync(path.join(root, file)))]),
    patches: fs.existsSync(path.join(root, 'patches')) ? hashTree(path.join(root, 'patches')) : [],
  }));
  const inputs = new Map();
  for (const row of rows) {
    const start = performance.now();
    const compiler = spawnSync('bun', ['x', '--no-install', 'tsc', '--version'], { cwd: path.join(root, row.directory), encoding: 'utf8' });
    if (compiler.status !== 0) throw new Error('workspace_compiler_unavailable');
    const input = digest(JSON.stringify({ shared, compiler: compiler.stdout.trim(), own: hashTree(path.join(root, row.directory), file => !/^(dist|node_modules|test|tests)\//.test(file)), upstream: row.upstream.map(name => inputs.get(name)) }));
    inputs.set(row.name, input);
    const outputRoot = path.join(root, row.directory, 'dist');
    const outputs = () => fs.existsSync(outputRoot) ? hashTree(outputRoot) : [];
    const receiptPath = path.join(cache, `${path.basename(row.directory)}.json`);
    let receipt; try { receipt = JSON.parse(fs.readFileSync(receiptPath)); } catch {}
    const before = outputs();
    const reusable = receipt?.input === input && before.length > 0 && JSON.stringify(receipt.outputs) === JSON.stringify(before);
    if (!reusable) {
      // A deleted source must not leave stale emitted members in packages whose build
      // command doesn't clean dist itself.
      fs.rmSync(outputRoot, { recursive: true, force: true });
      const result = execute(row);
      if (result.status !== 0 || result.signal) throw new Error(`workspace_build_failed:${row.name}`);
      const after = outputs(); if (!after.length) throw new Error(`workspace_output_missing:${row.name}`);
      fs.writeFileSync(receiptPath, JSON.stringify({ input, outputs: after }));
    }
    const result = { name: row.name, action: reusable ? 'reused' : 'built', durationMs: Math.round(performance.now() - start) };
    results.push(result); console.log(JSON.stringify(result));
  }
  fs.appendFileSync(path.join(cache, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), results })}\n`);
  return results;
}
module.exports = { graph, order, build };
if (require.main === module) { try { build(process.cwd(), process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
