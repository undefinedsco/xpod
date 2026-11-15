'use strict';
/**
 * RC373 regression: the service build/pack stage runs inside the Docker build
 * context produced from the *working directory* plus `.dockerignore`, not from
 * the Git index. A file that is imported at module level but not allowlisted
 * exists in Git and in every local test run, and only disappears in the real
 * image build.
 *
 * RC144 follow-up: the frontend build stage rewrites `static/app/assets` before
 * the service pack step, so the tracked hashed bundle is replaced by a newly
 * generated one. Driving the inventory from `git ls-files` therefore copies a
 * path that no longer exists. The inventory below walks the real tree, so it
 * sees the generated asset and skips the deleted one, and any name it does
 * report must exist: a missing file fails loudly, never silently.
 *
 * The test therefore (1) trims the working tree with a Docker-compatible
 * matcher, (2) materialises that exact context under `.test-data`, and (3) runs
 * the real `scripts/service-pack-parent.py` and the real Node pack entry from
 * inside it.
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
    rules.push({negate, pattern, expression: new RegExp('^' + source + '$', 'u')});
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

/** Conservative prune test: a directory that no negation could re-open cannot
 * contribute an included file. Only negated patterns matter, and their literal
 * prefix is enough to decide. Never prunes a directory that might match. */
function reOpenable(prefixes, directory) {
  return prefixes.some(prefix => prefix === directory
    || prefix.startsWith(directory + '/')
    || directory === '');
}

/** Inventory the ACTUAL working directory (the Docker build context), not the
 * Git index. Generated-but-not-ignored files are included; deleted tracked
 * files are simply absent. This fixture supports regular files; an included
 * symlink fails explicitly instead of being skipped or following its target. */
function inventory(root, rules) {
  // A negation whose literal prefix is empty (e.g. `!*/keep`) could re-open any
  // directory, so it disables pruning entirely. Better a slower walk than a
  // context that silently drops a re-included file.
  const negations = rules.filter(rule => rule.negate);
  const prefixes = negations.map(rule => {
    const segments = rule.pattern.split('/');
    const wildcard = segments.findIndex(segment => /[*?[]/u.test(segment));
    return (wildcard < 0 ? segments : segments.slice(0, wildcard)).join('/');
  });
  const prune = prefixes.every(prefix => prefix.length > 0);
  const found = [];
  const walk = (directory, relative) => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) {
        assert.equal(included(rules, name), false, `unsupported symlink in build context: ${name}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (prune && !included(rules, name) && !reOpenable(prefixes, name)) continue;
        walk(path.join(directory, entry.name), name);
        continue;
      }
      if (!entry.isFile()) continue;
      if (included(rules, name)) found.push(name);
    }
  };
  walk(root, '');
  return found.sort();
}

/** Copy the inventoried context. Every listed path must exist as a regular file
 * at the moment of the copy: an inventory/copy drift is a hard failure, never a
 * skipped file. */
function materialise(source, destination, files) {
  fs.mkdirSync(destination, {recursive: true});
  for (const file of files) {
    const from = path.join(source, file);
    let stat;
    try {
      stat = fs.lstatSync(from);
    } catch (error) {
      throw new Error(`build context inventory names a missing file: ${file} (${error.code})`);
    }
    assert.ok(stat.isFile(), `build context entry is not a regular file: ${file}`);
    const target = path.join(destination, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(from, target);
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

test('the inventory follows the working tree, so a regenerated asset replaces its tracked name', () => {
  const fixture = fs.mkdtempSync(path.join(TEMP, 'service-pack-context-fixture-'));
  try {
    const write = (relative, body) => {
      const target = path.join(fixture, relative);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, body);
    };
    // The committed bundle (tracked name) is deleted by the build stage, and a
    // newly generated hashed bundle appears in its place.
    write('static/app/assets/index-OLD.js', '{"stale":true}');
    execFileSync('git', ['init', '--quiet', fixture]);
    execFileSync('git', ['-C', fixture, 'add', '--', 'static/app/assets/index-OLD.js']);
    fs.unlinkSync(path.join(fixture, 'static/app/assets/index-OLD.js'));
    write('static/app/assets/index-NEW.js', '{"generated":true}');
    assert.deepEqual(execFileSync('git', ['-C', fixture, 'ls-files', '-z']).toString().split('\0').filter(Boolean),
      ['static/app/assets/index-OLD.js']);
    write('scripts/lib/keep.json', '{"kept":true}');
    write('scripts/lib/dropped.json', '{"kept":false}');
    const rules = compile(['*', '!static/app/assets/', '!scripts/lib/keep.json'].join('\n'));

    const files = inventory(fixture, rules);
    assert.ok(files.includes('static/app/assets/index-NEW.js'),
      'the generated asset must be in the context');
    assert.equal(files.includes('static/app/assets/index-OLD.js'), false,
      'a tracked-but-deleted asset cannot be copied and must not be listed');
    assert.ok(files.includes('scripts/lib/keep.json'));
    assert.equal(files.includes('scripts/lib/dropped.json'), false);

    const context = path.join(fixture, 'context');
    materialise(fixture, context, files);
    assert.equal(fs.readFileSync(path.join(context, 'static/app/assets/index-NEW.js'), 'utf8'),
      '{"generated":true}');
    // Drift between the inventory and the tree is a hard error, not a skip.
    assert.throws(() => materialise(fixture, path.join(fixture, 'broken'),
      ['static/app/assets/index-DELETED.js']), /missing file.*index-DELETED\.js/u);
    assert.equal(fs.existsSync(path.join(fixture, 'broken', 'static/app/assets/index-DELETED.js')), false);
  } finally {
    fs.rmSync(fixture, {recursive: true, force: true});
  }
});

test('the trimmed build context imports the real service pack parent', () => {
  const rules = compile(fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8'));
  const files = inventory(ROOT, rules);
  assert.ok(files.includes('.dockerignore'));
  assert.ok(files.includes('scripts/service-pack-parent.py'));
  assert.ok(files.includes('scripts/service-build-observations.py'));
  assert.ok(files.includes('scripts/lib/module-artifact-limits.json'));
  assert.ok(files.includes('scripts/lib/service-workspace-build-scope.json'),
    'the build context must carry the workspace build scope read at module level');
  // Whatever the frontend build produced for the hashed bundle is what the
  // context contains; the tracked name is not authority.
  const assets = files.filter(file => file.startsWith('static/app/assets/'));
  assert.ok(assets.some(file => /^static\/app\/assets\/index-[^/]+\.js$/u.test(file)),
    'the context must contain the actual current app bundle');

  const root = ownedRoot('present');
  try {
    const context = path.join(root, 'context');
    materialise(ROOT, context, files);
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
  const files = inventory(ROOT, rules);
  assert.equal(files.includes('scripts/lib/service-workspace-build-scope.json'), false);

  const root = ownedRoot('missing');
  try {
    const context = path.join(root, 'context');
    materialise(ROOT, context, files);
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
