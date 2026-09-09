#!/usr/bin/env node
'use strict';

const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const qleverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(qleverRoot, '..');
const requested = process.argv.find((arg) => arg.startsWith('--backend='));
const backend = requested?.slice('--backend='.length) ?? 'sqlite';
const prepareOnly = process.argv.includes('--prepare-only');

if (backend !== 'sqlite') {
  throw new Error(`unsupported backend ${backend}`);
}

const root = mkdtempSync(path.join(tmpdir(), 'xpod-rdf-backend-contract-'));

class CommandError extends Error {
  constructor(command, status, stdout, stderr) {
    super(`${command} failed with status ${status}`);
    this.status = status;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    throw new CommandError(command, result.status ?? 1, result.stdout ?? '', result.stderr ?? '');
  }
  return result.stdout;
}

function sharedLibrary(buildDir, name) {
  return path.join(
    buildDir,
    process.platform === 'darwin' ? `lib${name}.dylib` : `lib${name}.so`,
  );
}

function buildRunner() {
  const binary = path.join(root, 'xpod-rdf-backend-contract');
  run('c++', [
    '-std=c++17',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-I',
    path.join(qleverRoot, 'rdf_protocol/include'),
    path.join(qleverRoot, 'backend_contract/src/xpod_rdf_backend_contract.cpp'),
    '-ldl',
    '-o',
    binary,
  ]);
  return binary;
}

function buildProvider(directory, target) {
  const sourceDir = path.join(qleverRoot, directory);
  const buildDir = path.join(root, `${target}-build`);
  run('cmake', ['-S', sourceDir, '-B', buildDir]);
  run('cmake', ['--build', buildDir, '--target', target]);
  return sharedLibrary(buildDir, target);
}

function exercise(binary, provider, config, label) {
  return run(binary, [provider, JSON.stringify(config), label]).trim();
}

function bootstrapSqliteContractDatabase(databasePath) {
  const sql = `
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS rdf_terms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      value_head TEXT NOT NULL,
      datatype_id INTEGER,
      lang TEXT,
      hash TEXT NOT NULL,
      normalized_text TEXT,
      numeric_value REAL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS rdf_terms_identity_hash ON rdf_terms (hash);
    CREATE INDEX IF NOT EXISTS rdf_terms_kind_value_head ON rdf_terms (kind, value_head);
    CREATE INDEX IF NOT EXISTS rdf_terms_kind_datatype ON rdf_terms (kind, datatype_id);
    CREATE INDEX IF NOT EXISTS rdf_terms_kind_lang ON rdf_terms (kind, lang);
    CREATE INDEX IF NOT EXISTS rdf_terms_kind_numeric_value ON rdf_terms (kind, numeric_value);
    CREATE TABLE IF NOT EXISTS rdf_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL UNIQUE,
      workspace TEXT NOT NULL,
      local_path TEXT,
      content_type TEXT,
      last_indexed_at TEXT,
      source_version TEXT
    );
    CREATE TABLE IF NOT EXISTS rdf_quads (
      graph_id INTEGER NOT NULL,
      subject_id INTEGER NOT NULL,
      predicate_id INTEGER NOT NULL,
      object_id INTEGER NOT NULL,
      source_file_id INTEGER,
      source_line_no INTEGER,
      PRIMARY KEY (graph_id, subject_id, predicate_id, object_id),
      FOREIGN KEY (graph_id) REFERENCES rdf_terms(id),
      FOREIGN KEY (subject_id) REFERENCES rdf_terms(id),
      FOREIGN KEY (predicate_id) REFERENCES rdf_terms(id),
      FOREIGN KEY (object_id) REFERENCES rdf_terms(id),
      FOREIGN KEY (source_file_id) REFERENCES rdf_sources(id)
    );
    CREATE INDEX IF NOT EXISTS rdf_quads_spog ON rdf_quads(subject_id, predicate_id, object_id, graph_id);
    CREATE INDEX IF NOT EXISTS rdf_quads_sopg ON rdf_quads(subject_id, object_id, predicate_id, graph_id);
    CREATE INDEX IF NOT EXISTS rdf_quads_psog ON rdf_quads(predicate_id, subject_id, object_id, graph_id);
    CREATE INDEX IF NOT EXISTS rdf_quads_posg ON rdf_quads(predicate_id, object_id, subject_id, graph_id);
    CREATE INDEX IF NOT EXISTS rdf_quads_ospg ON rdf_quads(object_id, subject_id, predicate_id, graph_id);
    CREATE INDEX IF NOT EXISTS rdf_quads_opsg ON rdf_quads(object_id, predicate_id, subject_id, graph_id);
    CREATE INDEX IF NOT EXISTS rdf_quads_gspo ON rdf_quads(graph_id, subject_id, predicate_id, object_id);
    CREATE INDEX IF NOT EXISTS rdf_quads_gpos ON rdf_quads(graph_id, predicate_id, object_id, subject_id);
    CREATE INDEX IF NOT EXISTS rdf_quads_source ON rdf_quads(source_file_id);
    CREATE TABLE IF NOT EXISTS rdf_index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO rdf_index_metadata(key, value) VALUES ('data_version', '0');
    INSERT OR IGNORE INTO rdf_index_metadata(key, value) VALUES ('schema_version', '1');
  `;
  run('sqlite3', [databasePath], { input: sql });
}

function contractDigestPayload(evidence) {
  return JSON.stringify({
    schemaVersion: evidence.schemaVersion,
    backend: evidence.backend,
    callbackCoverage: evidence.callbackCoverage,
    rowDigest: evidence.rowDigest,
    scopeOutcomes: evidence.scopeOutcomes,
    versions: evidence.versions,
  });
}

function attachContractDigest(rawEvidence) {
  const evidence = JSON.parse(rawEvidence);
  evidence.evidenceDigest = crypto
    .createHash('sha256')
    .update(contractDigestPayload(evidence))
    .digest('hex');
  return JSON.stringify(evidence);
}

function pendingEvidence(reason) {
  return {
    schemaVersion: 1,
    backend: 'sqlite',
    status: 'pending-live-runtime',
    reason,
    callbackCoverage: {},
    rowDigest: null,
    scopeOutcomes: {},
    versions: null,
    unsupportedOptionalLeaves: [],
  };
}

try {
  const databasePath = process.env.XPOD_QLEVER_SQLITE_DB;
  if (!databasePath) {
    process.stdout.write(
      `${JSON.stringify(pendingEvidence('XPOD_QLEVER_SQLITE_DB not provided'))}\n`,
    );
    process.exitCode = 0;
  } else if (prepareOnly) {
    bootstrapSqliteContractDatabase(databasePath);
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      backend: 'sqlite',
      status: 'prepared',
      databasePath,
    })}\n`);
  } else {
    bootstrapSqliteContractDatabase(databasePath);
    const runner = buildRunner();
    const provider = buildProvider('rdf_sqlite_backend', 'xpod_rdf_sqlite_backend');
    const evidence = exercise(
      runner,
      provider,
      {
        databasePath,
        readOnly: false,
      },
      'sqlite',
    );
    process.stdout.write(`${attachContractDigest(evidence)}\n`);
  }
} catch (error) {
  if (error instanceof CommandError) {
    process.stderr.write(error.stdout);
    process.stderr.write(error.stderr);
    process.exitCode = error.status;
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
