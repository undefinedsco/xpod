/**
 * Native gate for the RDF SQLite backend plugin.
 *
 * Builds the backend as a loadable shared plugin (no QLever engine required),
 * creates the facts schema the product's RdfQuadIndex owns, then drives the
 * plugin through its C ABI from a compiled harness: insert a quad, resolve the
 * term back, count it through a permutation scan, and delete it again.
 *
 *   bun scripts/check-rdf-sqlite-backend-plugin.ts
 *
 * The harness fails closed: a plugin that cannot open a schema-correct database
 * or round-trip a quad exits non-zero.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { $ } from 'bun';

const ROOT = path.resolve(import.meta.dir, '..');
const BACKEND_DIR = path.join(ROOT, 'qlever', 'rdf_sqlite_backend');
const WORK_DIR = path.join(ROOT, '.test-data', 'rdf-sqlite-plugin');
// Keep build output out of the source tree; the packaged runtime builds its own
// static copy inside the image.
const BUILD_DIR = process.env.XPOD_RDF_SQLITE_BACKEND_BUILD_DIR ?? path.join(WORK_DIR, 'build');
const HARNESS = path.join(WORK_DIR, 'sqlite-plugin-smoke');
const DATABASE = path.join(WORK_DIR, 'facts.sqlite');
const SEEDED_DATABASE = path.join(WORK_DIR, 'seeded.sqlite');
const SCHEMA_VERSION = '1';

/** Column/index contract the backend verifies before it serves any query. */
const FACTS_SCHEMA = `
CREATE TABLE rdf_terms (
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
CREATE UNIQUE INDEX rdf_terms_identity_hash ON rdf_terms (hash);
CREATE INDEX rdf_terms_kind_value_head ON rdf_terms (kind, value_head);
CREATE INDEX rdf_terms_kind_datatype ON rdf_terms (kind, datatype_id);
CREATE INDEX rdf_terms_kind_lang ON rdf_terms (kind, lang);
CREATE INDEX rdf_terms_kind_numeric_value ON rdf_terms (kind, numeric_value);

CREATE TABLE rdf_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL UNIQUE,
  workspace TEXT NOT NULL,
  local_path TEXT,
  content_type TEXT,
  last_indexed_at TEXT,
  source_version TEXT
);

CREATE TABLE rdf_quads (
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
CREATE INDEX rdf_quads_spog ON rdf_quads(subject_id, predicate_id, object_id, graph_id);
CREATE INDEX rdf_quads_sopg ON rdf_quads(subject_id, object_id, predicate_id, graph_id);
CREATE INDEX rdf_quads_psog ON rdf_quads(predicate_id, subject_id, object_id, graph_id);
CREATE INDEX rdf_quads_posg ON rdf_quads(predicate_id, object_id, subject_id, graph_id);
CREATE INDEX rdf_quads_ospg ON rdf_quads(object_id, subject_id, predicate_id, graph_id);
CREATE INDEX rdf_quads_opsg ON rdf_quads(object_id, predicate_id, subject_id, graph_id);
CREATE INDEX rdf_quads_gspo ON rdf_quads(graph_id, subject_id, predicate_id, object_id);
CREATE INDEX rdf_quads_gpos ON rdf_quads(graph_id, predicate_id, object_id, subject_id);
CREATE INDEX rdf_quads_source ON rdf_quads(source_file_id);

CREATE TABLE rdf_index_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO rdf_index_metadata (key, value) VALUES ('data_version', '0');
INSERT INTO rdf_index_metadata (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
`;

function createFactsDatabase(file: string): void {
  const db = new Database(file, { create: true });
  try {
    db.exec(FACTS_SCHEMA);
  } finally {
    db.close();
  }
}

/** One quad seeded the way the product index writes it, for the read-path check. */
function seedFactsDatabase(file: string): void {
  const db = new Database(file, { create: true });
  try {
    db.exec(FACTS_SCHEMA);
    db.exec(`
INSERT INTO rdf_terms (id, kind, value, value_head, datatype_id, lang, hash)
  VALUES (1, 'iri', 'https://pod.example/alice/.data/chat/x/2026/09/23/messages.ttl#msg_1', 'https://pod.example/alice/.data/chat/x/2026/09/23/messages.ttl#msg_1', NULL, NULL, 'seed-subject');
INSERT INTO rdf_terms (id, kind, value, value_head, datatype_id, lang, hash, datatype_id)
  VALUES (2, 'iri', 'http://rdfs.org/sioc/ns#content', 'http://rdfs.org/sioc/ns#content', NULL, NULL, 'seed-predicate', NULL);
INSERT INTO rdf_terms (id, kind, value, value_head, datatype_id, lang, hash)
  VALUES (3, 'literal', 'hello from the sqlite plugin', 'hello from the sqlite plugin', NULL, NULL, 'seed-object');
INSERT INTO rdf_quads (graph_id, subject_id, predicate_id, object_id, source_file_id, source_line_no)
  VALUES (1, 1, 2, 3, NULL, NULL);
UPDATE rdf_index_metadata SET value = '1' WHERE key = 'data_version';
`);
  } finally {
    db.close();
  }
}

function pluginFileName(): string {
  if (process.platform === 'darwin') return 'libxpod_rdf_sqlite_backend.dylib';
  if (process.platform === 'win32') return 'xpod_rdf_sqlite_backend.dll';
  return 'libxpod_rdf_sqlite_backend.so';
}

async function main(): Promise<void> {
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });

  const nlohmannPrefix = process.env.XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS
    ?? (await $`brew --prefix nlohmann-json`.quiet().nothrow()).stdout.toString().trim();
  if (!nlohmannPrefix) {
    throw new Error('nlohmann/json headers are required; set XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS');
  }
  // `<prefix>/include` holds nlohmann/json.hpp; a bare prefix would not resolve it.
  const nlohmann = nlohmannPrefix.endsWith('/include') ? nlohmannPrefix : path.join(nlohmannPrefix, 'include');

  const configure = [
    'cmake', '-S', BACKEND_DIR, '-B', BUILD_DIR, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release',
    '-DXPOD_RDF_SQLITE_BACKEND_SHARED=ON',
    `-DXPOD_QLEVER_SOURCE_DIR=${path.join(ROOT, 'qlever')}`,
    `-DXPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS=${nlohmann}`,
  ];
  const configured = await $`${configure}`.quiet().nothrow();
  if (configured.exitCode !== 0) {
    throw new Error(`cmake configure failed:\n${configured.stderr.toString()}`);
  }
  const built = await $`cmake --build ${BUILD_DIR} -j 4`.quiet().nothrow();
  if (built.exitCode !== 0) {
    throw new Error(`cmake build failed:\n${built.stderr.toString()}`);
  }

  const plugin = path.join(BUILD_DIR, pluginFileName());
  if (!(await Bun.file(plugin).exists())) {
    throw new Error(`Plugin was not produced: ${plugin}`);
  }

  createFactsDatabase(DATABASE);
  seedFactsDatabase(SEEDED_DATABASE);

  const compile = [
    'cc', '-O1', '-Wall', '-Wextra', '-Werror', '-o', HARNESS,
    path.join(ROOT, 'qlever', 'tests', 'xpod_rdf_sqlite_plugin_smoke.c'),
    '-I', path.join(BACKEND_DIR, 'include'),
    '-I', path.join(ROOT, 'qlever', 'rdf_protocol', 'include'),
    '-ldl',
  ];
  const compiled = await $`${compile}`.quiet().nothrow();
  if (compiled.exitCode !== 0) {
    throw new Error(`Harness compilation failed:\n${compiled.stderr.toString()}`);
  }

  const result = await $`${HARNESS} ${plugin} ${DATABASE} ${SEEDED_DATABASE}`.nothrow();
  const output = result.stdout.toString() + result.stderr.toString();
  process.stdout.write(output);
  if (result.exitCode !== 0) {
    throw new Error(`RDF SQLite backend plugin gate failed with exit code ${result.exitCode}`);
  }
}

await main();
