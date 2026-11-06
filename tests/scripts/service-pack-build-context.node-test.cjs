'use strict';
/**
 * RC373 regression: the service build/pack stage runs inside the Docker build
 * context produced by `.dockerignore`, not inside the checkout. A file that is
 * imported at module level but not allowlisted exists in Git and in every local
 * test run, and only disappears in the real image build.
 *
 * This test therefore (1) trims the tracked tree with a Docker-compatible
 * matcher, (2) materialises that exact context under `.test-data`, and (3) runs
 * the real `scripts/service-pack-parent.py` and the real Node pack entry from
 * inside it. A missing allowlist entry fails as FileNotFoundError here, before
 * any image is built.
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync, execFileSync} = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const TEMP = path.join(ROOT, '.test-data');

/** Docker `.dockerignore` semantics used by the daemon: rules are evaluated in
 * order against the path and every ancestor; the LAST match decides; `!`
 * re-includes a path (and implicitly its parents). */
function compile(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    let pattern = (negate ? line.slice(1) : line).replace(/^\/+/u, '').replace(/\/+$/u, '');
    if (!pattern) continue;
    const source = pattern.split('/').map(segment => segment === '**' ? '.*'
      : segment === '*' ? '[^/]*'
        : segment.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '[^/]*')
          .replace(/\?/gu, '[^/]')).join('/');
    rules.push({negate, expression: new RegExp('^' + source + '$', 'u')});
  }
  return rules;
}

function included(rules, file) {
  const parts = file.split('/');
  const candidates = [];
  for (let at = 1; at <= parts.length; at += 1) candidates.push(parts.slice(0, at).join('/'));
  let verdict = false;
  for (const rule of rules) if (candidates.some(candidate => rule.expression.test(candidate))) verdict = rule.negate;
  return verdict;
}

function tracked() {
  return execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], {maxBuffer: 64 * 1024 * 1024})
    .toString().split('\0').filter(Boolean);
}

function materialise(destination, files) {
  fs.mkdirSync(destination, {recursive: true});
  for (const file of files) {
    const target = path.join(destination, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(path.join(ROOT, file), target);
  }
}

function ownedRoot(label) {
  return fs.mkdtempSync(path.join(TEMP, `service-pack-context-${label}-`));
}

test('the matcher follows the daemon rules (last match wins, negation re-includes)', () => {
  const rules = compile(['*', '!scripts/lib/keep.json', '', '# comment', '!qlever/',
    'qlever/scripts/drop.py', '!scripts/lib/keep.json'].join('\n'));
  assert.equal(included(rules, 'scripts/lib/keep.json'), true);
  assert.equal(included(rules, 'scripts/lib/other.json'), false);
  assert.equal(included(rules, 'qlever/scripts/bind.py'), true);
  assert.equal(included(rules, 'qlever/scripts/drop.py'), false);
  // Re-ignoring an ancestor after a negation wins for its children.
  const later = compile(['*', '!scripts/lib/keep.json', 'scripts/'].join('\n'));
  assert.equal(included(later, 'scripts/lib/keep.json'), false);
});

test('the trimmed build context imports the real service pack parent', () => {
  const text = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  const rules = compile(text);
  const files = tracked().filter(file => included(rules, file));
  assert.ok(files.includes('.dockerignore'));
  assert.ok(files.includes('scripts/service-pack-parent.py'));
  assert.ok(files.includes('scripts/service-build-observations.py'));
  assert.ok(files.includes('scripts/lib/module-artifact-limits.json'));
  assert.ok(files.includes('scripts/lib/service-workspace-build-scope.json'),
    'the build context must carry the workspace build scope read at module level');

  const root = ownedRoot('present');
  try {
    const context = path.join(root, 'context');
    materialise(context, files);
    // Real entry point, real module graph, cwd inside the trimmed context.
    const help = spawnSync('python3', ['scripts/service-pack-parent.py', '--help'],
      {cwd: context, encoding: 'utf8', timeout: 120000,
        env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}});
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--include-build/u);

    // The Node pack entry (the non-source-SHA branch of the same Docker step)
    // must also resolve its full local require closure from the same context.
    const nodeClosure = spawnSync(process.execPath,
      ['-e', "require('./scripts/run-npm-pack.cjs');require('./scripts/prepare-package-manifest.cjs')"],
      {cwd: context, encoding: 'utf8', timeout: 120000});
    assert.equal(nodeClosure.status, 0, nodeClosure.stderr);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('dropping the scope allowlist reproduces the RC373 FileNotFoundError', () => {
  const text = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  const line = '!scripts/lib/service-workspace-build-scope.json';
  assert.ok(text.split(/\r?\n/u).includes(line));
  const without = text.split(/\r?\n/u).filter(row => row !== line).join('\n');
  const rules = compile(without);
  const files = tracked().filter(file => included(rules, file));
  assert.equal(files.includes('scripts/lib/service-workspace-build-scope.json'), false);

  const root = ownedRoot('missing');
  try {
    const context = path.join(root, 'context');
    materialise(context, files);
    const help = spawnSync('python3', ['scripts/service-pack-parent.py', '--help'],
      {cwd: context, encoding: 'utf8', timeout: 120000,
        env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}});
    assert.notEqual(help.status, 0);
    assert.match(help.stderr, /service-workspace-build-scope\.json/u);
    assert.match(help.stderr, /FileNotFoundError/u);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
