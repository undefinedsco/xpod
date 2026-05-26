import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { DataFactory, termToId } from 'n3';
import {
  RdfQuadIndex,
  SolidRdfEngine,
  rdfVar,
} from '../../../src/storage/rdf';
import { isTerm } from '../../../src/storage/quint/types';

const { namedNode, literal, quad } = DataFactory;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DCT_CREATED = 'http://purl.org/dc/terms/created';
const SIOC_CONTENT = 'http://rdfs.org/sioc/ns#content';
const SIOC_HAS_MEMBER = 'http://rdfs.org/sioc/ns#has_member';
const SIOC_THREAD = 'http://rdfs.org/sioc/ns#Thread';
const MEETING_MESSAGE = 'http://www.w3.org/ns/pim/meeting#Message';
const UDFS_PRIORITY = 'https://undefineds.co/ns#priority';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

describe('RdfLocalQueryEngine', () => {
  let index: RdfQuadIndex;
  let engine: SolidRdfEngine;

  beforeEach(() => {
    index = new RdfQuadIndex({ path: ':memory:' });
    index.open();
    engine = new SolidRdfEngine({ index });

    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const thread = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1');
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');

    engine.put([
      quad(msg1, namedNode(RDF_TYPE), namedNode(MEETING_MESSAGE), graph),
      quad(msg1, namedNode(SIOC_HAS_MEMBER), thread, graph),
      quad(msg1, namedNode(SIOC_CONTENT), literal('hello'), graph),
      quad(msg1, namedNode(DCT_CREATED), literal('2026-05-18T00:00:01.000Z'), graph),
      quad(msg2, namedNode(RDF_TYPE), namedNode(MEETING_MESSAGE), graph),
      quad(msg2, namedNode(SIOC_HAS_MEMBER), thread, graph),
      quad(msg2, namedNode(DCT_CREATED), literal('2026-05-18T00:00:02.000Z'), graph),
    ]);
  });

  afterEach(async () => {
    await engine.close();
  });

  it('executes a BGP join and projects bindings', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
      ],
      select: ['message', 'content'],
      orderBy: [{ variable: 'message' }],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      content: binding.content.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        content: 'hello',
      },
    ]);
    expect(result.metrics.plan).toContain('IndexJoinOrder(asc:message)');
    expect(result.metrics.plan).not.toContain('Sort');
    expect(result.metrics.indexChoices.length).toBeGreaterThan(0);
  });

  it('pushes safe required BGP joins into the RDF quad index', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
      ],
      select: ['message', 'content'],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      content: binding.content.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        content: 'hello',
      },
    ]);
    expect(result.metrics.plan).toContain('JoinBGP(2)');
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexJoin('))).toBe(true);
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
  });

  it('reorders SQL self-join BGP patterns by embedded index cardinality', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: literal('hello'),
        },
      ],
      select: ['message'],
    });

    expect(result.bindings.map((binding) => termToId(binding.message as any))).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
    ]);
    expect(result.metrics.plan).toContain('JoinReorder(1>0)');
    const indexJoin = result.metrics.plan.find((entry) => entry.startsWith('IndexJoin(')) ?? '';
    expect(indexJoin.indexOf(`predicate:${SIOC_CONTENT}`)).toBeLessThan(indexJoin.indexOf(`predicate:${RDF_TYPE}`));
  });

  it('pushes safe required BGP join ORDER and LIMIT into the RDF quad index', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(DCT_CREATED),
          object: rdfVar('createdAt'),
        },
      ],
      select: ['message', 'createdAt'],
      orderBy: [{ variable: 'createdAt', direction: 'desc' }],
      limit: 1,
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      createdAt: binding.createdAt.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        createdAt: '2026-05-18T00:00:02.000Z',
      },
    ]);
    expect(result.metrics.plan).toContain('JoinBGP(2)');
    expect(result.metrics.plan).toContain('JoinOrder(desc:createdAt)');
    expect(result.metrics.plan).toContain('JoinLimit');
    expect(result.metrics.plan).toContain('IndexJoinOrder(desc:createdAt)');
    expect(result.metrics.plan).toContain('IndexJoinLimit');
    expect(result.metrics.plan).not.toContain('Sort');
    expect(result.metrics.plan).not.toContain('Limit');
    expect(result.metrics.returnedRows).toBe(1);
    expect(result.metrics.joinedRows).toBe(1);
  });

  it('pushes safe required BGP filters into the SQL self-join', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(DCT_CREATED),
          object: rdfVar('createdAt'),
        },
      ],
      filters: [
        {
          variable: 'createdAt',
          operator: '$lte',
          value: literal('2026-05-18T00:00:01.500Z'),
        },
      ],
      select: ['message', 'createdAt'],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      createdAt: binding.createdAt.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        createdAt: '2026-05-18T00:00:01.000Z',
      },
    ]);
    expect(result.metrics.plan).toContain('JoinBGP(2)');
    expect(result.metrics.plan).toContain('LexicalRange(object$lte)');
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexJoin('))).toBe(true);
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
    expect(result.metrics.filtersPushedDown).toBe(1);
  });

  it('keeps unsafe required BGP filters out of SQL self-join pushdown', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(DCT_CREATED),
          object: rdfVar('createdAt'),
        },
      ],
      filters: [
        {
          variable: 'createdAt',
          operator: '$gt',
          operand: 'stringLength',
          value: literal('0', namedNode(XSD_INTEGER)),
        },
      ],
      select: ['message', 'createdAt'],
    });

    expect(result.bindings.map((binding) => termToId(binding.message as any))).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
    ]);
    expect(result.metrics.plan).not.toContain('JoinBGP(2)');
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexJoin('))).toBe(false);
    expect(result.metrics.plan).toContain('Filter(?createdAt:stringLength$gt)');
    expect(result.metrics.filtersPushedDown).toBe(0);
  });

  it('pushes mixed-direction required BGP ordering into SQL join pushdown', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(DCT_CREATED),
          object: rdfVar('createdAt'),
        },
      ],
      select: ['message', 'createdAt'],
      orderBy: [
        { variable: 'createdAt', direction: 'desc' },
        { variable: 'message', direction: 'asc' },
      ],
      limit: 1,
    });

    expect(result.bindings.map((binding) => termToId(binding.message as any))).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
    ]);
    expect(result.metrics.plan).toContain('JoinOrder(desc:createdAt,asc:message)');
    expect(result.metrics.plan).toContain('JoinLimit');
    expect(result.metrics.plan).toContain('IndexJoinOrder(desc:createdAt,asc:message)');
    expect(result.metrics.plan).toContain('IndexJoinLimit');
    expect(result.metrics.plan).not.toContain('Sort');
    expect(result.metrics.plan).not.toContain('Limit');
  });

  it('keeps single-pattern LIMIT out of index pushdown when repeated variables need row consistency checks', () => {
    const graph = namedNode('https://pod.example/alice/.data/rdf/repeated.ttl');
    const related = namedNode('https://undefineds.co/ns#related');
    const invalidFirst = namedNode('https://pod.example/alice/.data/rdf/repeated.ttl#a');
    const invalidTarget = namedNode('https://pod.example/alice/.data/rdf/repeated.ttl#z');
    const validSecond = namedNode('https://pod.example/alice/.data/rdf/repeated.ttl#b');

    engine.put([
      quad(invalidFirst, related, invalidTarget, graph),
      quad(validSecond, related, validSecond, graph),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('resource'),
          predicate: related,
          object: rdfVar('resource'),
        },
      ],
      select: ['resource'],
      orderBy: [{ variable: 'resource' }],
      limit: 1,
    });

    expect(result.bindings).toEqual([{ resource: validSecond }]);
    expect(result.metrics.plan).toContain('IndexOrder(asc:subject)');
    expect(result.metrics.plan).toContain('Limit');
    expect(result.metrics.plan).not.toContain('IndexLimit');
  });

  it('preserves required rows across OPTIONAL groups', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
      ],
      optional: [[
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
      ]],
      select: ['message', 'content'],
      orderBy: [{ variable: 'message' }],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      content: binding.content?.value ?? null,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        content: 'hello',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        content: null,
      },
    ]);
  });

  it('evaluates nested OPTIONAL groups while preserving left join rows', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
      ],
      optional: [
        {
          patterns: [
            {
              subject: rdfVar('message'),
              predicate: namedNode(SIOC_CONTENT),
              object: rdfVar('content'),
            },
          ],
          optional: [
            {
              patterns: [
                {
                  subject: rdfVar('message'),
                  predicate: namedNode(SIOC_HAS_MEMBER),
                  object: rdfVar('thread'),
                },
              ],
            },
          ],
        },
      ],
      select: ['message', 'content', 'thread'],
      orderBy: [{ variable: 'message' }],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      content: binding.content?.value ?? null,
      thread: binding.thread?.value ?? null,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        content: 'hello',
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        content: null,
        thread: null,
      },
    ]);
    expect(result.metrics.plan.some((entry) => entry.startsWith('OptionalNestedJoin('))).toBe(true);
  });

  it('applies OPTIONAL-local semi-joins inside matching branches', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
      ],
      optional: [
        {
          patterns: [
            {
              subject: rdfVar('message'),
              predicate: namedNode(SIOC_CONTENT),
              object: rdfVar('content'),
            },
          ],
          exists: [
            {
              patterns: [
                {
                  subject: rdfVar('message'),
                  predicate: namedNode(SIOC_HAS_MEMBER),
                  object: rdfVar('thread'),
                },
              ],
            },
          ],
        },
      ],
      select: ['message', 'content', 'thread'],
      orderBy: [{ variable: 'message' }],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      content: binding.content?.value ?? null,
      thread: binding.thread?.value ?? null,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        content: 'hello',
        thread: null,
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        content: null,
        thread: null,
      },
    ]);
    expect(result.metrics.plan).toContain('OptionalExists(subject:?message,predicate:http://rdfs.org/sioc/ns#has_member,object:?thread)');
  });

  it('applies OPTIONAL-local anti-joins while preserving left join rows', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
      ],
      optional: [
        {
          patterns: [
            {
              subject: rdfVar('message'),
              predicate: namedNode(SIOC_CONTENT),
              object: rdfVar('content'),
            },
          ],
          minus: [
            {
              patterns: [
                {
                  subject: rdfVar('message'),
                  predicate: namedNode(SIOC_CONTENT),
                  object: literal('hello'),
                },
              ],
            },
          ],
        },
      ],
      select: ['message', 'content'],
      orderBy: [{ variable: 'message' }],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      content: binding.content?.value ?? null,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        content: null,
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        content: null,
      },
    ]);
    expect(result.metrics.plan).toContain('OptionalMinus(subject:?message,predicate:http://rdfs.org/sioc/ns#content,object:"hello")');
  });

  it('applies dependent UNION branches inside semi-joins and anti-joins', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
      ],
      exists: [
        {
          patterns: [],
          unions: [
            {
              branches: [
                {
                  patterns: [
                    {
                      subject: rdfVar('message'),
                      predicate: namedNode(SIOC_CONTENT),
                      object: rdfVar('value'),
                    },
                  ],
                },
                {
                  patterns: [
                    {
                      subject: rdfVar('message'),
                      predicate: namedNode(SIOC_HAS_MEMBER),
                      object: rdfVar('value'),
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      minus: [
        {
          patterns: [
            {
              subject: rdfVar('message'),
              predicate: namedNode(SIOC_HAS_MEMBER),
              object: rdfVar('thread'),
            },
          ],
          unions: [
            {
              branches: [
                {
                  patterns: [
                    {
                      subject: rdfVar('message'),
                      predicate: namedNode(SIOC_CONTENT),
                      object: literal('hello'),
                    },
                  ],
                },
                {
                  patterns: [
                    {
                      subject: rdfVar('message'),
                      predicate: namedNode(SIOC_CONTENT),
                      object: literal('archived'),
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      select: ['message'],
      orderBy: [{ variable: 'message' }],
    });

    expect(result.bindings.map((binding) => termToId(binding.message as any))).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
    ]);
    expect(result.metrics.plan.some((entry) => entry.startsWith('ExistsUnion('))).toBe(true);
    expect(result.metrics.plan.some((entry) => entry.startsWith('MinusUnion('))).toBe(true);
  });

  it('filters rows where OPTIONAL variables remain unbound', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
      ],
      optional: [[
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
      ]],
      filters: [
        {
          variable: 'content',
          operator: '$bound',
          value: false,
        },
      ],
      select: ['message'],
    });

    expect(result.bindings).toEqual([
      {
        message: namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
      },
    ]);
    expect(result.metrics.plan).toContain('Filter(?content$bound)');
  });

  it('evaluates case-normalized string filters without index pushdown', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
      ],
      filters: [
        {
          variable: 'content',
          operator: '$contains',
          operand: 'lowerStringValue',
          value: 'ell',
        },
        {
          variable: 'content',
          operator: '$startsWith',
          operand: 'upperStringValue',
          value: 'HE',
        },
      ],
      select: ['message', 'content'],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      content: binding.content.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        content: 'hello',
      },
    ]);
    expect(result.metrics.plan).toContain('Filter(?content:lowerStringValue$contains,?content:upperStringValue$startsWith)');
    expect(result.metrics.filtersPushedDown).toBe(0);
  });

  it('compares case-normalized string values across variables', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
      ],
      binds: [
        {
          variable: 'expected',
          expression: {
            type: 'term',
            term: literal('HELLO'),
          },
        },
      ],
      filters: [
        {
          variable: 'content',
          operator: '$eq',
          operand: 'upperStringValue',
          variable2: 'expected',
        },
      ],
      select: ['message'],
    });

    expect(result.bindings.map((binding) => termToId(binding.message as any))).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
    ]);
    expect(result.metrics.plan).toContain('Filter(?content:upperStringValue$eq)');
  });

  it('applies optional-local filters without dropping required rows', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
      ],
      optional: [
        {
          patterns: [
            {
              subject: rdfVar('message'),
              predicate: namedNode(SIOC_CONTENT),
              object: rdfVar('content'),
            },
          ],
          filters: [
            {
              variable: 'content',
              operator: '$contains',
              value: 'missing',
            },
          ],
        },
      ],
      select: ['message', 'content'],
      orderBy: [{ variable: 'message' }],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      content: binding.content?.value ?? null,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        content: null,
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        content: null,
      },
    ]);
    expect(result.metrics.plan).toContain('OptionalFilter(?content$contains)');
  });

  it('evaluates VALUES inside OPTIONAL while preserving left join rows', () => {
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const missing = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#missing');
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
      ],
      optional: [
        {
          values: [
            {
              variables: ['message', 'tag'],
              rows: [
                { message: msg1, tag: literal('selected') },
                { message: missing, tag: literal('ignored') },
              ],
            },
          ],
          patterns: [
            {
              subject: rdfVar('message'),
              predicate: namedNode(SIOC_CONTENT),
              object: rdfVar('content'),
            },
          ],
        },
      ],
      select: ['message', 'tag', 'content'],
      orderBy: [{ variable: 'message' }],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      tag: binding.tag?.value ?? null,
      content: binding.content?.value ?? null,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        tag: 'selected',
        content: 'hello',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        tag: null,
        content: null,
      },
    ]);
    expect(result.metrics.plan).toContain('OptionalValues(?message,?tag)');
  });

  it('evaluates UNION groups inside OPTIONAL while preserving left join rows', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
      ],
      optional: [
        {
          patterns: [],
          unions: [
            {
              branches: [
                {
                  patterns: [
                    {
                      subject: rdfVar('message'),
                      predicate: namedNode(SIOC_CONTENT),
                      object: rdfVar('value'),
                    },
                  ],
                },
                {
                  patterns: [
                    {
                      subject: rdfVar('message'),
                      predicate: namedNode(SIOC_HAS_MEMBER),
                      object: rdfVar('value'),
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      select: ['message', 'value'],
      orderBy: [{ variable: 'message' }, { variable: 'value' }],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      value: binding.value?.value ?? null,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'hello',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
    ]);
    expect(result.metrics.plan.some((entry) => entry.startsWith('OptionalUnion('))).toBe(true);
  });

  it('applies LANGMATCHES filters with standard basic language-range semantics', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const msg3 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3');
    engine.put([
      quad(msg3, namedNode(SIOC_CONTENT), literal('howdy', 'en-US'), graph),
    ]);

    const enResult = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
      ],
      filters: [
        {
          variable: 'content',
          operator: '$langMatches',
          value: 'en',
        },
      ],
      select: ['message'],
      orderBy: [{ variable: 'message' }],
    });

    expect(enResult.bindings.map((binding) => termToId(binding.message as any))).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3',
    ]);
    expect(enResult.metrics.filtersPushedDown).toBe(1);
    expect(enResult.metrics.plan).toContain('Language(object$langMatches)');

    const wildcardResult = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
      ],
      filters: [
        {
          variable: 'content',
          operator: '$langMatches',
          value: '*',
        },
      ],
      select: ['message'],
      orderBy: [{ variable: 'message' }],
    });

    expect(wildcardResult.bindings.map((binding) => termToId(binding.message as any))).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3',
    ]);
    expect(wildcardResult.metrics.filtersPushedDown).toBe(1);
    expect(wildcardResult.metrics.plan).toContain('Language(object$langMatches)');
  });

  it('applies string-length filters after scan without pushing them into the term index', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const msg3 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3');
    engine.put([
      quad(msg3, namedNode(SIOC_CONTENT), literal('goodbye'), graph),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
      ],
      filters: [
        {
          variable: 'content',
          operator: '$gt',
          operand: 'stringLength',
          value: literal('5', namedNode(XSD_INTEGER)),
        },
      ],
      select: ['message'],
      orderBy: [{ variable: 'message' }],
    });

    expect(result.bindings.map((binding) => termToId(binding.message as any))).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3',
    ]);
    expect(result.metrics.filtersPushedDown).toBe(0);
    expect(result.metrics.plan).toContain('Filter(?content:stringLength$gt)');
  });

  it('applies string-value filters without treating lexical matches as same RDF term', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const iriObject = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1');
    const literalObject = literal('https://pod.example/alice/.data/chat/default/index.ttl#thread_1');
    const msg3 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3');
    engine.put([
      quad(msg3, namedNode(SIOC_HAS_MEMBER), literalObject, graph),
    ]);

    const termResult = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
      ],
      filters: [
        {
          variable: 'thread',
          operator: '$eq',
          value: iriObject,
        },
      ],
      select: ['message'],
      orderBy: [{ variable: 'message' }],
    });

    expect(termResult.bindings.map((binding) => termToId(binding.message as any))).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
    ]);

    const stringResult = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
      ],
      filters: [
        {
          variable: 'thread',
          operator: '$eq',
          operand: 'stringValue',
          value: iriObject.value,
        },
      ],
      select: ['message'],
      orderBy: [{ variable: 'message' }],
    });

    expect(stringResult.bindings.map((binding) => termToId(binding.message as any))).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3',
    ]);
    expect(stringResult.metrics.filtersPushedDown).toBe(0);
    expect(stringResult.metrics.plan).toContain('Filter(?thread:stringValue$eq)');
  });

  it('evaluates BIND expressions after required joins', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
      ],
      binds: [
        {
          variable: 'messageLexical',
          expression: {
            type: 'stringValue',
            variable: 'message',
          },
        },
        {
          variable: 'messageIri',
          expression: {
            type: 'iri',
            expression: {
              type: 'variable',
              variable: 'messageLexical',
            },
            base: 'https://pod.example/alice/',
          },
        },
        {
          variable: 'contentLength',
          expression: {
            type: 'stringLength',
            variable: 'content',
          },
        },
      ],
      select: ['messageLexical', 'messageIri', 'contentLength'],
    });

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].messageLexical.value).toBe('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    expect(result.bindings[0].messageIri).toEqual(namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'));
    expect(result.bindings[0].contentLength).toEqual(literal('5', namedNode(XSD_INTEGER)));
    expect(result.metrics.plan).toContain('Bind(?messageLexical:=STR(?message),?messageIri:=IRI(?messageLexical),?contentLength:=STRLEN(?content))');
  });

  it('evaluates CONCAT BIND expressions after required joins', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
      ],
      binds: [
        {
          variable: 'messageContent',
          expression: {
            type: 'concat',
            expressions: [
              { type: 'stringValue', variable: 'message' },
              { type: 'stringValue', variable: 'content' },
            ],
          },
        },
      ],
      select: ['messageContent'],
    });

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].messageContent.value).toBe(
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1hello',
    );
  });

  it('evaluates SUBSTR BIND expressions after required joins', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
      ],
      binds: [
        {
          variable: 'contentSlice',
          expression: {
            type: 'substring',
            expression: {
              type: 'stringValue',
              variable: 'content',
            },
            start: {
              type: 'term',
              term: literal('2'),
            },
            length: {
              type: 'term',
              term: literal('3'),
            },
          },
        },
        {
          variable: 'contentTail',
          expression: {
            type: 'substring',
            expression: {
              type: 'stringValue',
              variable: 'content',
            },
            start: {
              type: 'term',
              term: literal('4'),
            },
          },
        },
      ],
      select: ['contentSlice', 'contentTail'],
    });

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].contentSlice.value).toBe('ell');
    expect(result.bindings[0].contentTail.value).toBe('lo');
    expect(result.metrics.plan).toContain('Bind(?contentSlice:=SUBSTR(STR(?content),2,3),?contentTail:=SUBSTR(STR(?content),4))');
  });

  it('evaluates SUBSTR with dynamic start and length expressions after prior binds', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
      ],
      binds: [
        {
          variable: 'start',
          expression: {
            type: 'term',
            term: literal('2', namedNode(XSD_INTEGER)),
          },
        },
        {
          variable: 'length',
          expression: {
            type: 'stringLength',
            variable: 'content',
          },
        },
        {
          variable: 'contentSlice',
          expression: {
            type: 'substring',
            expression: {
              type: 'stringValue',
              variable: 'content',
            },
            start: {
              type: 'variable',
              variable: 'start',
            },
            length: {
              type: 'variable',
              variable: 'length',
            },
          },
        },
      ],
      select: ['contentSlice'],
    });

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].contentSlice.value).toBe('ello');
    expect(result.metrics.plan).toContain('Bind(?start:=2,?length:=STRLEN(?content),?contentSlice:=SUBSTR(STR(?content),?start,?length))');
  });

  it('evaluates optional BIND expressions inside OPTIONAL joins', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
      ],
      optional: [
        {
          patterns: [
            {
              subject: rdfVar('message'),
              predicate: namedNode(SIOC_CONTENT),
              object: rdfVar('content'),
            },
          ],
          binds: [
            {
              variable: 'contentLabel',
              expression: {
                type: 'concat',
                expressions: [
                  {
                    type: 'stringValue',
                    variable: 'content',
                  },
                  {
                    type: 'term',
                    term: literal('-optional'),
                  },
                ],
              },
            },
          ],
        },
      ],
      select: ['message', 'contentLabel'],
      orderBy: [{ variable: 'message' }],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      contentLabel: binding.contentLabel?.value ?? null,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        contentLabel: 'hello-optional',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        contentLabel: null,
      },
    ]);
    expect(result.metrics.plan).toContain('OptionalBind(?contentLabel:=CONCAT(STR(?content),"-optional"))');
  });

  it('evaluates lowercase and uppercase BIND expressions after required joins', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
      ],
      binds: [
        {
          variable: 'lowerContent',
          expression: {
            type: 'lowerCase',
            expression: {
              type: 'term',
              term: literal('HeLLo'),
            },
          },
        },
        {
          variable: 'upperContent',
          expression: {
            type: 'upperCase',
            expression: {
              type: 'stringValue',
              variable: 'content',
            },
          },
        },
      ],
      select: ['lowerContent', 'upperContent'],
    });

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].lowerContent.value).toBe('hello');
    expect(result.bindings[0].upperContent.value).toBe('HELLO');
    expect(result.metrics.plan).toContain('Bind(?lowerContent:=LCASE("HeLLo"),?upperContent:=UCASE(STR(?content)))');
  });

  it('counts distinct bindings after joins', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
      ],
      aggregate: {
        type: 'count',
        as: 'count',
        variable: 'message',
        distinct: true,
      },
    });

    expect(result.count).toBe(2);
    expect(result.bindings[0].count.value).toBe('2');
    expect(result.metrics.plan).toContain('Aggregate(count-distinct)');
    expect(result.metrics.plan).toContain('Aggregate(join-count-distinct-index)');
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexJoinCount('))).toBe(true);
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
  });

  it('reorders SQL self-join COUNT patterns before aggregate pushdown', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: literal('hello'),
        },
      ],
      aggregate: {
        type: 'count',
        as: 'count',
        variable: 'message',
      },
    });

    expect(result.count).toBe(1);
    expect(result.bindings[0].count.value).toBe('1');
    expect(result.metrics.plan).toContain('JoinReorder(1>0)');
    const indexJoinCount = result.metrics.plan.find((entry) => entry.startsWith('IndexJoinCount(')) ?? '';
    expect(indexJoinCount.indexOf(`predicate:${SIOC_CONTENT}`)).toBeLessThan(indexJoinCount.indexOf(`predicate:${RDF_TYPE}`));
  });

  it('does not use COUNT pushdown when aggregate HAVING must be applied', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
      ],
      aggregate: {
        type: 'count',
        as: 'count',
        variable: 'message',
      },
      having: [
        {
          variable: 'count',
          operator: '$gt',
          value: literal('3', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
        },
      ],
    });

    expect(result.count).toBe(2);
    expect(result.bindings).toEqual([]);
    expect(result.metrics.plan).toContain('Aggregate(count)');
    expect(result.metrics.plan).toContain('Having(?count$gt)');
    expect(result.metrics.plan).not.toContain('Aggregate(count-index)');
  });

  it('reorders SQL self-join GROUP COUNT patterns before grouped aggregate pushdown', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: literal('hello'),
        },
      ],
      groupBy: ['message'],
      aggregate: {
        type: 'count',
        as: 'count',
        variable: 'message',
      },
      select: ['message', 'count'],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      count: binding.count.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        count: '1',
      },
    ]);
    expect(result.metrics.plan).toContain('JoinReorder(1>0)');
    const indexGroupCount = result.metrics.plan.find((entry) => entry.startsWith('IndexGroupCount(')) ?? '';
    expect(indexGroupCount).toBe('IndexGroupCount(?message)');
  });

  it('groups bindings and counts rows per group', () => {
    const secondThread = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_2');
    const msg3 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3');
    engine.put([
      quad(
        msg3,
        namedNode(SIOC_HAS_MEMBER),
        secondThread,
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
      ],
      groupBy: ['thread'],
      aggregate: {
        type: 'count',
        as: 'count',
        variable: 'message',
      },
      select: ['thread', 'count'],
      orderBy: [{ variable: 'thread' }],
    });

    expect(result.bindings.map((binding) => ({
      thread: termToId(binding.thread as any),
      count: binding.count.value,
    }))).toEqual([
      {
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        count: '2',
      },
      {
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_2',
        count: '1',
      },
    ]);
    expect(result.metrics.plan).toContain('Aggregate(group-count)');
    expect(result.metrics.plan).toContain('Aggregate(group-count-index)');
    expect(result.metrics.plan).toContain('IndexGroupCount(?thread)');
    expect(result.metrics.plan).not.toContain('Aggregate(count-index)');
  });

  it('pushes safe grouped COUNT filters into SQL instead of refiltering grouped rows', () => {
    const secondThread = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_2');
    const msg3 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3');
    engine.put([
      quad(
        msg3,
        namedNode(SIOC_HAS_MEMBER),
        secondThread,
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
      ],
      filters: [
        {
          variable: 'thread',
          operator: '$eq',
          value: namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        },
      ],
      groupBy: ['thread'],
      aggregate: {
        type: 'count',
        as: 'count',
        variable: 'message',
      },
      select: ['thread', 'count'],
    });

    expect(result.bindings.map((binding) => ({
      thread: termToId(binding.thread as any),
      count: binding.count.value,
    }))).toEqual([
      {
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        count: '2',
      },
    ]);
    expect(result.metrics.filtersPushedDown).toBe(1);
    expect(result.metrics.filtersApplied).toBe(0);
    expect(result.metrics.plan).toContain('Aggregate(group-count-index)');
    expect(result.metrics.plan).not.toContain('Filter(?thread$eq)');
  });

  it('pushes grouped COUNT ordering and pagination into SQL when there is no HAVING', () => {
    const secondThread = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_2');
    const msg3 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3');
    engine.put([
      quad(
        msg3,
        namedNode(SIOC_HAS_MEMBER),
        secondThread,
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
      ],
      groupBy: ['thread'],
      aggregate: {
        type: 'count',
        as: 'count',
        variable: 'message',
      },
      select: ['thread', 'count'],
      orderBy: [
        { variable: 'count', direction: 'desc' },
        { variable: 'thread', direction: 'asc' },
      ],
      limit: 1,
    });

    expect(result.bindings.map((binding) => ({
      thread: termToId(binding.thread as any),
      count: binding.count.value,
    }))).toEqual([
      {
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        count: '2',
      },
    ]);
    expect(result.metrics.plan).toContain('IndexGroupCountOrder(desc:count,asc:thread)');
    expect(result.metrics.plan).toContain('IndexGroupCountLimit');
    expect(result.metrics.plan).not.toContain('Sort');
    expect(result.metrics.plan).not.toContain('Limit');
    expect(result.metrics.returnedRows).toBe(1);
  });

  it('pushes grouped COUNT HAVING before pagination in SQL', () => {
    const secondThread = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_2');
    const msg3 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3');
    engine.put([
      quad(
        msg3,
        namedNode(SIOC_HAS_MEMBER),
        secondThread,
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
      ],
      groupBy: ['thread'],
      aggregate: {
        type: 'count',
        as: 'count',
        variable: 'message',
      },
      having: [
        {
          variable: 'count',
          operator: '$lt',
          value: literal('2', namedNode(XSD_INTEGER)),
        },
      ],
      select: ['thread', 'count'],
      orderBy: [{ variable: 'count', direction: 'desc' }],
      limit: 1,
    });

    expect(result.bindings.map((binding) => ({
      thread: termToId(binding.thread as any),
      count: binding.count.value,
    }))).toEqual([
      {
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_2',
        count: '1',
      },
    ]);
    expect(result.metrics.plan).toContain('IndexGroupCountOrder(desc:count)');
    expect(result.metrics.plan).toContain('IndexGroupCountHaving(?count$lt)');
    expect(result.metrics.plan).toContain('IndexGroupCountLimit');
    expect(result.metrics.plan).not.toContain('Having(?count$lt)');
    expect(result.metrics.plan).not.toContain('Limit');
  });

  it('applies local binds before grouping COUNT results', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
      ],
      binds: [
        {
          variable: 'threadKey',
          expression: {
            type: 'stringValue',
            variable: 'thread',
          },
        },
      ],
      groupBy: ['threadKey'],
      aggregate: {
        type: 'count',
        as: 'count',
        variable: 'message',
      },
      select: ['threadKey', 'count'],
    });

    expect(result.bindings.map((binding) => ({
      threadKey: binding.threadKey.value,
      count: binding.count.value,
    }))).toEqual([
      {
        threadKey: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        count: '2',
      },
    ]);
    expect(result.metrics.plan).toContain('Bind(?threadKey:=STR(?thread))');
    expect(result.metrics.plan).toContain('Aggregate(group-count)');
    expect(result.metrics.plan).not.toContain('Aggregate(group-count-index)');
  });

  it('filters grouped COUNT results with HAVING filters', () => {
    const secondThread = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_2');
    const msg3 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3');
    engine.put([
      quad(
        msg3,
        namedNode(SIOC_HAS_MEMBER),
        secondThread,
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
      ],
      groupBy: ['thread'],
      aggregate: {
        type: 'count',
        as: 'count',
        variable: 'message',
      },
      having: [
        {
          variable: 'count',
          operator: '$gt',
          value: literal('1', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
        },
      ],
      select: ['thread', 'count'],
      orderBy: [{ variable: 'thread' }],
    });

    expect(result.bindings.map((binding) => ({
      thread: termToId(binding.thread as any),
      count: binding.count.value,
    }))).toEqual([
      {
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        count: '2',
      },
    ]);
    expect(result.metrics.plan).toContain('IndexGroupCountHaving(?count$gt)');
    expect(result.metrics.plan).not.toContain('Having(?count$gt)');
    expect(result.metrics.plan).toContain('Aggregate(group-count-index)');
  });

  it('keeps non-numeric grouped COUNT HAVING outside SQL pushdown', () => {
    const secondThread = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_2');
    const msg3 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3');
    engine.put([
      quad(
        msg3,
        namedNode(SIOC_HAS_MEMBER),
        secondThread,
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
      ],
      groupBy: ['thread'],
      aggregate: {
        type: 'count',
        as: 'count',
        variable: 'message',
      },
      having: [
        {
          variable: 'count',
          operator: '$gt',
          value: literal('not-a-number'),
        },
      ],
      select: ['thread', 'count'],
      orderBy: [{ variable: 'count', direction: 'desc' }],
      limit: 1,
    });

    expect(result.bindings).toEqual([]);
    expect(result.metrics.plan).toContain('Having(?count$gt)');
    expect(result.metrics.plan).toContain('Limit');
    expect(result.metrics.plan).not.toContain('IndexGroupCountHaving(?count$gt)');
    expect(result.metrics.plan).not.toContain('IndexGroupCountLimit');
  });

  it('supports distinct counts inside grouped aggregates', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    engine.put([
      quad(msg1, namedNode(SIOC_HAS_MEMBER), literal('duplicate row noise'), graph),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
        {
          subject: rdfVar('message'),
          predicate: rdfVar('predicate'),
          object: rdfVar('value'),
        },
      ],
      filters: [
        {
          variable: 'thread',
          operator: '$eq',
          value: namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        },
      ],
      groupBy: ['thread'],
      aggregate: {
        type: 'count',
        as: 'count',
        variable: 'message',
        distinct: true,
      },
      select: ['thread', 'count'],
    });

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].thread).toEqual(namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'));
    expect(result.bindings[0].count.value).toBe('2');
    expect(result.metrics.plan).toContain('Aggregate(group-count-distinct)');
    expect(result.metrics.plan).toContain('Aggregate(group-count-index)');
  });

  it('supports multiple COUNT projections in grouped aggregates', () => {
    const secondThread = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_2');
    const msg3 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3');
    engine.put([
      quad(
        msg3,
        namedNode(SIOC_HAS_MEMBER),
        secondThread,
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
      ],
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
      select: ['thread', 'messageCount', 'distinctMessageCount'],
      orderBy: [{ variable: 'thread' }],
    });

    expect(result.bindings.map((binding) => ({
      thread: termToId(binding.thread as any),
      messageCount: binding.messageCount.value,
      distinctMessageCount: binding.distinctMessageCount.value,
    }))).toEqual([
      {
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        messageCount: '2',
        distinctMessageCount: '2',
      },
      {
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_2',
        messageCount: '1',
        distinctMessageCount: '1',
      },
    ]);
    expect(result.metrics.plan).toContain('Aggregate(group-count-multi-distinct)');
    expect(result.metrics.plan).toContain('Aggregate(group-count-index)');
  });

  it('computes guarded numeric aggregates in local aggregate rows', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    engine.put([
      quad(msg1, namedNode(UDFS_PRIORITY), literal('2', namedNode(XSD_INTEGER)), graph),
      quad(msg2, namedNode(UDFS_PRIORITY), literal('10', namedNode(XSD_INTEGER)), graph),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(UDFS_PRIORITY),
          object: rdfVar('priority'),
        },
      ],
      filters: [
        {
          variable: 'priority',
          operator: '$termType',
          value: 'numeric',
        },
      ],
      aggregates: [
        {
          type: 'sum',
          as: 'sum',
          variable: 'priority',
        },
        {
          type: 'avg',
          as: 'avg',
          variable: 'priority',
        },
        {
          type: 'min',
          as: 'min',
          variable: 'priority',
        },
        {
          type: 'max',
          as: 'max',
          variable: 'priority',
        },
      ],
      select: ['sum', 'avg', 'min', 'max'],
    });

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].sum.value).toBe('12');
    expect(result.bindings[0].avg.value).toBe('6');
    expect(result.bindings[0].min.value).toBe('2');
    expect(result.bindings[0].max.value).toBe('10');
    expect(result.metrics.plan).toContain('Aggregate(basic-multi)');
    expect(result.metrics.plan).not.toContain('Aggregate(count-index)');
  });

  it('pushes guarded numeric aggregates into SQL when the required shape is safe', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    const msg3 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3');
    engine.put([
      quad(msg1, namedNode(RDF_TYPE), namedNode(MEETING_MESSAGE), graph),
      quad(msg1, namedNode(UDFS_PRIORITY), literal('2', namedNode(XSD_INTEGER)), graph),
      quad(msg2, namedNode(RDF_TYPE), namedNode(MEETING_MESSAGE), graph),
      quad(msg2, namedNode(UDFS_PRIORITY), literal('10', namedNode(XSD_INTEGER)), graph),
      quad(msg3, namedNode(RDF_TYPE), namedNode(MEETING_MESSAGE), graph),
      quad(msg3, namedNode(UDFS_PRIORITY), literal('not numeric'), graph),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(UDFS_PRIORITY),
          object: rdfVar('priority'),
        },
      ],
      filters: [
        {
          variable: 'priority',
          operator: '$termType',
          value: 'numeric',
        },
      ],
      aggregates: [
        {
          type: 'sum',
          as: 'sum',
          variable: 'priority',
        },
        {
          type: 'avg',
          as: 'avg',
          variable: 'priority',
        },
        {
          type: 'min',
          as: 'min',
          variable: 'priority',
        },
        {
          type: 'max',
          as: 'max',
          variable: 'priority',
        },
      ],
      select: ['sum', 'avg', 'min', 'max'],
    });

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].sum.value).toBe('12');
    expect(result.bindings[0].sum.datatype.value).toBe('http://www.w3.org/2001/XMLSchema#decimal');
    expect(result.bindings[0].avg.value).toBe('6');
    expect(result.bindings[0].min.value).toBe('2');
    expect(result.bindings[0].max.value).toBe('10');
    expect(result.metrics.joinedRows).toBe(2);
    expect(result.metrics.plan).toContain('Aggregate(basic-multi)');
    expect(result.metrics.plan).toContain('Aggregate(join-basic-multi-index)');
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexJoinAggregate('))).toBe(true);
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
  });

  it('pushes grouped guarded numeric aggregates into SQL when the required shape is safe', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const thread2 = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_2');
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    const msg3 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3');
    const msg4 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_4');
    engine.put([
      quad(msg1, namedNode(UDFS_PRIORITY), literal('2', namedNode(XSD_INTEGER)), graph),
      quad(msg2, namedNode(UDFS_PRIORITY), literal('10', namedNode(XSD_INTEGER)), graph),
      quad(msg3, namedNode(SIOC_HAS_MEMBER), thread2, graph),
      quad(msg3, namedNode(UDFS_PRIORITY), literal('4', namedNode(XSD_INTEGER)), graph),
      quad(msg4, namedNode(SIOC_HAS_MEMBER), thread2, graph),
      quad(msg4, namedNode(UDFS_PRIORITY), literal('not numeric'), graph),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(UDFS_PRIORITY),
          object: rdfVar('priority'),
        },
      ],
      filters: [
        {
          variable: 'priority',
          operator: '$termType',
          value: 'numeric',
        },
      ],
      groupBy: ['thread'],
      aggregates: [
        {
          type: 'count',
          as: 'count',
          variable: 'message',
        },
        {
          type: 'sum',
          as: 'total',
          variable: 'priority',
        },
        {
          type: 'avg',
          as: 'avg',
          variable: 'priority',
        },
      ],
      having: [
        {
          variable: 'total',
          operator: '$gt',
          value: literal('4', namedNode(XSD_INTEGER)),
        },
      ],
      select: ['thread', 'count', 'total', 'avg'],
      orderBy: [{ variable: 'total', direction: 'desc' }],
      limit: 1,
    });

    expect(result.bindings.map((binding) => ({
      thread: binding.thread.value,
      count: binding.count.value,
      total: binding.total.value,
      totalDatatype: binding.total.datatype.value,
      avg: binding.avg.value,
    }))).toEqual([
      {
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        count: '2',
        total: '12',
        totalDatatype: 'http://www.w3.org/2001/XMLSchema#decimal',
        avg: '6',
      },
    ]);
    expect(result.metrics.joinedRows).toBe(3);
    expect(result.metrics.plan).toContain('JoinGroupAggregateNumeric(?priority)');
    expect(result.metrics.plan).toContain('IndexGroupAggregate(?thread)');
    expect(result.metrics.plan).toContain('IndexGroupAggregateHaving(?total$gt)');
    expect(result.metrics.plan).toContain('IndexGroupAggregateOrder(desc:total)');
    expect(result.metrics.plan).toContain('IndexGroupAggregateLimit');
    expect(result.metrics.plan).toContain('Aggregate(group-basic-multi)');
    expect(result.metrics.plan).toContain('Aggregate(group-basic-multi-index)');
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
  });

  it('deduplicates projected bindings for SELECT DISTINCT semantics', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: rdfVar('predicate'),
          object: rdfVar('value'),
        },
      ],
      filters: [
        {
          variable: 'message',
          operator: '$eq',
          value: namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        },
      ],
      select: ['message'],
      distinct: true,
    });

    expect(result.bindings).toEqual([
      {
        message: namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
      },
    ]);
    expect(result.metrics.plan).toContain('JoinDistinct(?message)');
    expect(result.metrics.plan).toContain('IndexJoinDistinct(?message)');
    expect(result.metrics.plan).not.toContain('Distinct');
  });

  it('pushes single-pattern DISTINCT projection and pagination into SQL before LIMIT', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: rdfVar('predicate'),
          object: rdfVar('value'),
        },
      ],
      select: ['message'],
      distinct: true,
      orderBy: [{ variable: 'message' }],
      limit: 2,
    });

    expect(result.bindings.length).toBe(2);
    expect(result.bindings).toEqual([
      {
        message: namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
      },
      {
        message: namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
      },
    ]);
    expect(result.metrics.plan).toContain('JoinDistinct(?message)');
    expect(result.metrics.plan).toContain('IndexJoinDistinct(?message)');
    expect(result.metrics.plan).toContain('IndexJoinLimit');
    expect(result.metrics.plan).not.toContain('Distinct');
    expect(result.metrics.plan).not.toContain('Limit');
  });

  it('pushes safe required BGP DISTINCT projection and pagination into the SQL self-join', () => {
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');

    engine.put([
      quad(msg1, namedNode(UDFS_PRIORITY), literal('high'), graph),
      quad(msg1, namedNode(UDFS_PRIORITY), literal('urgent'), graph),
      quad(msg2, namedNode(UDFS_PRIORITY), literal('normal'), graph),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(UDFS_PRIORITY),
          object: rdfVar('priority'),
        },
      ],
      select: ['message'],
      distinct: true,
      orderBy: [{ variable: 'message' }],
      limit: 2,
    });

    expect(result.bindings).toEqual([
      { message: msg1 },
      { message: msg2 },
    ]);
    expect(result.metrics.plan).toContain('JoinDistinct(?message)');
    expect(result.metrics.plan).toContain('IndexJoinDistinct(?message)');
    expect(result.metrics.plan).toContain('IndexJoinLimit');
    expect(result.metrics.plan).not.toContain('Distinct');
    expect(result.metrics.plan).not.toContain('Limit');
  });

  it('pushes single-pattern COUNT into the term-id index when filters are safe', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(DCT_CREATED),
          object: rdfVar('createdAt'),
        },
      ],
      filters: [
        {
          variable: 'createdAt',
          operator: '$lte',
          value: literal('2026-05-18T00:00:02.000Z'),
        },
      ],
      aggregate: {
        type: 'count',
        as: 'count',
        variable: 'message',
      },
    });

    expect(result.count).toBe(2);
    expect(result.bindings[0].count.value).toBe('2');
    expect(result.metrics.plan).toContain('IndexCount(subject:?message,predicate:http://purl.org/dc/terms/created,object:?createdAt)');
    expect(result.metrics.plan).toContain('Aggregate(count-index)');
    expect(result.metrics.plan).not.toContain('Aggregate(count)');
    expect(result.metrics.filtersPushedDown).toBe(1);
  });

  it('pushes single-pattern COUNT DISTINCT into the term-id index when filters are safe', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
      ],
      filters: [
        {
          variable: 'thread',
          operator: '$eq',
          value: namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        },
      ],
      aggregate: {
        type: 'count',
        as: 'count',
        variable: 'message',
        distinct: true,
      },
    });

    expect(result.count).toBe(2);
    expect(result.bindings[0].count.value).toBe('2');
    expect(result.metrics.plan).toContain('IndexCount(subject:?message,predicate:http://rdfs.org/sioc/ns#has_member,object:?thread)');
    expect(result.metrics.plan).toContain('Aggregate(count-distinct-index)');
    expect(result.metrics.plan).not.toContain('Aggregate(count-distinct)');
    expect(result.metrics.filtersPushedDown).toBe(1);
  });

  it('does not push COUNT DISTINCT when one variable spans multiple term slots', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('message'),
        },
      ],
      aggregate: {
        type: 'count',
        as: 'count',
        variable: 'message',
        distinct: true,
      },
    });

    expect(result.count).toBe(0);
    expect(result.metrics.plan).toContain('Aggregate(count-distinct)');
    expect(result.metrics.plan).not.toContain('Aggregate(count-distinct-index)');
  });

  it('does not push COUNT when a single pattern repeats a variable across term slots', () => {
    const graph = namedNode('https://pod.example/alice/.data/rdf/repeated-count.ttl');
    const related = namedNode('https://undefineds.co/ns#related');
    const invalidFirst = namedNode('https://pod.example/alice/.data/rdf/repeated-count.ttl#a');
    const invalidTarget = namedNode('https://pod.example/alice/.data/rdf/repeated-count.ttl#z');
    const validSecond = namedNode('https://pod.example/alice/.data/rdf/repeated-count.ttl#b');

    engine.put([
      quad(invalidFirst, related, invalidTarget, graph),
      quad(validSecond, related, validSecond, graph),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('resource'),
          predicate: related,
          object: rdfVar('resource'),
        },
      ],
      aggregate: {
        type: 'count',
        as: 'count',
        variable: 'resource',
      },
    });

    expect(result.count).toBe(1);
    expect(result.bindings[0].count.value).toBe('1');
    expect(result.metrics.plan).toContain('Aggregate(count)');
    expect(result.metrics.plan).not.toContain('Aggregate(count-index)');
  });

  it('supports multiple COUNT projections without grouped rows', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
      ],
      aggregates: [
        {
          type: 'count',
          as: 'messageCount',
          variable: 'message',
        },
        {
          type: 'count',
          as: 'threadCount',
          variable: 'thread',
          distinct: true,
        },
      ],
    });

    expect(result.count).toBe(2);
    expect(result.bindings[0].messageCount.value).toBe('2');
    expect(result.bindings[0].threadCount.value).toBe('1');
    expect(result.metrics.plan).toContain('Aggregate(count-multi-distinct)');
    expect(result.metrics.plan).not.toContain('Aggregate(join-count-distinct-index)');
  });

  it('pushes multiple COUNT projections over BGP joins into SQL', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
      ],
      aggregates: [
        {
          type: 'count',
          as: 'messageCount',
          variable: 'message',
        },
        {
          type: 'count',
          as: 'threadCount',
          variable: 'thread',
          distinct: true,
        },
      ],
    });

    expect(result.count).toBe(2);
    expect(result.bindings[0].messageCount.value).toBe('2');
    expect(result.bindings[0].threadCount.value).toBe('1');
    expect(result.metrics.plan).toContain('Aggregate(count-multi-distinct)');
    expect(result.metrics.plan).toContain('Aggregate(join-count-distinct-index)');
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexJoinCount('))).toBe(true);
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
  });

  it('pushes range filters into index scans when filtering a pattern variable', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(DCT_CREATED),
          object: rdfVar('createdAt'),
        },
      ],
      filters: [
        {
          variable: 'createdAt',
          operator: '$lte',
          value: literal('2026-05-18T00:00:01.000Z'),
        },
      ],
      select: ['message', 'createdAt'],
      orderBy: [{ variable: 'createdAt' }],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      createdAt: binding.createdAt.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        createdAt: '2026-05-18T00:00:01.000Z',
      },
    ]);
    expect(result.metrics.filtersPushedDown).toBe(1);
    expect(result.metrics.plan).toContain('LexicalRange(object$lte)');
    expect(result.metrics.plan).not.toContain('Filter(?createdAt$lte)');
  });

  it('compares typed numeric literals numerically instead of lexically', () => {
    const graph = namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl');
    engine.put([
      quad(namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_2'), namedNode(UDFS_PRIORITY), literal('2', namedNode(XSD_INTEGER)), graph),
      quad(namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_10'), namedNode(UDFS_PRIORITY), literal('10', namedNode(XSD_INTEGER)), graph),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('run'),
          predicate: namedNode(UDFS_PRIORITY),
          object: rdfVar('priority'),
        },
      ],
      filters: [
        {
          variable: 'priority',
          operator: '$gt',
          value: literal('9', namedNode(XSD_INTEGER)),
        },
      ],
      select: ['run', 'priority'],
      orderBy: [{ variable: 'run' }],
    });

    expect(result.bindings.map((binding) => ({
      run: termToId(binding.run as any),
      priority: binding.priority.value,
    }))).toEqual([
      {
        run: 'https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_10',
        priority: '10',
      },
    ]);
    expect(result.metrics.plan).toContain('NumericRange(object$gt)');
    expect(result.metrics.plan).not.toContain('Filter(?priority$gt)');
  });

  it('applies reversed comparison filters compiled from term-variable SPARQL expressions', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(DCT_CREATED),
          object: rdfVar('createdAt'),
        },
      ],
      filters: [
        {
          variable: 'createdAt',
          operator: '$gte',
          value: literal('2026-05-18T00:00:02.000Z'),
        },
      ],
      select: ['message', 'createdAt'],
      orderBy: [{ variable: 'message' }],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      createdAt: binding.createdAt.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        createdAt: '2026-05-18T00:00:02.000Z',
      },
    ]);
    expect(result.metrics.filtersPushedDown).toBe(1);
    expect(result.metrics.plan).toContain('LexicalRange(object$gte)');
    expect(result.metrics.plan).not.toContain('Filter(?createdAt$gte)');
  });

  it('applies variable-variable filters after both sides are bound', () => {
    const graph = namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl');
    engine.put([
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_low'),
        namedNode(UDFS_PRIORITY),
        literal('2', namedNode(XSD_INTEGER)),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_high'),
        namedNode(UDFS_PRIORITY),
        literal('10', namedNode(XSD_INTEGER)),
        graph,
      ),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_low'),
          predicate: namedNode(UDFS_PRIORITY),
          object: rdfVar('low'),
        },
        {
          subject: namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_high'),
          predicate: namedNode(UDFS_PRIORITY),
          object: rdfVar('high'),
        },
      ],
      filters: [
        {
          variable: 'low',
          operator: '$lt',
          variable2: 'high',
        },
      ],
      select: ['low', 'high'],
    });

    expect(result.bindings.map((binding) => ({
      low: binding.low.value,
      high: binding.high.value,
    }))).toEqual([
      {
        low: '2',
        high: '10',
      },
    ]);
    expect(result.metrics.plan).toContain('Filter(?low$lt)');
  });

  it('applies variable-variable string-value and string-length filters after both sides are bound', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    engine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_a'),
        namedNode(SIOC_CONTENT),
        literal('hello'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_b'),
        namedNode(SIOC_CONTENT),
        literal('hello'),
        graph,
      ),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_a'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('leftValue'),
        },
        {
          subject: namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_b'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('rightValue'),
        },
      ],
      filters: [
        {
          variable: 'leftValue',
          operator: '$eq',
          operand: 'stringValue',
          variable2: 'rightValue',
        },
        {
          variable: 'leftValue',
          operator: '$eq',
          operand: 'stringLength',
          variable2: 'rightValue',
        },
      ],
      select: ['leftValue', 'rightValue'],
    });

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].leftValue.value).toBe('hello');
    expect(result.bindings[0].rightValue.value).toBe('hello');
    expect(result.metrics.plan).toContain('Filter(?leftValue:stringValue$eq,?leftValue:stringLength$eq)');
  });

  it('pushes VALUES-style IN filters into index scans', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
      ],
      filters: [
        {
          variable: 'message',
          operator: '$in',
          values: [
            namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
          ],
          source: 'values',
        },
      ],
      select: ['message'],
    });

    expect(result.bindings).toEqual([
      {
        message: namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
      },
    ]);
    expect(result.metrics.filtersPushedDown).toBe(1);
    expect(result.metrics.plan).toContain('TermIn(subject)');
    expect(result.metrics.plan).not.toContain('Filter(?message$in)');
  });

  it('joins correlated tuple VALUES without expanding to independent IN filters', () => {
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    const result = engine.query({
      values: [
        {
          variables: ['message', 'kind'],
          rows: [
            { message: msg1, kind: namedNode(MEETING_MESSAGE) },
            { message: msg2, kind: namedNode(SIOC_CONTENT) },
          ],
        },
      ],
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: rdfVar('kind'),
        },
      ],
      select: ['message', 'kind'],
      orderBy: [{ variable: 'message' }],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      kind: termToId(binding.kind as any),
    }))).toEqual([
      {
        message: termToId(msg1 as any),
        kind: MEETING_MESSAGE,
      },
    ]);
    expect(result.metrics.plan).toContain('TupleValuesJoin(subject,object)');
    expect(result.metrics.plan).not.toContain('Values(?message,?kind)');
  });

  it('joins VALUES UNDEF rows without pushing partial tuples into the index', () => {
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const result = engine.query({
      values: [
        {
          variables: ['message'],
          rows: [
            {},
            { message: msg1 },
          ],
        },
      ],
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
      ],
      select: ['message'],
      orderBy: [{ variable: 'message' }],
    });

    expect(result.bindings.map((binding) => termToId(binding.message as any))).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
    ]);
    expect(result.metrics.plan).toContain('Values(?message)');
    expect(result.metrics.plan).toContain('Sort');
    expect(result.metrics.plan).not.toContain('TupleValuesJoin(subject)');
  });

  it('keeps tuple VALUES constraints when a related pattern is planned first', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    engine.put([
      quad(msg2, namedNode(SIOC_CONTENT), literal('second'), graph),
    ]);

    const result = engine.query({
      values: [
        {
          variables: ['message', 'kind'],
          rows: [
            { message: msg1, kind: namedNode(MEETING_MESSAGE) },
            { message: msg2, kind: namedNode(SIOC_CONTENT) },
          ],
        },
      ],
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: rdfVar('kind'),
        },
      ],
      select: ['message', 'kind', 'content'],
      orderBy: [{ variable: 'message' }],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      kind: termToId(binding.kind as any),
      content: binding.content.value,
    }))).toEqual([
      {
        message: termToId(msg1 as any),
        kind: MEETING_MESSAGE,
        content: 'hello',
      },
    ]);
    expect(result.metrics.plan).toContain('TupleValuesJoin(subject,object)');
    expect(result.metrics.plan.findIndex((entry) => entry === 'TupleValuesJoin(subject,object)'))
      .toBeLessThan(result.metrics.plan.findIndex((entry) => entry.includes(`predicate:${SIOC_CONTENT}`)));
  });

  it('pushes OR-equivalent IN filters into index scans', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    engine.put([
      quad(msg2, namedNode(SIOC_CONTENT), literal('second'), graph),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
      ],
      filters: [
        {
          variable: 'content',
          operator: '$in',
          values: [
            literal('hello'),
            literal('second'),
          ],
        },
      ],
      select: ['message', 'content'],
      orderBy: [{ variable: 'message' }],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      content: binding.content.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        content: 'hello',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        content: 'second',
      },
    ]);
    expect(result.metrics.filtersPushedDown).toBe(1);
    expect(result.metrics.plan).toContain('TermIn(object)');
    expect(result.metrics.plan).not.toContain('Filter(?content$in)');
  });

  it('joins controlled UNION groups without falling back to the compatibility engine', () => {
    const result = engine.query({
      patterns: [],
      unions: [
        {
          branches: [
            {
              patterns: [
                {
                  subject: rdfVar('message'),
                  predicate: namedNode(SIOC_CONTENT),
                  object: rdfVar('value'),
                },
              ],
              filters: [
                {
                  variable: 'value',
                  operator: '$contains',
                  value: 'hello',
                },
              ],
            },
            {
              patterns: [
                {
                  subject: rdfVar('message'),
                  predicate: namedNode(SIOC_HAS_MEMBER),
                  object: rdfVar('value'),
                },
              ],
            },
          ],
        },
      ],
      select: ['message', 'value'],
      orderBy: [{ variable: 'message' }, { variable: 'value' }],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      value: binding.value.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'hello',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
    ]);
    expect(result.metrics.plan).toContain('UnionFilter(?value$contains)');
    expect(result.metrics.plan.some((entry) => entry.startsWith('Union('))).toBe(true);
  });

  it('evaluates UNION branch-local BIND expressions after branch joins', () => {
    const result = engine.query({
      patterns: [],
      unions: [
        {
          branches: [
            {
              patterns: [
                {
                  subject: rdfVar('message'),
                  predicate: namedNode(SIOC_CONTENT),
                  object: rdfVar('value'),
                },
              ],
              binds: [
                {
                  variable: 'label',
                  expression: {
                    type: 'concat',
                    expressions: [
                      {
                        type: 'term',
                        term: literal('content:'),
                      },
                      {
                        type: 'stringValue',
                        variable: 'value',
                      },
                    ],
                  },
                },
              ],
            },
            {
              patterns: [
                {
                  subject: rdfVar('message'),
                  predicate: namedNode(SIOC_HAS_MEMBER),
                  object: rdfVar('value'),
                },
              ],
              binds: [
                {
                  variable: 'label',
                  expression: {
                    type: 'concat',
                    expressions: [
                      {
                        type: 'term',
                        term: literal('member:'),
                      },
                      {
                        type: 'stringValue',
                        variable: 'value',
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
      select: ['message', 'value', 'label'],
      orderBy: [{ variable: 'message' }, { variable: 'label' }],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      value: binding.value?.value ?? null,
      label: binding.label?.value ?? null,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'hello',
        label: 'content:hello',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        label: 'member:https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        label: 'member:https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
    ]);
    expect(result.metrics.plan.some((entry) => entry.startsWith('UnionBind('))).toBe(true);
  });

  it('keeps tuple VALUES constraints local to UNION branches', () => {
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    const thread = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1');
    const result = engine.query({
      patterns: [],
      unions: [
        {
          branches: [
            {
              values: [
                {
                  variables: ['message', 'value'],
                  rows: [
                    { message: msg1, value: literal('hello') },
                    { message: msg2, value: literal('invalid-content') },
                  ],
                },
              ],
              patterns: [
                {
                  subject: rdfVar('message'),
                  predicate: namedNode(SIOC_CONTENT),
                  object: rdfVar('value'),
                },
              ],
            },
            {
              values: [
                {
                  variables: ['message', 'value'],
                  rows: [
                    { message: msg2, value: thread },
                    { message: msg1, value: literal('invalid-member') },
                  ],
                },
              ],
              patterns: [
                {
                  subject: rdfVar('message'),
                  predicate: namedNode(SIOC_HAS_MEMBER),
                  object: rdfVar('value'),
                },
              ],
            },
          ],
        },
      ],
      select: ['message', 'value'],
      orderBy: [{ variable: 'message' }, { variable: 'value' }],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      value: binding.value.value,
    }))).toEqual([
      {
        message: termToId(msg1 as any),
        value: 'hello',
      },
      {
        message: termToId(msg2 as any),
        value: termToId(thread as any),
      },
    ]);
    expect(result.metrics.plan).toContain('UnionValues(?message,?value)');
  });

  it('applies controlled MINUS anti-joins after required bindings', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
      ],
      minus: [
        {
          patterns: [
            {
              subject: rdfVar('message'),
              predicate: namedNode(SIOC_CONTENT),
              object: rdfVar('content'),
            },
          ],
        },
      ],
      select: ['message'],
    });

    expect(result.bindings).toEqual([
      {
        message: namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
      },
    ]);
    expect(result.metrics.plan).toContain('Minus(subject:?message,predicate:http://rdfs.org/sioc/ns#content,object:?content)');
  });

  it('applies local filters inside MINUS anti-joins', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    engine.put([
      quad(msg2, namedNode(SIOC_CONTENT), literal('second'), graph),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
      ],
      minus: [
        {
          patterns: [
            {
              subject: rdfVar('message'),
              predicate: namedNode(SIOC_CONTENT),
              object: rdfVar('content'),
            },
          ],
          filters: [
            {
              variable: 'content',
              operator: '$contains',
              value: 'hell',
            },
          ],
        },
      ],
      select: ['message'],
    });

    expect(result.bindings).toEqual([
      {
        message: msg2,
      },
    ]);
    expect(result.metrics.plan).toContain('MinusFilter(?content$contains)');
  });

  it('applies controlled FILTER EXISTS semi-joins after required bindings', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
      ],
      exists: [
        {
          patterns: [
            {
              subject: rdfVar('message'),
              predicate: namedNode(SIOC_CONTENT),
              object: rdfVar('content'),
            },
          ],
        },
      ],
      select: ['message'],
    });

    expect(result.bindings).toEqual([
      {
        message: namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
      },
    ]);
    expect(result.metrics.plan).toContain('Exists(subject:?message,predicate:http://rdfs.org/sioc/ns#content,object:?content)');
  });

  it('applies local filters inside FILTER EXISTS semi-joins', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    engine.put([
      quad(msg2, namedNode(SIOC_CONTENT), literal('second'), graph),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
      ],
      exists: [
        {
          patterns: [
            {
              subject: rdfVar('message'),
              predicate: namedNode(SIOC_CONTENT),
              object: rdfVar('content'),
            },
          ],
          filters: [
            {
              variable: 'content',
              operator: '$contains',
              value: 'sec',
            },
          ],
        },
      ],
      select: ['message'],
    });

    expect(result.bindings).toEqual([
      {
        message: msg2,
      },
    ]);
    expect(result.metrics.plan).toContain('ExistsFilter(?content$contains)');
  });

  it('does not push ORDER and LIMIT before a later UNION join', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
      ],
      unions: [
        {
          branches: [
            {
              patterns: [
                {
                  subject: rdfVar('message'),
                  predicate: namedNode(SIOC_CONTENT),
                  object: rdfVar('value'),
                },
              ],
            },
            {
              patterns: [
                {
                  subject: rdfVar('message'),
                  predicate: namedNode(SIOC_HAS_MEMBER),
                  object: rdfVar('value'),
                },
              ],
            },
          ],
        },
      ],
      select: ['message', 'value'],
      orderBy: [{ variable: 'message' }, { variable: 'value' }],
      limit: 2,
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      value: binding.value.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'hello',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
    ]);
    expect(result.metrics.plan).toContain('Sort');
    expect(result.metrics.plan).toContain('Limit');
    expect(result.metrics.plan).not.toContain('IndexLimit');
  });

  it('pushes single-pattern ORDER and LIMIT into the term-id scan', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(DCT_CREATED),
          object: rdfVar('createdAt'),
        },
      ],
      select: ['message', 'createdAt'],
      orderBy: [{ variable: 'createdAt', direction: 'desc' }],
      limit: 1,
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      createdAt: binding.createdAt.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        createdAt: '2026-05-18T00:00:02.000Z',
      },
    ]);
    expect(result.metrics.plan).toContain('IndexOrder(desc:object)');
    expect(result.metrics.plan).toContain('IndexLimit');
    expect(result.metrics.plan).not.toContain('Sort');
    expect(result.metrics.plan).not.toContain('Limit');
    expect(result.metrics.returnedRows).toBe(1);
    expect(result.metrics.joinedRows).toBe(2);
  });

  it('pushes same-direction multi-variable ORDER and LIMIT into the term-id scan', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const msg0 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_0');
    engine.put([
      quad(msg0, namedNode(DCT_CREATED), literal('2026-05-18T00:00:02.000Z'), graph),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(DCT_CREATED),
          object: rdfVar('createdAt'),
        },
      ],
      select: ['message', 'createdAt'],
      orderBy: [
        { variable: 'createdAt', direction: 'asc' },
        { variable: 'message', direction: 'asc' },
      ],
      limit: 2,
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      createdAt: binding.createdAt.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        createdAt: '2026-05-18T00:00:01.000Z',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_0',
        createdAt: '2026-05-18T00:00:02.000Z',
      },
    ]);
    expect(result.metrics.plan).toContain('IndexOrder(asc:object,subject)');
    expect(result.metrics.plan).toContain('IndexLimit');
    expect(result.metrics.plan).not.toContain('Sort');
    expect(result.metrics.plan).not.toContain('Limit');
  });

  it('pushes mixed-direction multi-variable ORDER and LIMIT into the term-id scan', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const msg0 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_0');
    engine.put([
      quad(msg0, namedNode(DCT_CREATED), literal('2026-05-18T00:00:02.000Z'), graph),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(DCT_CREATED),
          object: rdfVar('createdAt'),
        },
      ],
      select: ['message', 'createdAt'],
      orderBy: [
        { variable: 'createdAt', direction: 'desc' },
        { variable: 'message', direction: 'asc' },
      ],
      limit: 2,
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      createdAt: binding.createdAt.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_0',
        createdAt: '2026-05-18T00:00:02.000Z',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        createdAt: '2026-05-18T00:00:02.000Z',
      },
    ]);
    expect(result.metrics.plan).toContain('IndexOrder(desc:object,asc:subject)');
    expect(result.metrics.plan).toContain('IndexLimit');
    expect(result.metrics.plan).not.toContain('Sort');
    expect(result.metrics.plan).not.toContain('Limit');
  });

  it('sorts on binds introduced for ORDER BY expressions', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    engine.put([
      quad(msg1, namedNode(SIOC_CONTENT), literal('hello'), graph),
      quad(msg2, namedNode(SIOC_CONTENT), literal('second'), graph),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
      ],
      binds: [
        {
          variable: 'contentLexical',
          expression: {
            type: 'stringValue',
            variable: 'content',
          },
        },
      ],
      select: ['message', 'content'],
      orderBy: [{ variable: 'contentLexical' }],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      content: binding.content.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        content: 'hello',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        content: 'second',
      },
    ]);
    expect(result.metrics.plan).toContain('Bind(?contentLexical:=STR(?content))');
    expect(result.metrics.plan).toContain('Sort');
  });

  it('does not push LIMIT ahead of non-pushdown filters', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(DCT_CREATED),
          object: rdfVar('createdAt'),
        },
      ],
      filters: [
        {
          variable: 'createdAt',
          operator: '$regex',
          value: '01\\.000Z$',
          flags: 'i',
        },
      ],
      select: ['message', 'createdAt'],
      orderBy: [{ variable: 'createdAt', direction: 'desc' }],
      limit: 1,
    });

    expect(result.bindings.map((binding) => binding.createdAt.value)).toEqual([
      '2026-05-18T00:00:01.000Z',
    ]);
    expect(result.metrics.plan).toContain('IndexOrder(desc:object)');
    expect(result.metrics.plan).not.toContain('IndexLimit');
    expect(result.metrics.plan).toContain('Limit');
  });

  it('orders by an unprojected variable before projection', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(DCT_CREATED),
          object: rdfVar('createdAt'),
        },
      ],
      select: ['message'],
      orderBy: [{ variable: 'createdAt', direction: 'desc' }],
      limit: 1,
    });

    expect(result.bindings).toEqual([
      {
        message: namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
      },
    ]);
    expect(result.metrics.plan).toContain('IndexOrder(desc:object)');
  });

  it('chooses the most selective connected BGP scan with index cardinality estimates', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const selected = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#selected');
    const thread = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_selective');

    engine.put([
      quad(selected, namedNode(RDF_TYPE), namedNode(MEETING_MESSAGE), graph),
      quad(selected, namedNode(SIOC_HAS_MEMBER), thread, graph),
      quad(selected, namedNode(SIOC_CONTENT), literal('planner target'), graph),
      ...Array.from({ length: 12 }, (_, index) => quad(
        namedNode(`https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#noise_${index}`),
        namedNode(RDF_TYPE),
        namedNode(MEETING_MESSAGE),
        graph,
      )),
    ]);

    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: literal('planner target'),
        },
      ],
      filters: [
        {
          variable: 'thread',
          operator: '$bound',
          value: true,
        },
      ],
      select: ['message', 'thread'],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      thread: termToId(binding.thread as any),
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#selected',
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_selective',
      },
    ]);
    expect(result.metrics.plan[0]).toContain(`predicate:${SIOC_CONTENT},object:"planner target"`);
    expect(result.metrics.scannedRows).toBeLessThan(10);
    expect(result.metrics.cardinalityEstimates).toBeGreaterThan(0);
    const countSpy = vi.spyOn(index, 'count');
    engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(RDF_TYPE),
          object: namedNode(MEETING_MESSAGE),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: literal('planner target'),
        },
      ],
      filters: [
        {
          variable: 'thread',
          operator: '$bound',
          value: true,
        },
      ],
      select: ['message', 'thread'],
    });
    expect(countSpy).not.toHaveBeenCalled();
    countSpy.mockRestore();
  });

  it('deduplicates repeated bound patterns while estimating connected join cardinality', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const messageA = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#a');
    const messageB = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#b');
    const thread = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread');

    engine.put([
      quad(messageA, namedNode(RDF_TYPE), namedNode(MEETING_MESSAGE), graph),
      quad(messageB, namedNode(RDF_TYPE), namedNode(MEETING_MESSAGE), graph),
      quad(messageA, namedNode(SIOC_HAS_MEMBER), thread, graph),
      quad(messageB, namedNode(SIOC_HAS_MEMBER), thread, graph),
      quad(messageA, namedNode(SIOC_CONTENT), literal('same binding'), graph),
      quad(messageB, namedNode(SIOC_CONTENT), literal('same binding'), graph),
      quad(thread, namedNode(RDF_TYPE), namedNode(SIOC_THREAD), graph),
      ...Array.from({ length: 4 }, (_, index) => quad(
        namedNode(`https://pod.example/alice/.data/chat/default/index.ttl#noise_thread_${index}`),
        namedNode(RDF_TYPE),
        namedNode(SIOC_THREAD),
        graph,
      )),
    ]);

    const estimateSpy = vi.spyOn(index, 'estimateCardinality');
    const distinctSpy = vi.spyOn(index, 'countDistinct');
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: literal('same binding'),
        },
        {
          subject: rdfVar('thread'),
          predicate: namedNode(RDF_TYPE),
          object: rdfVar('threadType'),
        },
      ],
      filters: [
        {
          variable: 'threadType',
          operator: '$bound',
          value: true,
        },
      ],
      select: ['message', 'thread'],
    });

    expect(result.bindings.map((binding) => termToId(binding.thread as any))).toEqual([thread.value, thread.value]);
    expect(result.metrics.distinctCardinalityEstimates).toBeLessThan(result.metrics.cardinalityEstimates ?? 0);
    expect(distinctSpy.mock.calls.some(([_pattern, distinctKey]) => distinctKey === 'subject')).toBe(true);
    const repeatedThreadEstimateCalls = estimateSpy.mock.calls.filter(([pattern]) => (
      pattern.subject && isTerm(pattern.subject as any) && termToId(pattern.subject as any) === thread.value
    ));
    expect(repeatedThreadEstimateCalls).toHaveLength(0);
    distinctSpy.mockRestore();
    estimateSpy.mockRestore();
  });

  it('uses multi-slot distinct fanout for connected pattern estimates', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const msgA = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#tuple_a');
    const msgB = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#tuple_b');
    const threadA = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#tuple_thread_a');
    const threadB = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#tuple_thread_b');
    const ownerA = namedNode('https://pod.example/alice/profile/card#owner_a');
    const ownerB = namedNode('https://pod.example/alice/profile/card#owner_b');
    const assigned = namedNode('https://undefineds.co/ns#assignedTo');
    const reviewedBy = namedNode('https://undefineds.co/ns#reviewedBy');

    engine.put([
      quad(msgA, namedNode(SIOC_HAS_MEMBER), threadA, graph),
      quad(msgB, namedNode(SIOC_HAS_MEMBER), threadB, graph),
      quad(msgA, assigned, ownerA, graph),
      quad(msgB, assigned, ownerB, graph),
      quad(threadA, assigned, ownerA, graph),
      quad(threadB, assigned, ownerB, graph),
      quad(threadA, reviewedBy, ownerA, graph),
      quad(threadA, reviewedBy, ownerB, graph),
      quad(threadB, reviewedBy, ownerB, graph),
    ]);

    const estimateSpy = vi.spyOn(index, 'estimateCardinality');
    const distinctTupleSpy = vi.spyOn(index, 'countDistinctTuple');
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: rdfVar('thread'),
        },
        {
          subject: rdfVar('message'),
          predicate: assigned,
          object: rdfVar('owner'),
        },
        {
          subject: rdfVar('thread'),
          predicate: reviewedBy,
          object: rdfVar('owner'),
        },
      ],
      filters: [
        {
          variable: 'thread',
          operator: '$bound',
          value: true,
        },
      ],
      select: ['message', 'thread', 'owner'],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      thread: termToId(binding.thread as any),
      owner: termToId(binding.owner as any),
    }))).toEqual([
      {
        message: msgA.value,
        thread: threadA.value,
        owner: ownerA.value,
      },
      {
        message: msgB.value,
        thread: threadB.value,
        owner: ownerB.value,
      },
    ]);
    expect(distinctTupleSpy.mock.calls.some(([_pattern, keys]) => (
      keys.includes('subject') && keys.includes('object')
    ))).toBe(true);
    const perBindingReviewEstimateCalls = estimateSpy.mock.calls.filter(([pattern]) => (
      pattern.subject
        && isTerm(pattern.subject as any)
        && (termToId(pattern.subject as any) === threadA.value || termToId(pattern.subject as any) === threadB.value)
        && pattern.object
        && isTerm(pattern.object as any)
        && (termToId(pattern.object as any) === ownerA.value || termToId(pattern.object as any) === ownerB.value)
    ));
    expect(perBindingReviewEstimateCalls).toHaveLength(0);
    distinctTupleSpy.mockRestore();
    estimateSpy.mockRestore();
  });

  it('pushes string filters into literal text scans while still applying bound filters after joins', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
      ],
      filters: [
        {
          variable: 'content',
          operator: '$contains',
          value: 'ell',
        },
        {
          variable: 'content',
          operator: '$bound',
          value: true,
        },
      ],
      select: ['message', 'content'],
    });

    expect(result.bindings.map((binding) => ({
      message: termToId(binding.message as any),
      content: binding.content.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        content: 'hello',
      },
    ]);
    expect(result.metrics.filtersPushedDown).toBe(1);
    expect(result.metrics.plan).toContain('TextSearch(object$contains)');
    expect(result.metrics.plan).toContain('Filter(?content$bound)');
    expect(result.metrics.plan).not.toContain('Filter(?content$contains,?content$bound)');
  });

  it('does not push regex filters with flags because the normalized text index cannot preserve flag semantics', () => {
    const result = engine.query({
      patterns: [
        {
          subject: rdfVar('message'),
          predicate: namedNode(SIOC_CONTENT),
          object: rdfVar('content'),
        },
      ],
      filters: [
        {
          variable: 'content',
          operator: '$regex',
          value: '^HEL',
          flags: 'i',
        },
      ],
      select: ['message', 'content'],
    });

    expect(result.bindings.map((binding) => binding.content.value)).toEqual(['hello']);
    expect(result.metrics.filtersPushedDown).toBe(0);
    expect(result.metrics.plan).toContain('Filter(?content$regex)');
  });

  it('joins file text-search hits with RDF graph bindings', async () => {
    const textEngine = new SolidRdfEngine({
      index: { path: ':memory:' },
      textIndex: { path: ':memory:' },
      autoOpen: true,
    });
    const source = namedNode('https://pod.example/alice/projects/demo/runbook.md');
    const docType = namedNode('https://schema.org/DigitalDocument');

    try {
      textEngine.put([
        quad(source, namedNode(RDF_TYPE), docType, source),
        quad(source, namedNode('https://schema.org/name'), literal('Runbook'), source),
      ]);
      textEngine.indexTextSource({
        source: source.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'runbook.md',
        contentType: 'text/markdown',
      }, '# Runbook\n\nManaged runtime handoff.\n');

      const result = textEngine.query({
        textSearch: [
          {
            query: 'managed runtime',
            scope: { workspace: 'https://pod.example/alice/projects/demo/' },
            source: 'source',
            chunk: 'chunk',
            content: 'snippet',
            heading: 'heading',
            score: 'score',
          },
        ],
        patterns: [
          {
            graph: rdfVar('source'),
            subject: rdfVar('source'),
            predicate: namedNode(RDF_TYPE),
            object: rdfVar('type'),
          },
        ],
        select: ['source', 'type', 'chunk', 'snippet', 'heading', 'score'],
      });

      expect(result.bindings).toHaveLength(1);
      expect(termToId(result.bindings[0].source as any)).toBe(source.value);
      expect(termToId(result.bindings[0].type as any)).toBe(docType.value);
      expect(termToId(result.bindings[0].chunk as any)).toContain(`${source.value}#chunk-`);
      expect(result.bindings[0].snippet.value).toContain('Managed runtime');
      expect(result.bindings[0].heading.value).toBe('Runbook');
      expect(result.bindings[0].score.value).toBe('1');
      expect(result.metrics.plan.some((entry) => entry.startsWith('TextSearch('))).toBe(true);
      expect(result.metrics.plan).toContain(`IndexScan(graph:?source,subject:?source,predicate:${RDF_TYPE},object:?type)`);
    } finally {
      await textEngine.close();
    }
  });

  it('orders selective RDF scans before broad text-search binding sources', async () => {
    const textEngine = new SolidRdfEngine({
      index: { path: ':memory:' },
      textIndex: { path: ':memory:' },
      autoOpen: true,
    });
    const selected = namedNode('https://pod.example/alice/projects/demo/selected.md');
    const unrelated = namedNode('https://pod.example/alice/projects/demo/unrelated.md');
    const docType = namedNode('https://schema.org/DigitalDocument');

    try {
      textEngine.put([
        quad(selected, namedNode(RDF_TYPE), docType, selected),
        quad(selected, namedNode('https://schema.org/name'), literal('Selected'), selected),
      ]);
      textEngine.indexTextSource({
        source: selected.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'selected.md',
        contentType: 'text/markdown',
      }, '# Selected\n\nManaged runtime handoff.\n');
      textEngine.indexTextSource({
        source: unrelated.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'unrelated.md',
        contentType: 'text/markdown',
      }, '# Unrelated\n\nManaged runtime handoff.\n');

      const result = textEngine.query({
        textSearch: [
          {
            query: 'managed runtime',
            scope: { workspace: 'https://pod.example/alice/projects/demo/' },
            source: 'source',
            content: 'snippet',
          },
        ],
        patterns: [
          {
            graph: selected,
            subject: rdfVar('source'),
            predicate: namedNode(RDF_TYPE),
            object: docType,
          },
        ],
        select: ['source', 'snippet'],
      });

      expect(result.bindings).toHaveLength(1);
      expect(termToId(result.bindings[0].source as any)).toBe(selected.value);
      const indexPlan = result.metrics.plan.findIndex((entry) => entry.startsWith('IndexScan('));
      const textPlan = result.metrics.plan.findIndex((entry) => entry.startsWith('TextSearch('));
      expect(indexPlan).toBeGreaterThanOrEqual(0);
      expect(textPlan).toBeGreaterThan(indexPlan);
      expect(result.metrics.searchCardinalityEstimates).toBeGreaterThan(0);
      expect(result.metrics.scannedRows).toBe(2);
    } finally {
      await textEngine.close();
    }
  });

  it('applies textSearch limit as a source-local top-K window before RDF joins', async () => {
    const textEngine = new SolidRdfEngine({
      index: { path: ':memory:' },
      textIndex: { path: ':memory:' },
      autoOpen: true,
    });
    const highScore = namedNode('https://pod.example/alice/projects/demo/high-score.md');
    const selected = namedNode('https://pod.example/alice/projects/demo/selected-low-score.md');
    const docType = namedNode('https://schema.org/DigitalDocument');
    const selectedType = namedNode('https://schema.org/SelectedDocument');

    try {
      textEngine.put([
        quad(selected, namedNode(RDF_TYPE), selectedType, selected),
      ]);
      textEngine.indexTextSource({
        source: highScore.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'high-score.md',
        contentType: 'text/markdown',
      }, '# High\n\nManaged runtime managed runtime.\n');
      textEngine.indexTextSource({
        source: selected.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'selected-low-score.md',
        contentType: 'text/markdown',
      }, '# Selected\n\nManaged runtime.\n');

      const sourceWindow = textEngine.query({
        textSearch: [
          {
            query: 'managed runtime',
            scope: { workspace: 'https://pod.example/alice/projects/demo/' },
            source: 'source',
            content: 'snippet',
            limit: 1,
          },
        ],
        patterns: [
          {
            graph: rdfVar('source'),
            subject: rdfVar('source'),
            predicate: namedNode(RDF_TYPE),
            object: selectedType,
          },
        ],
        select: ['source', 'snippet'],
      });

      expect(sourceWindow.bindings).toEqual([]);
      expect(sourceWindow.metrics.plan).toContain('TextSearch("managed runtime"@workspace:https://pod.example/alice/projects/demo/ source:?source,content:?snippet limit:1)');

      textEngine.put([
        quad(highScore, namedNode(RDF_TYPE), docType, highScore),
      ]);
      const joinedWindow = textEngine.query({
        textSearch: [
          {
            query: 'managed runtime',
            scope: { workspace: 'https://pod.example/alice/projects/demo/' },
            source: 'source',
            content: 'snippet',
          },
        ],
        patterns: [
          {
            graph: rdfVar('source'),
            subject: rdfVar('source'),
            predicate: namedNode(RDF_TYPE),
            object: rdfVar('type'),
          },
        ],
        select: ['source', 'snippet'],
        orderBy: [{ variable: 'source' }],
        limit: 1,
      });

      expect(joinedWindow.bindings).toHaveLength(1);
      expect(termToId(joinedWindow.bindings[0].source as any)).toBe(highScore.value);
      expect(joinedWindow.metrics.plan).toContain('Limit');
      expect(joinedWindow.metrics.plan.some((entry) => entry.includes('limit:1'))).toBe(false);
    } finally {
      await textEngine.close();
    }
  });

  it('applies textSearch explicit ordering before the source-local window', async () => {
    const textEngine = new SolidRdfEngine({
      index: { path: ':memory:' },
      textIndex: { path: ':memory:' },
      autoOpen: true,
    });
    const highScore = namedNode('https://pod.example/alice/projects/demo/high-score.md');
    const selected = namedNode('https://pod.example/alice/projects/demo/selected-low-score.md');
    const docType = namedNode('https://schema.org/DigitalDocument');

    try {
      textEngine.put([
        quad(highScore, namedNode(RDF_TYPE), docType, highScore),
        quad(selected, namedNode(RDF_TYPE), docType, selected),
      ]);
      textEngine.indexTextSource({
        source: highScore.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'high-score.md',
        contentType: 'text/markdown',
      }, '# High\n\nManaged runtime managed runtime.\n');
      textEngine.indexTextSource({
        source: selected.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'selected-low-score.md',
        contentType: 'text/markdown',
      }, '# Selected\n\nManaged runtime.\n');

      const result = textEngine.query({
        textSearch: [
          {
            query: 'managed runtime',
            scope: { workspace: 'https://pod.example/alice/projects/demo/' },
            source: 'source',
            content: 'snippet',
            orderBy: [{ field: 'source', direction: 'desc' }],
            limit: 1,
          },
        ],
        patterns: [
          {
            graph: rdfVar('source'),
            subject: rdfVar('source'),
            predicate: namedNode(RDF_TYPE),
            object: docType,
          },
        ],
        select: ['source', 'snippet'],
      });

      expect(result.bindings).toHaveLength(1);
      expect(termToId(result.bindings[0].source as any)).toBe(selected.value);
      expect(result.metrics.plan).toContain('TextSearch("managed runtime"@workspace:https://pod.example/alice/projects/demo/ source:?source,content:?snippet limit:1 order:source:desc)');
    } finally {
      await textEngine.close();
    }
  });

  it('fails explicitly when a textSearch query runs without a text index', () => {
    expect(() => engine.query({
      textSearch: [
        {
          query: 'managed runtime',
          source: 'source',
        },
      ],
      patterns: [],
    })).toThrow('RdfLocalQuery textSearch requires a configured RdfTextIndex');
  });

  it('joins vector-search hits with RDF graph bindings', async () => {
    const vectorEngine = new SolidRdfEngine({
      index: { path: ':memory:' },
      vectorIndex: { path: ':memory:' },
      autoOpen: true,
    });
    const source = namedNode('https://pod.example/alice/projects/demo/design.md');
    const docType = namedNode('https://schema.org/DigitalDocument');

    try {
      vectorEngine.put([
        quad(source, namedNode(RDF_TYPE), docType, source),
        quad(source, namedNode('https://schema.org/name'), literal('Design Notes'), source),
      ]);
      vectorEngine.indexVectorSource({
        source: source.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'design.md',
        contentType: 'text/markdown',
      }, [
        {
          chunkKey: 'overview',
          ordinal: 0,
          level: 1,
          heading: 'Overview',
          path: ['Overview'],
          content: 'Managed runtime orchestration notes.',
          startOffset: 0,
          endOffset: 36,
          embedding: [1, 0, 0],
          model: 'test-embed',
        },
      ]);

      const result = vectorEngine.query({
        vectorSearch: [
          {
            embedding: [0.95, 0.05, 0],
            vectorModel: 'test-embed',
            scope: { workspace: 'https://pod.example/alice/projects/demo/' },
            source: 'source',
            chunk: 'chunk',
            content: 'snippet',
            heading: 'heading',
            score: 'score',
            distance: 'distance',
            model: 'model',
          },
        ],
        patterns: [
          {
            graph: rdfVar('source'),
            subject: rdfVar('source'),
            predicate: namedNode(RDF_TYPE),
            object: rdfVar('type'),
          },
        ],
        select: ['source', 'type', 'chunk', 'snippet', 'heading', 'score', 'distance', 'model'],
      });

      expect(result.bindings).toHaveLength(1);
      expect(termToId(result.bindings[0].source as any)).toBe(source.value);
      expect(termToId(result.bindings[0].type as any)).toBe(docType.value);
      expect(termToId(result.bindings[0].chunk as any)).toBe(`${source.value}#chunk-overview`);
      expect(result.bindings[0].snippet.value).toContain('Managed runtime');
      expect(result.bindings[0].heading.value).toBe('Overview');
      expect(result.bindings[0].score.value).toMatch(/^0\./);
      expect(result.bindings[0].distance.value).toMatch(/^0\./);
      expect(result.bindings[0].model.value).toBe('test-embed');
      expect(result.metrics.plan.some((entry) => entry.startsWith('VectorSearch('))).toBe(true);
      expect(result.metrics.indexChoices).toContain('vector-chunk');
      expect(result.metrics.plan).toContain(`IndexScan(graph:?source,subject:?source,predicate:${RDF_TYPE},object:?type)`);
    } finally {
      await vectorEngine.close();
    }
  });

  it('orders selective RDF scans before broad vector-search binding sources', async () => {
    const vectorEngine = new SolidRdfEngine({
      index: { path: ':memory:' },
      vectorIndex: { path: ':memory:' },
      autoOpen: true,
    });
    const selected = namedNode('https://pod.example/alice/projects/demo/selected-vector.md');
    const unrelated = namedNode('https://pod.example/alice/projects/demo/unrelated-vector.md');
    const docType = namedNode('https://schema.org/DigitalDocument');

    try {
      vectorEngine.put([
        quad(selected, namedNode(RDF_TYPE), docType, selected),
        quad(selected, namedNode('https://schema.org/name'), literal('Selected Vector'), selected),
      ]);
      vectorEngine.indexVectorSource({
        source: selected.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'selected-vector.md',
        contentType: 'text/markdown',
      }, [
        {
          chunkKey: 'selected',
          ordinal: 0,
          level: 1,
          content: 'Managed runtime orchestration notes.',
          startOffset: 0,
          endOffset: 36,
          embedding: [1, 0],
          model: 'test-embed',
        },
      ]);
      vectorEngine.indexVectorSource({
        source: unrelated.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'unrelated-vector.md',
        contentType: 'text/markdown',
      }, [
        {
          chunkKey: 'unrelated',
          ordinal: 0,
          level: 1,
          content: 'Managed runtime orchestration notes.',
          startOffset: 0,
          endOffset: 36,
          embedding: [1, 0],
          model: 'test-embed',
        },
      ]);

      const result = vectorEngine.query({
        vectorSearch: [
          {
            embedding: [1, 0],
            vectorModel: 'test-embed',
            scope: { workspace: 'https://pod.example/alice/projects/demo/' },
            source: 'source',
            content: 'snippet',
          },
        ],
        patterns: [
          {
            graph: selected,
            subject: rdfVar('source'),
            predicate: namedNode(RDF_TYPE),
            object: docType,
          },
        ],
        select: ['source', 'snippet'],
      });

      expect(result.bindings).toHaveLength(1);
      expect(termToId(result.bindings[0].source as any)).toBe(selected.value);
      const indexPlan = result.metrics.plan.findIndex((entry) => entry.startsWith('IndexScan('));
      const vectorPlan = result.metrics.plan.findIndex((entry) => entry.startsWith('VectorSearch('));
      expect(indexPlan).toBeGreaterThanOrEqual(0);
      expect(vectorPlan).toBeGreaterThan(indexPlan);
      expect(result.metrics.searchCardinalityEstimates).toBeGreaterThan(0);
      expect(result.metrics.scannedRows).toBe(2);
    } finally {
      await vectorEngine.close();
    }
  });

  it('applies vectorSearch limit as a source-local top-K window before RDF joins', async () => {
    const vectorEngine = new SolidRdfEngine({
      index: { path: ':memory:' },
      vectorIndex: { path: ':memory:' },
      autoOpen: true,
    });
    const highScore = namedNode('https://pod.example/alice/projects/demo/high-vector.md');
    const selected = namedNode('https://pod.example/alice/projects/demo/selected-vector-low.md');
    const docType = namedNode('https://schema.org/DigitalDocument');
    const selectedType = namedNode('https://schema.org/SelectedDocument');

    try {
      vectorEngine.put([
        quad(selected, namedNode(RDF_TYPE), selectedType, selected),
      ]);
      vectorEngine.indexVectorSource({
        source: highScore.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'high-vector.md',
        contentType: 'text/markdown',
      }, [
        {
          chunkKey: 'high',
          ordinal: 0,
          level: 1,
          content: 'Managed runtime high score.',
          startOffset: 0,
          endOffset: 27,
          embedding: [1, 0],
          model: 'test-embed',
        },
      ]);
      vectorEngine.indexVectorSource({
        source: selected.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'selected-vector-low.md',
        contentType: 'text/markdown',
      }, [
        {
          chunkKey: 'selected',
          ordinal: 0,
          level: 1,
          content: 'Managed runtime lower score.',
          startOffset: 0,
          endOffset: 28,
          embedding: [0.5, 0.5],
          model: 'test-embed',
        },
      ]);

      const sourceWindow = vectorEngine.query({
        vectorSearch: [
          {
            embedding: [1, 0],
            vectorModel: 'test-embed',
            scope: { workspace: 'https://pod.example/alice/projects/demo/' },
            source: 'source',
            content: 'snippet',
            limit: 1,
          },
        ],
        patterns: [
          {
            graph: rdfVar('source'),
            subject: rdfVar('source'),
            predicate: namedNode(RDF_TYPE),
            object: selectedType,
          },
        ],
        select: ['source', 'snippet'],
      });

      expect(sourceWindow.bindings).toEqual([]);
      expect(sourceWindow.metrics.plan).toContain('VectorSearch(cosine:2d@workspace:https://pod.example/alice/projects/demo/ source:?source,content:?snippet limit:1)');

      vectorEngine.put([
        quad(highScore, namedNode(RDF_TYPE), docType, highScore),
      ]);
      const joinedWindow = vectorEngine.query({
        vectorSearch: [
          {
            embedding: [1, 0],
            vectorModel: 'test-embed',
            scope: { workspace: 'https://pod.example/alice/projects/demo/' },
            source: 'source',
            content: 'snippet',
          },
        ],
        patterns: [
          {
            graph: rdfVar('source'),
            subject: rdfVar('source'),
            predicate: namedNode(RDF_TYPE),
            object: rdfVar('type'),
          },
        ],
        select: ['source', 'snippet'],
        orderBy: [{ variable: 'source' }],
        limit: 1,
      });

      expect(joinedWindow.bindings).toHaveLength(1);
      expect(termToId(joinedWindow.bindings[0].source as any)).toBe(highScore.value);
      expect(joinedWindow.metrics.plan).toContain('Limit');
      expect(joinedWindow.metrics.plan.some((entry) => entry.includes('limit:1'))).toBe(false);
    } finally {
      await vectorEngine.close();
    }
  });

  it('applies vectorSearch explicit ordering before the source-local window', async () => {
    const vectorEngine = new SolidRdfEngine({
      index: { path: ':memory:' },
      vectorIndex: { path: ':memory:' },
      autoOpen: true,
    });
    const source = namedNode('https://pod.example/alice/projects/demo/vector-order.md');
    const docType = namedNode('https://schema.org/DigitalDocument');

    try {
      vectorEngine.put([
        quad(source, namedNode(RDF_TYPE), docType, source),
      ]);
      vectorEngine.indexVectorSource({
        source: source.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'vector-order.md',
        contentType: 'text/markdown',
      }, [
        {
          chunkKey: 'far-first',
          ordinal: 0,
          level: 1,
          content: 'Far first.',
          startOffset: 0,
          endOffset: 10,
          embedding: [0, 1],
          model: 'test-embed',
        },
        {
          chunkKey: 'near-second',
          ordinal: 1,
          level: 1,
          content: 'Near second.',
          startOffset: 11,
          endOffset: 23,
          embedding: [1, 0],
          model: 'test-embed',
        },
      ]);

      const result = vectorEngine.query({
        vectorSearch: [
          {
            embedding: [1, 0],
            vectorModel: 'test-embed',
            scope: { workspace: 'https://pod.example/alice/projects/demo/' },
            source: 'source',
            chunk: 'chunk',
            content: 'snippet',
            orderBy: [{ field: 'ordinal' }],
            limit: 1,
          },
        ],
        patterns: [
          {
            graph: rdfVar('source'),
            subject: rdfVar('source'),
            predicate: namedNode(RDF_TYPE),
            object: docType,
          },
        ],
        select: ['chunk', 'snippet'],
      });

      expect(result.bindings).toHaveLength(1);
      expect(termToId(result.bindings[0].chunk as any)).toBe(`${source.value}#chunk-far-first`);
      expect(result.metrics.plan).toContain('VectorSearch(cosine:2d@workspace:https://pod.example/alice/projects/demo/ source:?source,chunk:?chunk,content:?snippet limit:1 order:ordinal:asc)');
    } finally {
      await vectorEngine.close();
    }
  });

  it('fails explicitly when a vectorSearch query runs without a vector index', () => {
    expect(() => engine.query({
      vectorSearch: [
        {
          embedding: [1, 0],
          source: 'source',
        },
      ],
      patterns: [],
    })).toThrow('RdfLocalQuery vectorSearch requires a configured RdfVectorIndex');
  });
});
