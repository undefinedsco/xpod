#!/usr/bin/env node

const readline = require('node:readline');
const { DataFactory, Parser, Store } = require('n3');
const { Parser: SparqlParser } = require('sparqljs');

const modeArg = process.argv.find((value) => value.startsWith('--mode='));
const mode = modeArg?.slice('--mode='.length) || 'normal';
const sqlitePathArgIndex = process.argv.indexOf('--sqlite-path');
const sqlitePath = process.argv.find((value) => value.startsWith('--sqlite-path='))?.slice('--sqlite-path='.length)
  || (sqlitePathArgIndex >= 0 ? process.argv[sqlitePathArgIndex + 1] : undefined);
let queryEngine;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function nativeResult(overrides = {}) {
  return {
    status: 'ok',
    mediaType: 'application/sparql-results+json',
    body: JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }),
    profile: { pid: process.pid },
    ...overrides,
  };
}

function termToPreparedJson(term) {
  switch (term.termType) {
    case 'NamedNode':
      return { type: 'uri', value: term.value };
    case 'Literal': {
      const value = { type: 'literal', value: term.value };
      if (term.language) {
        value['xml:lang'] = term.language;
      } else if (term.datatype?.value) {
        value.datatype = term.datatype.value;
      }
      return value;
    }
    case 'BlankNode':
      return { type: 'bnode', value: term.value };
    default:
      throw new Error(`unsupported prepared term ${term.termType}`);
  }
}

function collectPreparedTriples(items, operation, fallbackGraph) {
  const rows = [];
  for (const item of items || []) {
    if (item.type === 'graph') {
      rows.push(...collectPreparedTriples(item.triples, operation, item.name?.value || fallbackGraph));
      continue;
    }
    if (item.subject && item.predicate && item.object) {
      rows.push({
        operation,
        graph: fallbackGraph,
        quad: {
          subject: termToPreparedJson(item.subject),
          predicate: termToPreparedJson(item.predicate),
          object: termToPreparedJson(item.object),
          graph: { type: 'uri', value: fallbackGraph },
        },
      });
    }
  }
  return rows;
}

function prepareUpdateDelta(sparql, options) {
  const parser = new SparqlParser({ baseIRI: options?.basePath || 'urn:xpod:integration:', skipValidation: true });
  const parsed = parser.parse(sparql);
  const rows = [];
  for (const update of parsed.updates || []) {
    if (update.updateType === 'insert') {
      rows.push(...collectPreparedTriples(update.insert, 'insert', options?.sourceUri || options?.basePath));
      continue;
    }
    if (update.updateType === 'delete') {
      rows.push(...collectPreparedTriples(update.delete, 'delete', options?.sourceUri || options?.basePath));
      continue;
    }
    throw new Error(`fake QLever prepared update only supports INSERT DATA and DELETE DATA, got ${update.updateType}`);
  }
  const byGraph = new Map();
  for (const row of rows) {
    if (!row.graph) {
      throw new Error('prepared update requires a graph IRI');
    }
    let graph = byGraph.get(row.graph);
    if (!graph) {
      graph = { graphIri: row.graph, sourceUri: row.graph, deletes: [], inserts: [] };
      byGraph.set(row.graph, graph);
    }
    if (row.operation === 'insert') {
      graph.inserts.push(row.quad);
    } else {
      graph.deletes.push(row.quad);
    }
  }
  return { version: 1, graphs: [...byGraph.values()] };
}

function openFixtureDatabase() {
  if (!sqlitePath || sqlitePath.startsWith(':memory:')) {
    return undefined;
  }
  if (typeof Bun !== 'undefined') {
    const { Database } = require('bun:sqlite');
    return new Database(sqlitePath, { readonly: true });
  }
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(sqlitePath, { readOnly: true });
}

function loadFixtureStore(options) {
  const database = openFixtureDatabase();
  if (!database) {
    return new Store();
  }
  try {
    const quadColumns = database.prepare('PRAGMA table_info(rdf_quads)').all();
    const hasSourceFileId = quadColumns.some((column) => column.name === 'source_file_id');
    const rows = database.prepare(`
      SELECT
        graph.kind AS graph_kind,
        graph.value AS graph_value,
        subject.kind AS subject_kind,
        subject.value AS subject_value,
        predicate.kind AS predicate_kind,
        predicate.value AS predicate_value,
        object.kind AS object_kind,
        object.value AS object_value,
        object.lang AS object_lang,
        datatype.value AS object_datatype,
        ${hasSourceFileId ? 'source.source AS source_value' : 'NULL AS source_value'}
      FROM rdf_quads AS quad
      JOIN rdf_terms AS graph ON graph.id = quad.graph_id
      JOIN rdf_terms AS subject ON subject.id = quad.subject_id
      JOIN rdf_terms AS predicate ON predicate.id = quad.predicate_id
      JOIN rdf_terms AS object ON object.id = quad.object_id
      LEFT JOIN rdf_terms AS datatype ON datatype.id = object.datatype_id
      ${hasSourceFileId ? 'LEFT JOIN rdf_sources AS source ON source.id = quad.source_file_id' : ''}
      ORDER BY quad.rowid
    `).all();
    return new Store(rows
      .filter((row) => fixtureRowAllowed(row, options?.accessScope))
      .map((row) => DataFactory.quad(
        databaseTerm(row.subject_kind, row.subject_value),
        databaseTerm(row.predicate_kind, row.predicate_value),
        databaseTerm(row.object_kind, row.object_value, row.object_lang, row.object_datatype),
        databaseTerm(row.graph_kind, row.graph_value),
      )));
  } finally {
    database.close();
  }
}

function databaseTerm(kind, value, language, datatype) {
  if (kind === 'iri') {
    return DataFactory.namedNode(value);
  }
  if (kind === 'blank') {
    return DataFactory.blankNode(value);
  }
  if (kind === 'default_graph') {
    return DataFactory.defaultGraph();
  }
  if (language) {
    return DataFactory.literal(value, language);
  }
  return datatype
    ? DataFactory.literal(value, DataFactory.namedNode(datatype))
    : DataFactory.literal(value);
}

function fixtureRowAllowed(row, scope) {
  if (!scope) {
    return true;
  }
  const graph = row.graph_value;
  if (graph && !graph.startsWith(scope.basePath)) {
    return false;
  }
  if (scope.allowedGraphUrls?.length && !scope.allowedGraphUrls.includes(graph)) {
    return false;
  }
  if (scope.deniedGraphUrls?.includes(graph)) {
    return false;
  }
  if ((scope.deniedGraphPrefixes || []).some((prefix) => graph.startsWith(prefix))) {
    return false;
  }
  const source = row.source_value;
  if (source && scope.allowedSourceUrls?.length && !scope.allowedSourceUrls.includes(source)) {
    return false;
  }
  if (source && scope.deniedSourceUrls?.includes(source)) {
    return false;
  }
  return !(source && (scope.deniedSourcePrefixes || []).some((prefix) => source.startsWith(prefix)));
}

function fixtureQueryEngine() {
  if (!queryEngine) {
    const { QueryEngine } = require('@comunica/query-sparql-solid');
    queryEngine = new QueryEngine();
  }
  return queryEngine;
}

function fixtureQueryContext(store, options) {
  return {
    sources: [store],
    destination: store,
    unionDefaultGraph: true,
    baseIRI: options?.basePath || 'urn:xpod:integration:',
  };
}

async function executeFixtureQuery(sparql, options) {
  if (!sqlitePath) {
    return nativeResult({
      body: /^\s*ASK\b/i.test(sparql)
        ? JSON.stringify({ boolean: true })
        : JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }),
      profile: { pid: process.pid, options, fixtureProtocolOnly: true },
    });
  }
  const store = loadFixtureStore(options);
  const engine = fixtureQueryEngine();
  const result = await engine.query(sparql, fixtureQueryContext(store, options));
  const mediaType = options?.acceptMediaType || defaultResultMediaType(result.resultType);
  const serialized = await engine.resultToString(
    result,
    mediaType,
  );
  let body = '';
  for await (const chunk of serialized.data) {
    body += chunk;
  }
  return nativeResult({
    mediaType,
    body,
    profile: { pid: process.pid, options, fixtureEvaluator: 'comunica' },
  });
}

function defaultResultMediaType(resultType) {
  return resultType === 'quads'
    ? 'application/n-quads'
    : 'application/sparql-results+json';
}

async function prepareFixtureUpdate(sparql, options) {
  if (!sqlitePath) {
    return prepareUpdateDelta(sparql, options);
  }
  const store = loadFixtureStore(options);
  const before = store.getQuads(null, null, null, null);
  await fixtureQueryEngine().queryVoid(sparql, fixtureQueryContext(store, options));
  return diffPreparedUpdate(before, store.getQuads(null, null, null, null), options);
}

function diffPreparedUpdate(before, after, options) {
  const beforeByKey = new Map(before.map((value) => [quadKey(value), value]));
  const afterByKey = new Map(after.map((value) => [quadKey(value), value]));
  const byGraph = new Map();
  for (const [key, value] of beforeByKey) {
    if (!afterByKey.has(key)) {
      appendPreparedQuad(byGraph, value, 'delete', options);
    }
  }
  for (const [key, value] of afterByKey) {
    if (!beforeByKey.has(key)) {
      appendPreparedQuad(byGraph, value, 'insert', options);
    }
  }
  return { version: 1, graphs: [...byGraph.values()] };
}

function quadKey(value) {
  return [value.graph, value.subject, value.predicate, value.object]
    .map((term) => JSON.stringify(termToPreparedJson(term)))
    .join('\u001f');
}

function appendPreparedQuad(byGraph, value, operation, options) {
  const graphIri = value.graph.termType === 'DefaultGraph'
    ? options?.sourceUri || options?.basePath
    : value.graph.value;
  if (!graphIri) {
    throw new Error('prepared update requires a graph IRI');
  }
  let graph = byGraph.get(graphIri);
  if (!graph) {
    graph = { graphIri, sourceUri: graphIri, deletes: [], inserts: [] };
    byGraph.set(graphIri, graph);
  }
  graph[operation === 'insert' ? 'inserts' : 'deletes'].push({
    subject: termToPreparedJson(value.subject),
    predicate: termToPreparedJson(value.predicate),
    object: termToPreparedJson(value.object),
    graph: { type: 'uri', value: graphIri },
  });
}

if (mode === 'invalid-ready') {
  send({ type: 'ready', abiVersion: 1, physicalBackendAbiVersion: 5, backend: 'sqlite' });
} else if (mode !== 'hang-startup') {
  send({ type: 'ready', abiVersion: 1, physicalBackendAbiVersion: 7, backend: 'sqlite' });
}

const timers = new Map();
const input = readline.createInterface({ input: process.stdin });
input.on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.type === 'shutdown') {
    process.exit(0);
  }
  if (message.type === 'cancel') {
    const timer = timers.get(message.id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(message.id);
    }
    return;
  }
  if (message.type !== 'query') {
    return;
  }

  const { id, sparql, options } = message;
  if (sparql.includes('MALFORMED')) {
    process.stdout.write('{not-json\n');
    return;
  }
  if (sparql.includes('EXIT')) {
    process.stderr.write('deliberate fake runtime exit\n');
    process.exit(23);
  }
  if (sparql.includes('REMOTE_ERROR')) {
    send({ id, type: 'error', code: 'fake_remote_error', message: 'fake remote failure' });
    return;
  }
  if (sparql.includes('DELAY')) {
    const timer = setTimeout(() => {
      timers.delete(id);
      send({ id, type: 'result', result: nativeResult() });
    }, 500);
    timers.set(id, timer);
    return;
  }
  if (options?.operation === 'execute' && /\b(?:INSERT|DELETE|LOAD|CLEAR|CREATE|DROP|COPY|MOVE|ADD)\b/i.test(sparql)) {
    send({
      id,
      type: 'result',
      result: nativeResult({
        status: 'error',
        mediaType: 'application/json',
        body: '',
        error: 'update_authority_required',
      }),
    });
    return;
  }
  if (options?.operation === 'prepareUpdate') {
    try {
      send({
        id,
        type: 'result',
        result: nativeResult({
          mediaType: 'application/vnd.xpod.rdf-prepared-delta+json;version=1',
          body: JSON.stringify(await prepareFixtureUpdate(sparql, options)),
        }),
      });
    } catch (error) {
      send({
        id,
        type: 'result',
        result: nativeResult({
          status: 'error',
          mediaType: 'application/json',
          body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    }
    return;
  }
  try {
    send({ id, type: 'result', result: await executeFixtureQuery(sparql, options) });
  } catch (error) {
    send({
      id,
      type: 'result',
      result: nativeResult({
        status: 'error',
        mediaType: 'application/json',
        body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        error: error instanceof Error ? error.message : String(error),
      }),
    });
  }
});
