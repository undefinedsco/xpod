#!/usr/bin/env node
'use strict';

// Strict quick gate for two live-handle default-graph regressions. The fixture
// uses production protocol headers, production schema initialization and real
// production term hashes; no private approximation of the storage contract.
const { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const qleverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(qleverRoot, '..');
const fixture = path.join(qleverRoot, 'tests/fixtures/default_graph_cache_regression.cpp');
const compileOnly = process.argv.includes('--compile-only');
const compiler = process.env.CXX || 'c++';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', ...options });
  if (result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${detail}`);
  }
  return result.stdout;
}

function dependencyFlags() {
  const pkg = spawnSync('pkg-config', ['--cflags', '--libs', 'openssl', 'sqlite3'], { encoding: 'utf8' });
  if (pkg.status === 0) return pkg.stdout.trim().split(/\s+/u).filter(Boolean);
  if (process.platform === 'darwin') {
    const prefix = run('brew', ['--prefix', 'openssl@3']).trim();
    return ['-I' + path.join(prefix, 'include'), '-L' + path.join(prefix, 'lib'), '-lcrypto', '-lsqlite3'];
  }
  throw new Error('Native regression requires pkg-config metadata for OpenSSL and SQLite (or Homebrew openssl@3 on macOS).');
}

function architectureFlags(flags) {
  if (process.platform !== 'darwin') return [];
  // A Rosetta Node process can make clang target x86_64 while pkg-config finds
  // arm64 Homebrew libraries. Select once from the actual library architectures.
  const libDirs = flags.filter(flag => flag.startsWith('-L')).map(flag => flag.slice(2));
  const libraries = ['libcrypto.dylib', 'libsqlite3.dylib'].map(name =>
    libDirs.map(dir => path.join(dir, name)).find(existsSync)).filter(Boolean);
  if (!libraries.some(library => path.basename(library) === 'libcrypto.dylib')) {
    throw new Error('Cannot identify the OpenSSL library architecture from dependency link paths.');
  }
  const architectures = libraries.map(library => run('lipo', ['-archs', library]).trim().split(/\s+/u));
  const arm = spawnSync('sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' });
  const runnable = arm.status === 0 && arm.stdout.trim() === '1' ? ['arm64', 'x86_64'] : ['x86_64'];
  const selected = runnable.find(arch => architectures.every(supported => supported.includes(arch)));
  if (!selected) throw new Error(`Native regression dependencies have no common runnable architecture: ${libraries.join(', ')}`);
  return ['-arch', selected];
}

function jsonIncludeDirs() {
  const configured = (process.env.XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS || '').split(';').filter(Boolean);
  const candidates = [...configured, '/opt/homebrew/include', '/usr/local/include', '/usr/include'];
  const dirs = [...new Set(candidates)].filter(dir => existsSync(path.join(dir, 'nlohmann/json.hpp')));
  if (dirs.length === 0) throw new Error('nlohmann/json.hpp is required; set XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS to its include directory.');
  return dirs;
}

const scope = path.join(repoRoot, '.test-data', 'qlever-default-graph-cache');
mkdirSync(scope, { recursive: true });
const root = mkdtempSync(path.join(scope, 'run-'));
try {
  const shared = path.join(root, process.platform === 'darwin' ? 'backend.dylib' : 'backend.so');
  const binary = path.join(root, 'default_graph_cache_regression');
  const dependencies = dependencyFlags();
  const architecture = architectureFlags(dependencies);
  const strict = ['-Wall', '-Wextra', '-Werror'];
  const includes = [
    '-I', path.join(qleverRoot, 'rdf_protocol/include'),
    '-I', path.join(qleverRoot, 'rdf_sqlite_backend/include'),
    '-I', path.join(qleverRoot, 'include'),
    ...jsonIncludeDirs().flatMap(dir => ['-isystem', dir]),
  ];
  run(compiler, [
    '-std=c++20', '-fPIC', '-shared', '-O1', ...strict, ...architecture, ...includes,
    path.join(qleverRoot, 'rdf_sqlite_backend/src/xpod_rdf_sqlite_backend.cpp'),
    ...dependencies, '-o', shared,
  ]);
  run(compiler, [
    '-std=c++17', '-O1', ...strict, ...architecture,
    '-I', path.join(qleverRoot, 'rdf_protocol/include'), fixture,
    ...dependencies, '-ldl', '-o', binary,
  ]);
  process.stdout.write(`COMPILE strict=1 architecture=${architecture[1] || run(compiler, ['-dumpmachine']).trim()}\n`);
  if (!compileOnly) {
    const databases = ['regression1.sqlite', 'regression2.sqlite', 'seed.sqlite'].map(name => path.join(root, name));
    const bootstrap = path.join(root, 'bootstrap.ts');
    writeFileSync(bootstrap, `
      import { RdfQuadIndex } from ${JSON.stringify(path.join(repoRoot, 'src/storage/rdf/RdfQuadIndex.ts'))};
      import { DataFactory } from 'n3';
      import { Database } from 'bun:sqlite';
      const databases = process.argv.slice(2);
      for (const [position, database] of databases.entries()) {
        const index = new RdfQuadIndex({ path: database });
        index.open();
        try {
          if (position === 2) index.put(DataFactory.quad(
            DataFactory.namedNode('urn:xpod:cross'), DataFactory.namedNode('urn:xpod:p'),
            DataFactory.literal(JSON.stringify({ note: 'cross "quoted"', path: 'C:\\\\data' })), DataFactory.defaultGraph()));
        } finally { index.close(); }
        const db = new Database(database, { readonly: true });
        try {
          if (db.query('PRAGMA foreign_key_check').all().length) throw new Error('Production seed violates foreign keys');
        } finally { db.close(); }
      }
      console.log('SCHEMA production=1 hashes=production');
    `);
    process.stdout.write(run('bun', ['--no-env-file', bootstrap, ...databases]));
    for (const mode of ['1', '2']) {
      process.stdout.write(run(binary, [shared, ...databases, mode]));
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
