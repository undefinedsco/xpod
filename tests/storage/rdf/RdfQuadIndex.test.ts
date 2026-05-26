import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { DataFactory } from 'n3';
import { RdfQuadIndex } from '../../../src/storage/rdf';
import { createSqliteRuntime } from '../../../src/storage/SqliteRuntime';

const { namedNode, literal, quad } = DataFactory;

describe('RdfQuadIndex', () => {
  let index: RdfQuadIndex;

  beforeEach(() => {
    index = new RdfQuadIndex({ path: ':memory:' });
    index.open();
  });

  afterEach(() => {
    index.close();
  });

  it('stores quads through a term dictionary and scans exact patterns', () => {
    index.multiPut([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#this'),
        namedNode('http://purl.org/dc/terms/title'),
        literal('Default chat'),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#this'),
        namedNode('https://undefineds.co/ns#status'),
        literal('active'),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
      ),
    ], {
      source: {
        source: 'https://pod.example/alice/.data/chat/default/index.ttl',
        workspace: 'https://pod.example/alice/.data/chat/default/',
        localPath: '.data/chat/default/index.ttl',
        contentType: 'text/turtle',
        sourceVersion: 'v1',
      },
    });

    const results = index.scan({
      predicate: namedNode('https://undefineds.co/ns#status'),
      object: literal('active'),
    });

    expect(results.quads).toHaveLength(1);
    expect(results.quads[0].subject.value).toBe('https://pod.example/alice/.data/chat/default/index.ttl#this');
    expect(results.metrics.indexChoice).toBe('POSG');
    expect(index.stats()).toMatchObject({
      quadCount: 2,
      sourceCount: 1,
      graphCount: 1,
    });
    expect(index.stats().termCount).toBeGreaterThan(4);
  });

  it('reports RDF table and index space separately for benchmark gates', () => {
    index.multiPut([
      quad(namedNode('https://s/1'), namedNode('https://p/type'), namedNode('https://type/Message'), namedNode('https://g/chat')),
      quad(namedNode('https://s/2'), namedNode('https://p/type'), namedNode('https://type/Message'), namedNode('https://g/chat')),
      quad(namedNode('https://s/1'), namedNode('https://p/content'), literal('hello'), namedNode('https://g/chat')),
    ], {
      source: {
        source: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl',
        workspace: 'https://pod.example/alice/.data/chat/default/',
      },
    });

    const stats = index.stats();
    const objectsByName = new Map(stats.spaceObjects.map((object) => [object.name, object]));

    expect(stats.databaseBytes).toBeGreaterThan(0);
    expect(stats.tableBytes).toBeGreaterThan(0);
    expect(stats.indexBytes).toBeGreaterThan(0);
    expect(stats.spaceObjects.length).toBeGreaterThan(0);
    expect(objectsByName.get('rdf_terms')).toMatchObject({
      kind: 'table',
      pages: expect.any(Number),
      bytes: expect.any(Number),
    });
    expect(objectsByName.get('rdf_quads')).toMatchObject({
      kind: 'table',
    });
    expect(stats.spaceObjects.some((object) => object.kind === 'index' && object.tableName?.startsWith('rdf_'))).toBe(true);
  });

  it('reports literal datatype distribution for planner statistics', () => {
    const xsdInteger = namedNode('http://www.w3.org/2001/XMLSchema#integer');
    index.multiPut([
      quad(namedNode('https://metric/1'), namedNode('https://p/label'), literal('alpha'), namedNode('https://g')),
      quad(namedNode('https://metric/2'), namedNode('https://p/label'), literal('alpha'), namedNode('https://g')),
      quad(namedNode('https://metric/3'), namedNode('https://p/label'), literal('beta'), namedNode('https://g')),
      quad(namedNode('https://metric/4'), namedNode('https://p/priority'), literal('10', xsdInteger), namedNode('https://g')),
    ]);

    expect(index.literalDatatypeDistribution()).toEqual([
      {
        datatype: 'http://www.w3.org/2001/XMLSchema#string',
        termCount: 2,
        objectQuadCount: 3,
      },
      {
        datatype: xsdInteger.value,
        termCount: 1,
        objectQuadCount: 1,
      },
    ]);
    expect(index.stats().literalDatatypeDistribution[0]).toMatchObject({
      datatype: 'http://www.w3.org/2001/XMLSchema#string',
      objectQuadCount: 3,
    });
  });

  it('reports graph and predicate cardinality distributions for planner statistics', () => {
    const rdfType = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    const messageType = namedNode('https://type/Message');
    const status = namedNode('https://p/status');
    const tag = namedNode('https://p/tag');
    const chatGraph = namedNode('https://g/chat');
    const taskGraph = namedNode('https://g/task');
    const message1 = namedNode('https://message/1');
    const message2 = namedNode('https://message/2');
    const task1 = namedNode('https://task/1');

    index.multiPut([
      quad(message1, rdfType, messageType, chatGraph),
      quad(message2, rdfType, messageType, chatGraph),
      quad(message1, status, literal('open'), chatGraph),
      quad(message2, status, literal('open'), chatGraph),
      quad(message1, tag, literal('alpha', 'en'), chatGraph),
      quad(message1, tag, literal('beta', 'en'), chatGraph),
      quad(task1, status, literal('open'), taskGraph),
    ]);

    const distributions = index.cardinalityDistributions();

    expect(distributions.graphs[0]).toMatchObject({
      graph: {
        value: chatGraph.value,
        kind: 'iri',
      },
      quadCount: 6,
      distinctSubjects: 2,
      distinctPredicates: 3,
      distinctObjects: 4,
    });
    expect(distributions.predicates[0]).toMatchObject({
      predicate: {
        value: status.value,
        kind: 'iri',
      },
      quadCount: 3,
      graphCount: 2,
      distinctSubjects: 3,
      distinctObjects: 1,
    });
    expect(distributions.predicateObjects[0]).toMatchObject({
      predicate: {
        value: status.value,
      },
      object: {
        value: 'open',
        kind: 'literal',
        datatype: 'http://www.w3.org/2001/XMLSchema#string',
      },
      quadCount: 3,
      graphCount: 2,
      distinctSubjects: 3,
    });
    expect(distributions.subjectPredicates[0]).toMatchObject({
      subject: {
        value: message1.value,
      },
      predicate: {
        value: tag.value,
      },
      quadCount: 2,
      graphCount: 1,
      distinctObjects: 2,
    });
    expect(index.cardinalityDistributions(1).graphs).toHaveLength(1);
    expect(index.stats().cardinalityDistributions.predicates[0].quadCount).toBe(3);
  });

  it('supports graph prefix scans without materializing external provider federation', () => {
    index.multiPut([
      quad(namedNode('https://s/1'), namedNode('https://p'), literal('chat'), namedNode('https://pod.example/alice/.data/chat/a.ttl')),
      quad(namedNode('https://s/2'), namedNode('https://p'), literal('task'), namedNode('https://pod.example/alice/.data/task/a.ttl')),
      quad(namedNode('https://s/3'), namedNode('https://p'), literal('other'), namedNode('https://other.example/bob/data.ttl')),
    ]);

    const results = index.scan({
      graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
    });

    expect(results.quads.map((q) => q.object.value)).toEqual(['chat']);
    expect(results.metrics.indexChoice).toBe('GSPO');
  });

  it('orders and paginates term-id scan results', () => {
    index.multiPut([
      quad(namedNode('https://s/2'), namedNode('https://p'), literal('b'), namedNode('https://g')),
      quad(namedNode('https://s/1'), namedNode('https://p'), literal('a'), namedNode('https://g')),
      quad(namedNode('https://s/3'), namedNode('https://p'), literal('c'), namedNode('https://g')),
    ]);

    const results = index.scan(
      { predicate: namedNode('https://p') },
      { order: ['subject'], limit: 2 },
    );

    expect(results.quads.map((q) => q.subject.value)).toEqual(['https://s/1', 'https://s/2']);
  });

  it('orders by multiple term columns inside the embedded index', () => {
    index.multiPut([
      quad(namedNode('https://s/2'), namedNode('https://p'), literal('b'), namedNode('https://g')),
      quad(namedNode('https://s/1'), namedNode('https://p'), literal('b'), namedNode('https://g')),
      quad(namedNode('https://s/3'), namedNode('https://p'), literal('a'), namedNode('https://g')),
    ]);

    const results = index.scan(
      { predicate: namedNode('https://p') },
      { order: ['object', 'subject'], limit: 2 },
    );

    expect(results.quads.map((q) => `${q.object.value}:${q.subject.value}`)).toEqual([
      'a:https://s/3',
      'b:https://s/1',
    ]);
    expect(results.metrics.queryPlan?.at(-1)).toContain('ORDER BY order_t0.value, order_t1.value');
  });

  it('orders by multiple term columns with independent directions inside the embedded index', () => {
    index.multiPut([
      quad(namedNode('https://s/2'), namedNode('https://p'), literal('b'), namedNode('https://g')),
      quad(namedNode('https://s/1'), namedNode('https://p'), literal('b'), namedNode('https://g')),
      quad(namedNode('https://s/3'), namedNode('https://p'), literal('a'), namedNode('https://g')),
    ]);

    const results = index.scan(
      { predicate: namedNode('https://p') },
      { order: ['object', 'subject'], orderDirections: ['desc', 'asc'], limit: 2 },
    );

    expect(results.quads.map((q) => `${q.object.value}:${q.subject.value}`)).toEqual([
      'b:https://s/1',
      'b:https://s/2',
    ]);
    expect(results.metrics.queryPlan?.at(-1)).toContain('ORDER BY order_t0.value DESC, order_t1.value');
  });

  it('pushes lexical range filters into term-id scans', () => {
    index.multiPut([
      quad(namedNode('https://schedule/1'), namedNode('https://undefineds.co/ns#nextRunAt'), literal('2026-05-18T01:00:00.000Z'), namedNode('https://g')),
      quad(namedNode('https://schedule/2'), namedNode('https://undefineds.co/ns#nextRunAt'), literal('2026-05-18T02:00:00.000Z'), namedNode('https://g')),
      quad(namedNode('https://schedule/3'), namedNode('https://undefineds.co/ns#nextRunAt'), literal('2026-05-18T03:00:00.000Z'), namedNode('https://g')),
    ]);

    const results = index.scan(
      {
        predicate: namedNode('https://undefineds.co/ns#nextRunAt'),
        object: { $lte: literal('2026-05-18T02:00:00.000Z') },
      },
      { order: ['object'] },
    );

    expect(results.quads.map((q) => q.subject.value)).toEqual([
      'https://schedule/1',
      'https://schedule/2',
    ]);
    expect(results.metrics.indexChoice).toBe('POSG');
    expect(results.metrics.queryPlan?.join('\n')).toContain('JOIN rdf_terms object_id_range_lte');
    expect(results.metrics.queryPlan?.join('\n')).not.toContain('object_id IN (\n        SELECT');
  });

  it('uses numeric semantics for typed literal range scans', () => {
    const xsdInteger = namedNode('http://www.w3.org/2001/XMLSchema#integer');
    index.multiPut([
      quad(namedNode('https://metric/2'), namedNode('https://undefineds.co/ns#priority'), literal('2', xsdInteger), namedNode('https://g')),
      quad(namedNode('https://metric/10'), namedNode('https://undefineds.co/ns#priority'), literal('10', xsdInteger), namedNode('https://g')),
      quad(namedNode('https://metric/lexical'), namedNode('https://undefineds.co/ns#priority'), literal('9'), namedNode('https://g')),
    ]);

    const results = index.scan(
      {
        predicate: namedNode('https://undefineds.co/ns#priority'),
        object: { $gt: literal('9', xsdInteger) },
      },
      { order: ['subject'] },
    );

    expect(results.quads.map((q) => q.subject.value)).toEqual(['https://metric/10']);
    expect(results.metrics.indexChoice).toBe('POSG');
    expect(results.metrics.queryPlan).toContain('NumericRange(object$gt)');
    expect(results.metrics.queryPlan?.join('\n')).toContain('JOIN rdf_terms object_id_numeric_range_gt');
    expect(results.metrics.queryPlan?.join('\n')).toContain('object_id_numeric_range_gt.numeric_value > ?');
    expect(results.metrics.queryPlan?.join('\n')).not.toContain('rdf_quads.object_id IN (?,');
  });

  it('backfills numeric value index metadata when opening an existing RDF index', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xpod-rdf-numeric-migration-'));
    const dbPath = path.join(root, 'rdf.sqlite');
    const xsdInteger = namedNode('http://www.w3.org/2001/XMLSchema#integer');
    const seed = new RdfQuadIndex({ path: dbPath });
    seed.open();
    seed.multiPut([
      quad(namedNode('https://metric/2'), namedNode('https://undefineds.co/ns#priority'), literal('2', xsdInteger), namedNode('https://g')),
      quad(namedNode('https://metric/10'), namedNode('https://undefineds.co/ns#priority'), literal('10', xsdInteger), namedNode('https://g')),
    ]);
    seed.close();

    const sqlite = createSqliteRuntime();
    const db = sqlite.openDatabase(dbPath);
    try {
      db.exec('UPDATE rdf_terms SET numeric_value = NULL; DROP INDEX IF EXISTS rdf_terms_kind_numeric_value;');
    } finally {
      db.close();
    }

    const reopened = new RdfQuadIndex({ path: dbPath });
    try {
      reopened.open();
      const results = reopened.scan(
        {
          predicate: namedNode('https://undefineds.co/ns#priority'),
          object: { $gt: literal('9', xsdInteger) },
        },
      );

      expect(results.quads.map((q) => q.subject.value)).toEqual(['https://metric/10']);
      expect(results.metrics.queryPlan?.join('\n')).toContain('JOIN rdf_terms object_id_numeric_range_gt');
      const verifyDb = sqlite.openDatabase(dbPath);
      try {
        expect(verifyDb.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_terms WHERE numeric_value IS NOT NULL').get()?.count).toBe(2);
        expect(verifyDb.prepare<{ name: string }>("SELECT name FROM sqlite_schema WHERE name = 'rdf_terms_kind_numeric_value'").get()?.name).toBe('rdf_terms_kind_numeric_value');
      } finally {
        verifyDb.close();
      }
    } finally {
      reopened.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('pushes literal contains filters through the normalized text index', () => {
    index.multiPut([
      quad(namedNode('https://message/1'), namedNode('http://rdfs.org/sioc/ns#content'), literal('Deploy checklist ready'), namedNode('https://g')),
      quad(namedNode('https://message/2'), namedNode('http://rdfs.org/sioc/ns#content'), literal('deployment already finished'), namedNode('https://g')),
      quad(namedNode('https://message/3'), namedNode('http://rdfs.org/sioc/ns#content'), literal('Meeting notes'), namedNode('https://g')),
    ]);

    const results = index.scan(
      {
        predicate: namedNode('http://rdfs.org/sioc/ns#content'),
        object: { $contains: 'Deploy' },
      },
      { order: ['subject'] },
    );

    expect(results.quads.map((q) => q.subject.value)).toEqual(['https://message/1']);
    expect(results.metrics.indexChoice).toBe('POSG');
    expect(results.metrics.queryPlan).toContain('TextSearch(object$contains)');
  });

  it('pushes STR string filters over IRI objects without treating objects as literals only', () => {
    index.multiPut([
      quad(namedNode('https://message/1'), namedNode('http://rdfs.org/sioc/ns#has_member'), namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'), namedNode('https://g')),
      quad(namedNode('https://message/2'), namedNode('http://rdfs.org/sioc/ns#has_member'), namedNode('https://other.example/thread_2'), namedNode('https://g')),
      quad(namedNode('https://message/3'), namedNode('http://rdfs.org/sioc/ns#content'), literal('https://pod.example/alice/not-a-thread'), namedNode('https://g')),
    ]);

    const results = index.scan(
      {
        predicate: namedNode('http://rdfs.org/sioc/ns#has_member'),
        object: { $startsWith: 'https://pod.example/alice/.data/chat/' },
      },
      { order: ['subject'] },
    );

    expect(results.quads.map((q) => q.subject.value)).toEqual(['https://message/1']);
    expect(results.metrics.indexChoice).toBe('POSG');
  });

  it('pushes term type, language, and datatype filters into term-id scans', () => {
    const content = namedNode('http://rdfs.org/sioc/ns#content');
    const priority = namedNode('https://undefineds.co/ns#priority');
    const xsdInteger = namedNode('http://www.w3.org/2001/XMLSchema#integer');

    index.multiPut([
      quad(namedNode('https://message/en'), content, literal('hello', 'en-US'), namedNode('https://g')),
      quad(namedNode('https://message/fr'), content, literal('bonjour', 'fr'), namedNode('https://g')),
      quad(namedNode('https://message/plain'), content, literal('plain'), namedNode('https://g')),
      quad(namedNode('https://message/priority'), priority, literal('7', xsdInteger), namedNode('https://g')),
      quad(namedNode('https://message/link'), content, namedNode('https://thread/1'), namedNode('https://g')),
    ]);

    const language = index.scan(
      { predicate: content, object: { $langMatches: 'en' } },
      { order: ['subject'] },
    );
    const numeric = index.scan(
      { object: { $termType: 'numeric' } },
      { order: ['subject'] },
    );
    const datatype = index.scan(
      { object: { $datatype: xsdInteger } },
      { order: ['subject'] },
    );

    expect(language.quads.map((q) => q.subject.value)).toEqual(['https://message/en']);
    expect(language.metrics.queryPlan).toContain('Language(object$langMatches)');
    expect(numeric.quads.map((q) => q.subject.value)).toEqual(['https://message/priority']);
    expect(numeric.metrics.queryPlan).toContain('TermType(object:numeric)');
    expect(datatype.quads.map((q) => q.subject.value)).toEqual(['https://message/priority']);
    expect(datatype.metrics.queryPlan).toContain('Datatype(object$datatype)');
  });

  it('pushes literal suffix and regex filters through term-id candidates', () => {
    index.multiPut([
      quad(namedNode('https://message/1'), namedNode('http://rdfs.org/sioc/ns#content'), literal('alpha done'), namedNode('https://g')),
      quad(namedNode('https://message/2'), namedNode('http://rdfs.org/sioc/ns#content'), literal('beta ready'), namedNode('https://g')),
      quad(namedNode('https://message/3'), namedNode('http://rdfs.org/sioc/ns#content'), literal('gamma done'), namedNode('https://g')),
    ]);

    const suffix = index.scan(
      {
        predicate: namedNode('http://rdfs.org/sioc/ns#content'),
        object: { $endsWith: 'done' },
      },
      { order: ['subject'] },
    );
    const regex = index.scan(
      {
        predicate: namedNode('http://rdfs.org/sioc/ns#content'),
        object: { $regex: '^(alpha|gamma)' },
      },
      { order: ['subject'] },
    );

    expect(suffix.quads.map((q) => q.subject.value)).toEqual(['https://message/1', 'https://message/3']);
    expect(regex.quads.map((q) => q.subject.value)).toEqual(['https://message/1', 'https://message/3']);
    expect(suffix.metrics.queryPlan).toContain('TextSearch(object$endsWith)');
    expect(regex.metrics.queryPlan).toContain('TextSearch(object$regex)');
    expect(regex.metrics.queryPlan?.join('\n')).toContain('JOIN rdf_regex_candidates_object_id');
    expect(regex.metrics.queryPlan?.join('\n')).not.toContain('text_object_id_regex.id IN (');
  });

  it('uses candidate table joins for large VALUES-style term filters', () => {
    const graph = namedNode('https://g');
    const predicate = namedNode('https://p/type');
    const selected = Array.from({ length: 80 }, (_, offset) => namedNode(`https://message/${offset + 1}`));
    index.multiPut([
      ...selected.map((subject) => quad(subject, predicate, namedNode('https://type/Message'), graph)),
      quad(namedNode('https://message/excluded'), predicate, namedNode('https://type/Message'), graph),
    ]);

    const include = index.scan(
      {
        subject: { $in: selected },
        predicate,
      },
      { order: ['subject'] },
    );
    const exclude = index.scan(
      {
        subject: { $notIn: selected },
        predicate,
      },
      { order: ['subject'] },
    );

    expect(include.quads).toHaveLength(80);
    expect(exclude.quads.map((value) => value.subject.value)).toEqual(['https://message/excluded']);
    expect(include.metrics.queryPlan?.join('\n')).toContain('JOIN rdf_term_in_candidates_subject_id');
    expect(include.metrics.queryPlan?.join('\n')).not.toContain('rdf_quads.subject_id IN (?,');
    expect(exclude.metrics.queryPlan?.join('\n')).toContain('LEFT JOIN rdf_term_not_in_candidates_subject_id');
    expect(exclude.metrics.queryPlan?.join('\n')).not.toContain('rdf_quads.subject_id NOT IN (?,');
  });

  it('joins correlated tuple VALUES constraints through a temp candidate table', () => {
    const graph = namedNode('https://g');
    const type = namedNode('https://p/type');
    const message = namedNode('https://type/Message');
    const content = namedNode('https://type/Content');
    const msg1 = namedNode('https://message/1');
    const msg2 = namedNode('https://message/2');
    index.multiPut([
      quad(msg1, type, message, graph),
      quad(msg2, type, message, graph),
    ]);

    const result = index.scanWithTupleConstraints(
      {
        predicate: type,
      },
      {
        columns: ['subject', 'object'],
        rows: [
          { subject: msg1, object: message },
          { subject: msg2, object: content },
        ],
      },
      { order: ['subject'] },
    );

    expect(result.quads.map((value) => value.subject.value)).toEqual(['https://message/1']);
    expect(result.metrics.queryPlan?.join('\n')).toContain('TupleValuesJoin(subject,object)');
    expect(result.metrics.queryPlan?.join('\n')).toContain('JOIN rdf_tuple_values_subject_id_object_id');
  });

  it('executes connected BGP patterns as one SQL self-join', () => {
    const graph = namedNode('https://g');
    const type = namedNode('https://p/type');
    const content = namedNode('https://p/content');
    const messageType = namedNode('https://type/Message');
    const msg1 = namedNode('https://message/1');
    const msg2 = namedNode('https://message/2');
    index.multiPut([
      quad(msg1, type, messageType, graph),
      quad(msg1, content, literal('hello'), graph),
      quad(msg2, type, messageType, graph),
    ]);

    const result = index.joinPatterns([
      {
        pattern: {
          predicate: type,
          object: messageType,
        },
        variables: {
          subject: 'message',
        },
      },
      {
        pattern: {
          predicate: content,
        },
        variables: {
          subject: 'message',
          object: 'content',
        },
      },
    ]);

    expect(result.bindings.map((binding) => ({
      message: binding.message.value,
      content: binding.content.value,
    }))).toEqual([
      {
        message: 'https://message/1',
        content: 'hello',
      },
    ]);
    expect(result.metrics.indexChoice).toBe('JoinBGP(POSG>POSG)');
    expect(result.metrics.queryPlan?.join('\n')).toContain('JoinBGP(2)');
    expect(result.metrics.queryPlan?.join('\n')).toContain('JOIN rdf_quads q1 ON 1 = 1');
    expect(result.metrics.queryPlan?.join('\n')).toContain('q0.subject_id = q1.subject_id');
  });

  it('orders and paginates connected BGP joins inside SQL', () => {
    const graph = namedNode('https://g');
    const type = namedNode('https://p/type');
    const created = namedNode('https://p/created');
    const messageType = namedNode('https://type/Message');
    const msg1 = namedNode('https://message/1');
    const msg2 = namedNode('https://message/2');
    const msg3 = namedNode('https://message/3');
    index.multiPut([
      quad(msg1, type, messageType, graph),
      quad(msg1, created, literal('2026-05-18T00:00:01.000Z'), graph),
      quad(msg2, type, messageType, graph),
      quad(msg2, created, literal('2026-05-18T00:00:03.000Z'), graph),
      quad(msg3, type, messageType, graph),
      quad(msg3, created, literal('2026-05-18T00:00:02.000Z'), graph),
    ]);

    const result = index.joinPatterns([
      {
        pattern: {
          predicate: type,
          object: messageType,
        },
        variables: {
          subject: 'message',
        },
      },
      {
        pattern: {
          predicate: created,
        },
        variables: {
          subject: 'message',
          object: 'createdAt',
        },
      },
    ], {
      orderBy: [{ variable: 'createdAt', direction: 'desc' }],
      limit: 2,
      offset: 1,
    });

    expect(result.bindings.map((binding) => ({
      message: binding.message.value,
      createdAt: binding.createdAt.value,
    }))).toEqual([
      {
        message: 'https://message/3',
        createdAt: '2026-05-18T00:00:02.000Z',
      },
      {
        message: 'https://message/1',
        createdAt: '2026-05-18T00:00:01.000Z',
      },
    ]);
    expect(result.metrics.matchedRows).toBe(3);
    expect(result.metrics.returnedRows).toBe(2);
    expect(result.metrics.queryPlan).toContain('JoinOrder(desc:createdAt)');
    expect(result.metrics.queryPlan).toContain('JoinLimit');
    expect(result.metrics.queryPlan?.join('\n')).toContain('ORDER BY join_order_t0.value DESC LIMIT ? OFFSET ?');
  });

  it('pushes operator filters into connected BGP joins with scoped SQL aliases', () => {
    const graph = namedNode('https://g');
    const type = namedNode('https://p/type');
    const created = namedNode('https://p/created');
    const content = namedNode('https://p/content');
    const messageType = namedNode('https://type/Message');
    const msg1 = namedNode('https://message/1');
    const msg2 = namedNode('https://message/2');
    const msg3 = namedNode('https://message/3');
    index.multiPut([
      quad(msg1, type, messageType, graph),
      quad(msg1, created, literal('2026-05-18T00:00:01.000Z'), graph),
      quad(msg1, content, literal('todo first'), graph),
      quad(msg2, type, messageType, graph),
      quad(msg2, created, literal('2026-05-18T00:00:02.000Z'), graph),
      quad(msg2, content, literal('todo second'), graph),
      quad(msg3, type, messageType, graph),
      quad(msg3, created, literal('2026-05-18T00:00:03.000Z'), graph),
      quad(msg3, content, literal('done third'), graph),
    ]);

    const result = index.joinPatterns([
      {
        pattern: {
          predicate: type,
          object: messageType,
        },
        variables: {
          subject: 'message',
        },
      },
      {
        pattern: {
          predicate: created,
          object: { $lte: literal('2026-05-18T00:00:02.000Z') },
        },
        variables: {
          subject: 'message',
          object: 'createdAt',
        },
      },
      {
        pattern: {
          predicate: content,
          object: { $contains: 'todo' },
        },
        variables: {
          subject: 'message',
          object: 'content',
        },
      },
    ], {
      orderBy: [{ variable: 'createdAt' }],
    });

    expect(result.bindings.map((binding) => ({
      message: binding.message.value,
      createdAt: binding.createdAt.value,
      content: binding.content.value,
    }))).toEqual([
      {
        message: 'https://message/1',
        createdAt: '2026-05-18T00:00:01.000Z',
        content: 'todo first',
      },
      {
        message: 'https://message/2',
        createdAt: '2026-05-18T00:00:02.000Z',
        content: 'todo second',
      },
    ]);
    const plan = result.metrics.queryPlan?.join('\n') ?? '';
    expect(plan).toContain('LexicalRange(object$lte)');
    expect(plan).toContain('TextSearch(object$contains)');
    expect(plan).toContain('JOIN rdf_terms q1_object_id_range_lte ON q1_object_id_range_lte.id = q1.object_id');
    expect(plan).toContain('JOIN rdf_terms q2_text_object_id_contains ON q2_text_object_id_contains.id = q2.object_id');
    expect(plan).not.toContain('JOIN rdf_terms object_id_range_lte ON object_id_range_lte.id = rdf_quads.object_id');
    expect(plan).not.toContain('JOIN rdf_terms text_object_id_contains ON text_object_id_contains.id = rdf_quads.object_id');
  });

  it('groups connected BGP joins and counts rows inside SQL', () => {
    const graph = namedNode('https://g');
    const member = namedNode('https://p/member');
    const status = namedNode('https://p/status');
    const thread1 = namedNode('https://thread/1');
    const thread2 = namedNode('https://thread/2');
    const msg1 = namedNode('https://message/1');
    const msg2 = namedNode('https://message/2');
    const msg3 = namedNode('https://message/3');
    index.multiPut([
      quad(msg1, member, thread1, graph),
      quad(msg1, status, literal('open'), graph),
      quad(msg2, member, thread1, graph),
      quad(msg2, status, literal('open'), graph),
      quad(msg3, member, thread2, graph),
      quad(msg3, status, literal('open'), graph),
    ]);

    const result = index.groupCountJoinPatterns([
      {
        pattern: {
          predicate: member,
        },
        variables: {
          subject: 'message',
          object: 'thread',
        },
      },
      {
        pattern: {
          predicate: status,
          object: literal('open'),
        },
        variables: {
          subject: 'message',
        },
      },
    ], {
      groupBy: ['thread'],
      aggregates: [
        {
          type: 'count',
          as: 'messageCount',
          variable: 'message',
        },
        {
          type: 'count',
          as: 'distinctMessageCount',
          variable: 'message',
          distinct: true,
        },
      ],
    });

    expect(result.bindings.map((binding) => ({
      thread: binding.thread.value,
      messageCount: binding.messageCount.value,
      distinctMessageCount: binding.distinctMessageCount.value,
    }))).toEqual([
      {
        thread: 'https://thread/1',
        messageCount: '2',
        distinctMessageCount: '2',
      },
      {
        thread: 'https://thread/2',
        messageCount: '1',
        distinctMessageCount: '1',
      },
    ]);
    expect(result.metrics.indexChoice).toBe('JoinBGP(POSG>POSG)');
    expect(result.metrics.matchedRows).toBe(3);
    expect(result.metrics.returnedRows).toBe(2);
    expect(result.metrics.queryPlan).toContain('JoinGroupCount(?thread)');
    expect(result.metrics.queryPlan?.join('\n')).toContain('GROUP BY q0.object_id');
    expect(result.metrics.queryPlan?.join('\n')).toContain('COUNT(q0.subject_id) AS a0');
    expect(result.metrics.queryPlan?.join('\n')).toContain('COUNT(DISTINCT q0.subject_id) AS a1');
  });

  it('applies grouped COUNT HAVING before ordering and pagination in SQL', () => {
    const graph = namedNode('https://g');
    const member = namedNode('https://p/member');
    const thread1 = namedNode('https://thread/1');
    const thread2 = namedNode('https://thread/2');
    const msg1 = namedNode('https://message/1');
    const msg2 = namedNode('https://message/2');
    const msg3 = namedNode('https://message/3');
    index.multiPut([
      quad(msg1, member, thread1, graph),
      quad(msg2, member, thread1, graph),
      quad(msg3, member, thread2, graph),
    ]);

    const result = index.groupCountJoinPatterns([
      {
        pattern: {
          predicate: member,
        },
        variables: {
          subject: 'message',
          object: 'thread',
        },
      },
    ], {
      groupBy: ['thread'],
      aggregates: [
        {
          type: 'count',
          as: 'messageCount',
          variable: 'message',
        },
      ],
      having: [
        {
          aggregate: 'messageCount',
          operator: '$lt',
          value: 2,
        },
      ],
      orderBy: [
        {
          variable: 'messageCount',
          direction: 'desc',
        },
      ],
      limit: 1,
    });

    expect(result.bindings.map((binding) => ({
      thread: binding.thread.value,
      messageCount: binding.messageCount.value,
    }))).toEqual([
      {
        thread: 'https://thread/2',
        messageCount: '1',
      },
    ]);
    expect(result.metrics.queryPlan).toContain('JoinGroupCountHaving(messageCount$lt)');
    expect(result.metrics.queryPlan).toContain('JoinGroupCountOrder(desc:messageCount)');
    expect(result.metrics.queryPlan).toContain('JoinGroupCountLimit');
    expect(result.metrics.queryPlan?.join('\n')).toContain('GROUP BY q0.object_id HAVING a0 < ? ORDER BY a0 DESC LIMIT ?');
  });

  it('pushes guarded numeric aggregates into SQL over BGP joins', () => {
    const graph = namedNode('https://g');
    const type = namedNode('https://p/type');
    const score = namedNode('https://p/score');
    const messageType = namedNode('https://type/Message');
    const msg1 = namedNode('https://message/1');
    const msg2 = namedNode('https://message/2');
    const msg3 = namedNode('https://message/3');
    index.multiPut([
      quad(msg1, type, messageType, graph),
      quad(msg1, score, literal('2', namedNode('http://www.w3.org/2001/XMLSchema#integer')), graph),
      quad(msg2, type, messageType, graph),
      quad(msg2, score, literal('10', namedNode('http://www.w3.org/2001/XMLSchema#integer')), graph),
      quad(msg3, type, messageType, graph),
      quad(msg3, score, literal('not numeric'), graph),
    ]);

    const result = index.aggregateJoinPatterns([
      {
        pattern: {
          predicate: type,
          object: messageType,
        },
        variables: {
          subject: 'message',
        },
      },
      {
        pattern: {
          predicate: score,
        },
        variables: {
          subject: 'message',
          object: 'score',
        },
      },
    ], {
      aggregates: [
        {
          type: 'sum',
          as: 'sum',
          variable: 'score',
        },
        {
          type: 'avg',
          as: 'avg',
          variable: 'score',
        },
        {
          type: 'min',
          as: 'min',
          variable: 'score',
        },
        {
          type: 'max',
          as: 'max',
          variable: 'score',
        },
      ],
    });

    expect(result.bindings.map((binding) => ({
      sum: binding.sum.value,
      sumDatatype: binding.sum.datatype.value,
      avg: binding.avg.value,
      min: binding.min.value,
      max: binding.max.value,
    }))).toEqual([
      {
        sum: '12',
        sumDatatype: 'http://www.w3.org/2001/XMLSchema#decimal',
        avg: '6',
        min: '2',
        max: '10',
      },
    ]);
    expect(result.metrics.matchedRows).toBe(2);
    expect(result.metrics.queryPlan).toContain('JoinAggregateNumeric(?score)');
    expect(result.metrics.queryPlan?.join('\n')).toContain('COALESCE(SUM(agg_numeric_t0.numeric_value), 0) AS a0');
  });

  it('groups guarded numeric aggregates inside SQL over BGP joins', () => {
    const graph = namedNode('https://g');
    const member = namedNode('https://p/member');
    const score = namedNode('https://p/score');
    const thread1 = namedNode('https://thread/1');
    const thread2 = namedNode('https://thread/2');
    const msg1 = namedNode('https://message/1');
    const msg2 = namedNode('https://message/2');
    const msg3 = namedNode('https://message/3');
    const msg4 = namedNode('https://message/4');
    index.multiPut([
      quad(msg1, member, thread1, graph),
      quad(msg1, score, literal('2', namedNode('http://www.w3.org/2001/XMLSchema#integer')), graph),
      quad(msg2, member, thread1, graph),
      quad(msg2, score, literal('10', namedNode('http://www.w3.org/2001/XMLSchema#integer')), graph),
      quad(msg3, member, thread2, graph),
      quad(msg3, score, literal('4', namedNode('http://www.w3.org/2001/XMLSchema#integer')), graph),
      quad(msg4, member, thread2, graph),
      quad(msg4, score, literal('not numeric'), graph),
    ]);

    const result = index.groupAggregateJoinPatterns([
      {
        pattern: {
          predicate: member,
        },
        variables: {
          subject: 'message',
          object: 'thread',
        },
      },
      {
        pattern: {
          predicate: score,
        },
        variables: {
          subject: 'message',
          object: 'score',
        },
      },
    ], {
      groupBy: ['thread'],
      aggregates: [
        {
          type: 'count',
          as: 'messageCount',
          variable: 'message',
        },
        {
          type: 'sum',
          as: 'sum',
          variable: 'score',
        },
        {
          type: 'avg',
          as: 'avg',
          variable: 'score',
        },
        {
          type: 'min',
          as: 'min',
          variable: 'score',
        },
        {
          type: 'max',
          as: 'max',
          variable: 'score',
        },
      ],
      having: [
        {
          aggregate: 'sum',
          operator: '$gte',
          value: 4,
        },
      ],
      orderBy: [
        {
          variable: 'sum',
          direction: 'desc',
        },
      ],
    });

    expect(result.bindings.map((binding) => ({
      thread: binding.thread.value,
      count: binding.messageCount.value,
      sum: binding.sum.value,
      sumDatatype: binding.sum.datatype.value,
      avg: binding.avg.value,
      min: binding.min.value,
      max: binding.max.value,
    }))).toEqual([
      {
        thread: 'https://thread/1',
        count: '2',
        sum: '12',
        sumDatatype: 'http://www.w3.org/2001/XMLSchema#decimal',
        avg: '6',
        min: '2',
        max: '10',
      },
      {
        thread: 'https://thread/2',
        count: '1',
        sum: '4',
        sumDatatype: 'http://www.w3.org/2001/XMLSchema#decimal',
        avg: '4',
        min: '4',
        max: '4',
      },
    ]);
    expect(result.metrics.matchedRows).toBe(3);
    expect(result.metrics.queryPlan).toContain('JoinGroupAggregateNumeric(?score)');
    expect(result.metrics.queryPlan).toContain('JoinGroupAggregateHaving(sum$gte)');
    expect(result.metrics.queryPlan).toContain('JoinGroupAggregateOrder(desc:sum)');
    expect(result.metrics.queryPlan?.join('\n')).toContain('GROUP BY q0.object_id HAVING a1 >= ? ORDER BY a1 DESC');
  });

  it('deduplicates repeated quads and keeps index refresh idempotent', () => {
    const value = quad(namedNode('https://s'), namedNode('https://p'), literal('v'), namedNode('https://g'));
    index.multiPut([value, value]);
    index.put(value);

    expect(index.count({})).toBe(1);
    expect(index.scan({}).quads).toHaveLength(1);
  });

  it('replaces quads for one source without leaving stale statements', () => {
    const source = {
        source: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl',
      workspace: 'https://pod.example/alice/.data/chat/default/',
      localPath: '.data/chat/default/2026/05/18/messages.ttl',
      contentType: 'text/turtle',
      sourceVersion: 'v1',
    };
    const otherSource = {
        source: 'https://pod.example/alice/.data/chat/default/2026/05/19/messages.ttl',
      workspace: 'https://pod.example/alice/.data/chat/default/',
      localPath: '.data/chat/default/2026/05/19/messages.ttl',
      contentType: 'text/turtle',
      sourceVersion: 'v1',
    };

    index.replaceSource([
      quad(namedNode('https://message/1'), namedNode('https://schema.org/text'), literal('stale'), namedNode(source.source)),
      quad(namedNode('https://message/2'), namedNode('https://schema.org/text'), literal('kept'), namedNode(source.source)),
    ], source);
    index.replaceSource([
      quad(namedNode('https://message/other'), namedNode('https://schema.org/text'), literal('other source'), namedNode(otherSource.source)),
    ], otherSource);

    index.replaceSource([
      quad(namedNode('https://message/2'), namedNode('https://schema.org/text'), literal('updated'), namedNode(source.source)),
    ], { ...source, sourceVersion: 'v2' });

    const sourceRows = index.scan({
      graph: namedNode(source.source),
    }, { order: ['subject'] });
    const otherRows = index.scan({
      graph: namedNode(otherSource.source),
    });

    expect(sourceRows.quads.map((q) => `${q.subject.value}:${q.object.value}`)).toEqual([
      'https://message/2:updated',
    ]);
    expect(otherRows.quads.map((q) => q.object.value)).toEqual(['other source']);
    expect(index.stats()).toMatchObject({
      quadCount: 2,
      sourceCount: 2,
    });
  });

  it('deletes source-scoped quads and invalidates cached cardinality', () => {
    const source = {
        source: 'https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl',
      workspace: 'https://pod.example/alice/.data/task/default/',
      localPath: '.data/task/default/2026/05/18/runs.ttl',
      contentType: 'text/turtle',
    };
    const predicate = namedNode('https://undefineds.co/ns#status');

    index.replaceSource([
      quad(namedNode('https://run/1'), predicate, literal('queued'), namedNode(source.source)),
      quad(namedNode('https://run/2'), predicate, literal('queued'), namedNode(source.source)),
    ], source);
    expect(index.estimateCardinality({ predicate })).toMatchObject({
      rows: 2,
      source: 'exact-count',
    });
    expect(index.estimateCardinality({ predicate })).toMatchObject({
      rows: 2,
      source: 'cached-exact-count',
    });

    expect(index.deleteSource(source.source)).toBe(2);

    expect(index.estimateCardinality({ predicate })).toMatchObject({
      rows: 0,
      source: 'exact-count',
    });
    expect(index.stats()).toMatchObject({
      quadCount: 0,
      sourceCount: 0,
    });
  });

  it('estimates exact cardinality with cached index statistics and invalidates on writes', () => {
    index.multiPut([
      quad(namedNode('https://message/1'), namedNode('https://p/type'), namedNode('https://type/Message'), namedNode('https://g/chat')),
      quad(namedNode('https://message/2'), namedNode('https://p/type'), namedNode('https://type/Message'), namedNode('https://g/chat')),
      quad(namedNode('https://message/1'), namedNode('https://p/status'), literal('open'), namedNode('https://g/chat')),
      quad(namedNode('https://task/1'), namedNode('https://p/type'), namedNode('https://type/Task'), namedNode('https://g/task')),
    ]);

    const first = index.estimateCardinality({
      predicate: namedNode('https://p/type'),
      object: namedNode('https://type/Message'),
    });
    const cached = index.estimateCardinality({
      predicate: namedNode('https://p/type'),
      object: namedNode('https://type/Message'),
    });

    expect(first).toMatchObject({
      rows: 2,
      source: 'exact-count',
      indexChoice: 'POSG',
    });
    expect(cached).toMatchObject({
      rows: 2,
      source: 'cached-exact-count',
      indexChoice: 'POSG',
    });

    index.put(quad(
      namedNode('https://message/3'),
      namedNode('https://p/type'),
      namedNode('https://type/Message'),
      namedNode('https://g/chat'),
    ));

    expect(index.estimateCardinality({
      predicate: namedNode('https://p/type'),
      object: namedNode('https://type/Message'),
    })).toMatchObject({
      rows: 3,
      source: 'exact-count',
      indexChoice: 'POSG',
    });
    expect(index.estimateCardinality({
      subject: namedNode('https://message/1'),
      predicate: namedNode('https://p/status'),
    })).toMatchObject({
      rows: 1,
      indexChoice: 'SPOG',
    });
  });

  it('counts distinct term slots with cached index statistics and invalidates on writes', () => {
    index.multiPut([
      quad(namedNode('https://message/1'), namedNode('https://p/tag'), literal('alpha'), namedNode('https://g/chat')),
      quad(namedNode('https://message/1'), namedNode('https://p/tag'), literal('beta'), namedNode('https://g/chat')),
      quad(namedNode('https://message/2'), namedNode('https://p/tag'), literal('alpha'), namedNode('https://g/chat')),
      quad(namedNode('https://task/1'), namedNode('https://p/tag'), literal('alpha'), namedNode('https://g/task')),
    ]);

    const first = index.countDistinct({
      graph: namedNode('https://g/chat'),
      predicate: namedNode('https://p/tag'),
    }, 'subject');
    const cached = index.countDistinct({
      graph: namedNode('https://g/chat'),
      predicate: namedNode('https://p/tag'),
    }, 'subject');

    expect(first).toMatchObject({
      rows: 2,
      source: 'exact-distinct-count',
      indexChoice: 'GPOS',
    });
    expect(cached).toMatchObject({
      rows: 2,
      source: 'cached-exact-distinct-count',
      indexChoice: 'GPOS',
    });

    index.put(quad(
      namedNode('https://message/3'),
      namedNode('https://p/tag'),
      literal('alpha'),
      namedNode('https://g/chat'),
    ));

    expect(index.countDistinct({
      graph: namedNode('https://g/chat'),
      predicate: namedNode('https://p/tag'),
    }, 'subject')).toMatchObject({
      rows: 3,
      source: 'exact-distinct-count',
    });
    expect(index.countDistinct({
      graph: namedNode('https://g/chat'),
      predicate: namedNode('https://p/tag'),
    }, 'object')).toMatchObject({
      rows: 2,
      source: 'exact-distinct-count',
    });
  });

  it('counts distinct term slot tuples with cached index statistics and invalidates on writes', () => {
    index.multiPut([
      quad(namedNode('https://message/1'), namedNode('https://p/tag'), literal('alpha'), namedNode('https://g/chat')),
      quad(namedNode('https://message/1'), namedNode('https://p/tag'), literal('beta'), namedNode('https://g/chat')),
      quad(namedNode('https://message/2'), namedNode('https://p/tag'), literal('alpha'), namedNode('https://g/chat')),
      quad(namedNode('https://message/2'), namedNode('https://p/status'), literal('open'), namedNode('https://g/chat')),
      quad(namedNode('https://task/1'), namedNode('https://p/tag'), literal('alpha'), namedNode('https://g/task')),
    ]);

    const first = index.countDistinctTuple({
      graph: namedNode('https://g/chat'),
    }, ['subject', 'predicate']);
    const cached = index.countDistinctTuple({
      graph: namedNode('https://g/chat'),
    }, ['predicate', 'subject']);

    expect(first).toMatchObject({
      rows: 3,
      source: 'exact-distinct-tuple-count',
      indexChoice: 'GSPO',
    });
    expect(cached).toMatchObject({
      rows: 3,
      source: 'cached-exact-distinct-tuple-count',
      indexChoice: 'GSPO',
    });

    index.put(quad(
      namedNode('https://message/3'),
      namedNode('https://p/tag'),
      literal('alpha'),
      namedNode('https://g/chat'),
    ));

    expect(index.countDistinctTuple({
      graph: namedNode('https://g/chat'),
    }, ['subject', 'predicate'])).toMatchObject({
      rows: 4,
      source: 'exact-distinct-tuple-count',
    });
  });
});
