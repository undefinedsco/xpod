import { describe, expect, it } from 'vitest';
import { Parser, Wildcard } from 'sparqljs';
import { DataFactory, termToId } from 'n3';
import {
  DisabledSparqlFeatureError,
  RdfSparqlAdapter,
  UnsupportedSparqlQueryError,
} from '../../../src/storage/rdf';

const BASE = 'https://pod.example/alice/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const MESSAGE = 'http://www.w3.org/ns/pim/meeting#Message';
const CONTENT = 'http://rdfs.org/sioc/ns#content';
const HAS_MEMBER = 'http://rdfs.org/sioc/ns#has_member';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const { namedNode, literal } = DataFactory;

describe('RdfSparqlAdapter', () => {
  const adapter = new RdfSparqlAdapter();

  it('compiles SELECT BGP, filters, ordering, and pagination into local query shape', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
        FILTER(CONTAINS(STR(?content), "ell"))
      }
      ORDER BY ?message
      LIMIT 10
      OFFSET 2
    `, BASE);

    expect(compiled.queryType).toBe('SELECT');
    expect(compiled.variables).toEqual(['message', 'content']);
    expect(compiled.query.patterns).toHaveLength(1);
    expect(compiled.query.patterns[0]).toMatchObject({
      graph: { $startsWith: BASE },
      subject: { variable: 'message' },
      object: { variable: 'content' },
    });
    expect(termToId(compiled.query.patterns[0].predicate as any)).toBe(CONTENT);
    expect(compiled.query.filters).toEqual([
      {
        variable: 'content',
        operator: '$contains',
        operand: 'stringValue',
        value: 'ell',
        flags: undefined,
      },
    ]);
    expect(compiled.query.orderBy).toEqual([{ variable: 'message', direction: 'asc' }]);
    expect(compiled.query.limit).toBe(10);
    expect(compiled.query.offset).toBe(2);
  });

  it('compiles implicit default graph reads as exact graph scope for resource base paths', () => {
    const graph = `${BASE}.data/chat/default/index.ttl`;
    const compiled = adapter.compile(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
      }
    `, graph);

    expect(compiled.query.patterns).toEqual([
      expect.objectContaining({
        graph: expect.objectContaining({
          termType: 'NamedNode',
          value: graph,
        }),
        subject: { variable: 'message' },
        object: { variable: 'content' },
      }),
    ]);
  });

  it('compiles standard XPath function-call string filters into local query shape', () => {
    const compiled = adapter.compile(`
      PREFIX fn: <http://www.w3.org/2005/xpath-functions#>
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
        FILTER(fn:contains(STR(?content), "ell"))
        FILTER(fn:starts-with(STR(?content), "he"))
        FILTER(fn:ends-with(STR(?content), "lo"))
        FILTER(fn:matches(STR(?content), "^h"))
      }
    `, BASE);

    expect(compiled.query.filters).toEqual([
      {
        variable: 'content',
        operator: '$contains',
        operand: 'stringValue',
        value: 'ell',
        flags: undefined,
      },
      {
        variable: 'content',
        operator: '$startsWith',
        operand: 'stringValue',
        value: 'he',
        flags: undefined,
      },
      {
        variable: 'content',
        operator: '$endsWith',
        operand: 'stringValue',
        value: 'lo',
        flags: undefined,
      },
      {
        variable: 'content',
        operator: '$regex',
        operand: 'stringValue',
        value: '^h',
        flags: undefined,
      },
    ]);
  });

  it('compiles safely negated string filters into local post-filters', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
        FILTER(!CONTAINS(STR(?content), "skip"))
        FILTER(!STRSTARTS(STR(?content), "draft"))
        FILTER(!STRENDS(STR(?content), "tmp"))
        FILTER(!REGEX(STR(?content), "^old", "i"))
      }
    `, BASE);

    expect(compiled.query.filters).toEqual([
      {
        variable: 'content',
        operator: '$notContains',
        operand: 'stringValue',
        value: 'skip',
        flags: undefined,
      },
      {
        variable: 'content',
        operator: '$notStartsWith',
        operand: 'stringValue',
        value: 'draft',
        flags: undefined,
      },
      {
        variable: 'content',
        operator: '$notEndsWith',
        operand: 'stringValue',
        value: 'tmp',
        flags: undefined,
      },
      {
        variable: 'content',
        operator: '$notRegex',
        operand: 'stringValue',
        value: '^old',
        flags: 'i',
      },
    ]);
  });

  it('compiles standard XPath string-length filters as explicit local post-filters', () => {
    const compiled = adapter.compile(`
      PREFIX fn: <http://www.w3.org/2005/xpath-functions#>
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
        FILTER(fn:string-length(STR(?content)) > 4)
      }
    `, BASE);

    expect(compiled.query.filters).toEqual([
      {
        variable: 'content',
        operator: '$gt',
        operand: 'stringLength',
        value: expect.objectContaining({
          termType: 'Literal',
          value: '4',
        }),
      },
    ]);
  });

  it('compiles case-normalized string filters as explicit local post-filters', () => {
    const compiled = adapter.compile(`
      PREFIX fn: <http://www.w3.org/2005/xpath-functions#>
      SELECT ?message ?content ?other WHERE {
        ?message <${CONTENT}> ?content .
        ?message <${HAS_MEMBER}> ?other .
        FILTER(LCASE(STR(?content)) = "hello")
        FILTER(UCASE(STR(?content)) IN ("HELLO", "WORLD"))
        FILTER(CONTAINS(LCASE(STR(?content)), "ell"))
        FILTER(fn:starts-with(fn:upper-case(STR(?content)), "HE"))
        FILTER(fn:lower-case(STR(?content)) = fn:lower-case(STR(?other)))
      }
    `, BASE);

    expect(compiled.query.filters).toEqual([
      {
        variable: 'content',
        operator: '$eq',
        operand: 'lowerStringValue',
        value: 'hello',
      },
      {
        variable: 'content',
        operator: '$in',
        operand: 'upperStringValue',
        values: [
          expect.objectContaining({ value: 'HELLO' }),
          expect.objectContaining({ value: 'WORLD' }),
        ],
      },
      {
        variable: 'content',
        operator: '$contains',
        operand: 'lowerStringValue',
        value: 'ell',
        flags: undefined,
      },
      {
        variable: 'content',
        operator: '$startsWith',
        operand: 'upperStringValue',
        value: 'HE',
        flags: undefined,
      },
      {
        variable: 'content',
        operator: '$eq',
        operand: 'lowerStringValue',
        variable2: 'other',
      },
    ]);
  });

  it('compiles STR comparisons and IN filters as string-value filters', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?thread WHERE {
        ?message <${HAS_MEMBER}> ?thread .
        FILTER(STR(?thread) = "${BASE}.data/chat/default/index.ttl#thread_1")
        FILTER(STR(?thread) IN ("${BASE}.data/chat/default/index.ttl#thread_1", "${BASE}.data/chat/default/index.ttl#thread_2"))
      }
    `, BASE);

    expect(compiled.query.filters).toEqual([
      {
        variable: 'thread',
        operator: '$eq',
        operand: 'stringValue',
        value: `${BASE}.data/chat/default/index.ttl#thread_1`,
      },
      {
        variable: 'thread',
        operator: '$in',
        operand: 'stringValue',
        values: [
          expect.objectContaining({
            termType: 'Literal',
            value: `${BASE}.data/chat/default/index.ttl#thread_1`,
          }),
          expect.objectContaining({
            termType: 'Literal',
            value: `${BASE}.data/chat/default/index.ttl#thread_2`,
          }),
        ],
      },
    ]);
  });

  it('compiles safely negated FILTER comparisons and membership tests', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
        FILTER(!(?content = "closed"))
        FILTER(!(STRLEN(STR(?content)) > 8))
        FILTER(!(?content IN ("archived", "deleted")))
        FILTER(!(?content = "draft" || ?content = "queued"))
        FILTER(!(lang(?content) = "en"))
        FILTER(!(datatype(?content) = <http://www.w3.org/2001/XMLSchema#string>))
      }
    `, BASE);

    expect(compiled.query.filters).toEqual([
      {
        variable: 'content',
        operator: '$ne',
        value: expect.objectContaining({
          termType: 'Literal',
          value: 'closed',
        }),
      },
      {
        variable: 'content',
        operator: '$lte',
        operand: 'stringLength',
        value: expect.objectContaining({
          termType: 'Literal',
          value: '8',
        }),
      },
      {
        variable: 'content',
        operator: '$notIn',
        values: [
          expect.objectContaining({
            termType: 'Literal',
            value: 'archived',
          }),
          expect.objectContaining({
            termType: 'Literal',
            value: 'deleted',
          }),
        ],
      },
      {
        variable: 'content',
        operator: '$notIn',
        values: [
          expect.objectContaining({
            termType: 'Literal',
            value: 'draft',
          }),
          expect.objectContaining({
            termType: 'Literal',
            value: 'queued',
          }),
        ],
      },
      {
        variable: 'content',
        operator: '$notLang',
        value: 'en',
      },
      {
        variable: 'content',
        operator: '$notDatatype',
        value: expect.objectContaining({
          termType: 'NamedNode',
          value: 'http://www.w3.org/2001/XMLSchema#string',
        }),
      },
    ]);
  });

  it('compiles standard BIND expressions into local query shape', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?messageLexical ?messageIri ?contentLength WHERE {
        ?message <${CONTENT}> ?content .
        BIND(STR(?message) AS ?messageLexical)
        BIND(IRI(?messageLexical) AS ?messageIri)
        BIND(STRLEN(STR(?content)) AS ?contentLength)
      }
    `, BASE);

    expect(compiled.query.binds).toEqual([
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
          base: BASE,
        },
      },
      {
        variable: 'contentLength',
        expression: {
          type: 'stringLength',
          variable: 'content',
        },
      },
    ]);
    expect(compiled.variables).toEqual(['message', 'messageLexical', 'messageIri', 'contentLength']);
  });

  it('compiles SELECT expression aliases through local bind projections', () => {
    const compiled = adapter.compile(`
      SELECT ?message (STR(?message) AS ?messageLexical) (CONCAT(STR(?message), STR(?content)) AS ?label) WHERE {
        ?message <${CONTENT}> ?content .
      }
      ORDER BY ?messageLexical
    `, BASE);

    expect(compiled.variables).toEqual(['message', 'messageLexical', 'label']);
    expect(compiled.query.select).toEqual(['message', 'messageLexical', 'label']);
    expect(compiled.query.binds).toEqual([
      {
        variable: 'messageLexical',
        expression: {
          type: 'stringValue',
          variable: 'message',
        },
      },
      {
        variable: 'label',
        expression: {
          type: 'concat',
          expressions: [
            { type: 'stringValue', variable: 'message' },
            { type: 'stringValue', variable: 'content' },
          ],
        },
      },
    ]);
    expect(compiled.query.orderBy).toEqual([{ variable: 'messageLexical', direction: 'asc' }]);
  });

  it('compiles CONCAT BIND expressions into local query shape', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?value WHERE {
        ?message <${CONTENT}> ?content .
        BIND(CONCAT(STR(?message), STR(?content)) AS ?value)
      }
    `, BASE);

    expect(compiled.query.binds).toEqual([
      {
        variable: 'value',
        expression: {
          type: 'concat',
          expressions: [
            { type: 'stringValue', variable: 'message' },
            { type: 'stringValue', variable: 'content' },
          ],
        },
      },
    ]);
  });

  it('compiles XPath concat function calls into local query shape', () => {
    const compiled = adapter.compile(`
      PREFIX fn: <http://www.w3.org/2005/xpath-functions#>
      SELECT ?message ?value WHERE {
        ?message <${CONTENT}> ?content .
        BIND(fn:concat(STR(?message), STR(?content)) AS ?value)
      }
    `, BASE);

    expect(compiled.query.binds).toEqual([
      {
        variable: 'value',
        expression: {
          type: 'concat',
          expressions: [
            { type: 'stringValue', variable: 'message' },
            { type: 'stringValue', variable: 'content' },
          ],
        },
      },
    ]);
  });

  it('compiles SUBSTR and XPath substring BIND expressions into local query shape', () => {
    const compiled = adapter.compile(`
      PREFIX fn: <http://www.w3.org/2005/xpath-functions#>
      SELECT ?message ?slice ?tail WHERE {
        ?message <${CONTENT}> ?content .
        BIND(SUBSTR(STR(?content), 2, 3) AS ?slice)
        BIND(fn:substring(STR(?content), 3) AS ?tail)
      }
    `, BASE);

    expect(compiled.query.binds).toEqual([
      {
        variable: 'slice',
        expression: {
          type: 'substring',
          expression: {
            type: 'stringValue',
            variable: 'content',
          },
          start: {
            type: 'term',
            term: expect.objectContaining({
              termType: 'Literal',
              value: '2',
              datatype: expect.objectContaining({ value: XSD_INTEGER }),
            }),
          },
          length: {
            type: 'term',
            term: expect.objectContaining({
              termType: 'Literal',
              value: '3',
              datatype: expect.objectContaining({ value: XSD_INTEGER }),
            }),
          },
        },
      },
      {
        variable: 'tail',
        expression: {
          type: 'substring',
          expression: {
            type: 'stringValue',
            variable: 'content',
          },
          start: {
            type: 'term',
            term: expect.objectContaining({
              termType: 'Literal',
              value: '3',
              datatype: expect.objectContaining({ value: XSD_INTEGER }),
            }),
          },
        },
      },
    ]);
  });

  it('compiles SUBSTR dynamic start and length expressions into local query shape', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?slice WHERE {
        ?message <${CONTENT}> ?content .
        BIND(2 AS ?start)
        BIND(SUBSTR(STR(?content), ?start, STRLEN(?content)) AS ?slice)
      }
    `, BASE);

    expect(compiled.query.binds).toEqual([
      {
        variable: 'start',
        expression: {
          type: 'term',
          term: expect.objectContaining({
            termType: 'Literal',
            value: '2',
            datatype: expect.objectContaining({ value: XSD_INTEGER }),
          }),
        },
      },
      {
        variable: 'slice',
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
            type: 'stringLength',
            variable: 'content',
          },
        },
      },
    ]);
  });

  it('compiles standard lowercase and uppercase BIND expressions into local query shape', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?lower ?upper WHERE {
        ?message <${CONTENT}> ?content .
        BIND(LCASE(STR(?content)) AS ?lower)
        BIND(UCASE(STR(?content)) AS ?upper)
      }
    `, BASE);

    expect(compiled.query.binds).toEqual([
      {
        variable: 'lower',
        expression: {
          type: 'lowerCase',
          expression: {
            type: 'stringValue',
            variable: 'content',
          },
        },
      },
      {
        variable: 'upper',
        expression: {
          type: 'upperCase',
          expression: {
            type: 'stringValue',
            variable: 'content',
          },
        },
      },
    ]);
  });

  it('keeps GRAPH ?g bound to local Pod graph scope', () => {
    const compiled = adapter.compile(`
      SELECT ?g ?message WHERE {
        GRAPH ?g {
          ?message a <${MESSAGE}> .
        }
      }
    `, BASE);

    expect(compiled.query.patterns).toHaveLength(1);
    expect(compiled.query.patterns[0].graph).toEqual({ variable: 'g' });
    expect(compiled.query.filters).toContainEqual({
      variable: 'g',
      operator: '$startsWith',
      value: BASE,
    });
    expect(termToId(compiled.query.patterns[0].predicate as any)).toBe(RDF_TYPE);
  });

  it('compiles controlled MINUS anti-joins into local query shape', () => {
    const compiled = adapter.compile(`
      SELECT ?message WHERE {
        ?message a <${MESSAGE}> .
        MINUS {
          ?message <${CONTENT}> ?content .
          FILTER(CONTAINS(STR(?content), "skip"))
        }
      }
    `, BASE);

    expect(compiled.query.patterns).toHaveLength(1);
    expect(compiled.query.minus).toEqual([
      {
        patterns: [
          expect.objectContaining({
            graph: { $startsWith: BASE },
            subject: { variable: 'message' },
            object: { variable: 'content' },
          }),
        ],
        filters: [
          {
            variable: 'content',
            operator: '$contains',
            operand: 'stringValue',
            value: 'skip',
            flags: undefined,
          },
        ],
      },
    ]);
    expect(termToId(compiled.query.minus?.[0].patterns[0].predicate as any)).toBe(CONTENT);
  });

  it('compiles controlled FILTER NOT EXISTS anti-joins into local query shape', () => {
    const compiled = adapter.compile(`
      SELECT ?message WHERE {
        ?message a <${MESSAGE}> .
        FILTER NOT EXISTS {
          ?message <${CONTENT}> ?content .
          FILTER(CONTAINS(STR(?content), "skip"))
        }
      }
    `, BASE);

    expect(compiled.query.patterns).toHaveLength(1);
    expect(compiled.query.minus).toEqual([
      {
        patterns: [
          expect.objectContaining({
            graph: { $startsWith: BASE },
            subject: { variable: 'message' },
            object: { variable: 'content' },
          }),
        ],
        filters: [
          {
            variable: 'content',
            operator: '$contains',
            operand: 'stringValue',
            value: 'skip',
            flags: undefined,
          },
        ],
      },
    ]);
    expect(termToId(compiled.query.minus?.[0].patterns[0].predicate as any)).toBe(CONTENT);
  });

  it('compiles controlled FILTER EXISTS semi-joins into local query shape', () => {
    const compiled = adapter.compile(`
      SELECT ?message WHERE {
        ?message a <${MESSAGE}> .
        FILTER EXISTS {
          ?message <${CONTENT}> ?content .
          FILTER(CONTAINS(STR(?content), "keep"))
        }
      }
    `, BASE);

    expect(compiled.query.patterns).toHaveLength(1);
    expect(compiled.query.exists).toEqual([
      {
        patterns: [
          expect.objectContaining({
            graph: { $startsWith: BASE },
            subject: { variable: 'message' },
            object: { variable: 'content' },
          }),
        ],
        filters: [
          {
            variable: 'content',
            operator: '$contains',
            operand: 'stringValue',
            value: 'keep',
            flags: undefined,
          },
        ],
      },
    ]);
    expect(termToId(compiled.query.exists?.[0].patterns[0].predicate as any)).toBe(CONTENT);
  });

  it('compiles COUNT aggregates without treating COUNT(*) as a fragment id', () => {
    const countAll = adapter.compile(`
      SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o }
    `, BASE);
    const countDistinct = adapter.compile(`
      SELECT (COUNT(DISTINCT ?s) AS ?count) WHERE { ?s ?p ?o }
    `, BASE);

    expect(countAll.query.aggregate).toEqual({
      type: 'count',
      as: 'count',
      variable: undefined,
      distinct: false,
    });
    expect(countDistinct.query.aggregate).toEqual({
      type: 'count',
      as: 'count',
      variable: 's',
      distinct: true,
    });
  });

  it('compiles guarded numeric aggregate projections into local aggregate aliases', () => {
    const compiled = adapter.compile(`
      SELECT (SUM(?score) AS ?sum) (AVG(?score) AS ?avg) (MIN(?score) AS ?min) (MAX(?score) AS ?max) WHERE {
        ?message <${CONTENT}> ?score .
        FILTER(isNumeric(?score))
      }
    `, BASE);

    expect(compiled.variables).toEqual(['sum', 'avg', 'min', 'max']);
    expect(compiled.query.aggregates).toEqual([
      {
        type: 'sum',
        as: 'sum',
        variable: 'score',
        distinct: false,
      },
      {
        type: 'avg',
        as: 'avg',
        variable: 'score',
        distinct: false,
      },
      {
        type: 'min',
        as: 'min',
        variable: 'score',
        distinct: false,
      },
      {
        type: 'max',
        as: 'max',
        variable: 'score',
        distinct: false,
      },
    ]);
    expect(compiled.query.aggregate).toEqual(compiled.query.aggregates?.[0]);
    expect(compiled.query.filters).toContainEqual({
      variable: 'score',
      operator: '$termType',
      value: 'numeric',
    });
  });

  it('compiles grouped guarded numeric aggregate projections', () => {
    const compiled = adapter.compile(`
      SELECT ?thread (COUNT(?message) AS ?count) (SUM(?score) AS ?total) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
        ?message <${CONTENT}> ?score .
        FILTER(isNumeric(?score))
      }
      GROUP BY ?thread
      HAVING (?total > 4)
      ORDER BY DESC(?total)
      LIMIT 1
    `, BASE);

    expect(compiled.variables).toEqual(['thread', 'count', 'total']);
    expect(compiled.query.groupBy).toEqual(['thread']);
    expect(compiled.query.aggregates).toEqual([
      {
        type: 'count',
        as: 'count',
        variable: 'message',
        distinct: false,
      },
      {
        type: 'sum',
        as: 'total',
        variable: 'score',
        distinct: false,
      },
    ]);
    expect(compiled.query.having).toEqual([
      {
        variable: 'total',
        operator: '$gt',
        value: expect.objectContaining({
          termType: 'Literal',
          value: '4',
        }),
      },
    ]);
    expect(compiled.query.filters).toContainEqual({
      variable: 'score',
      operator: '$termType',
      value: 'numeric',
    });
    expect(compiled.query.select).toEqual(['thread', 'count', 'total']);
    expect(compiled.query.orderBy).toEqual([{ variable: 'total', direction: 'desc' }]);
    expect(compiled.query.limit).toBe(1);
  });

  it('compiles GROUP BY variable with a single COUNT projection', () => {
    const compiled = adapter.compile(`
      SELECT ?thread (COUNT(?message) AS ?count) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
      }
      GROUP BY ?thread
      ORDER BY ?thread
    `, BASE);

    expect(compiled.variables).toEqual(['thread', 'count']);
    expect(compiled.query.groupBy).toEqual(['thread']);
    expect(compiled.query.aggregate).toEqual({
      type: 'count',
      as: 'count',
      variable: 'message',
      distinct: false,
    });
    expect(compiled.query.select).toEqual(['thread', 'count']);
    expect(compiled.query.orderBy).toEqual([{ variable: 'thread', direction: 'asc' }]);
  });

  it('compiles GROUP BY expressions into local binds and grouped COUNT projections', () => {
    const compiled = adapter.compile(`
      SELECT (COUNT(?message) AS ?count) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
      }
      GROUP BY (STR(?thread))
    `, BASE);

    expect(compiled.query.binds).toEqual([
      {
        variable: expect.stringMatching(/^__rdf_group_0_/),
        expression: {
          type: 'stringValue',
          variable: 'thread',
        },
      },
    ]);
    expect(compiled.query.groupBy).toEqual([expect.stringMatching(/^__rdf_group_0_/)]);
    expect(compiled.variables).toEqual(['count']);
    expect(compiled.query.select).toEqual(['count']);
  });

  it('compiles GROUP BY aliases into local binds and grouped COUNT projections', () => {
    const compiled = adapter.compile(`
      SELECT ?threadKey (COUNT(?message) AS ?count) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
      }
      GROUP BY (STR(?thread) AS ?threadKey)
      ORDER BY ?threadKey
    `, BASE);

    expect(compiled.query.binds).toEqual([
      {
        variable: 'threadKey',
        expression: {
          type: 'stringValue',
          variable: 'thread',
        },
      },
    ]);
    expect(compiled.query.groupBy).toEqual(['threadKey']);
    expect(compiled.variables).toEqual(['threadKey', 'count']);
    expect(compiled.query.select).toEqual(['threadKey', 'count']);
    expect(compiled.query.orderBy).toEqual([{ variable: 'threadKey', direction: 'asc' }]);
  });

  it('compiles multiple COUNT projections into local aggregate aliases', () => {
    const compiled = adapter.compile(`
      SELECT ?thread (COUNT(?message) AS ?messageCount) (COUNT(DISTINCT ?message) AS ?distinctMessageCount) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
      }
      GROUP BY ?thread
      ORDER BY ?thread
    `, BASE);

    expect(compiled.variables).toEqual(['thread', 'messageCount', 'distinctMessageCount']);
    expect(compiled.query.groupBy).toEqual(['thread']);
    expect(compiled.query.aggregates).toEqual([
      {
        type: 'count',
        as: 'messageCount',
        variable: 'message',
        distinct: false,
      },
      {
        type: 'count',
        as: 'distinctMessageCount',
        variable: 'message',
        distinct: true,
      },
    ]);
    expect(compiled.query.aggregate).toEqual(compiled.query.aggregates?.[0]);
    expect(compiled.query.select).toEqual(['thread', 'messageCount', 'distinctMessageCount']);
    expect(compiled.query.orderBy).toEqual([{ variable: 'thread', direction: 'asc' }]);
  });

  it('compiles grouped COUNT HAVING filters over the aggregate alias', () => {
    const compiled = adapter.compile(`
      SELECT ?thread (COUNT(?message) AS ?count) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
      }
      GROUP BY ?thread
      HAVING (?count > 1)
    `, BASE);

    expect(compiled.query.having).toEqual([
      {
        variable: 'count',
        operator: '$gt',
        value: expect.objectContaining({
          termType: 'Literal',
          value: '1',
        }),
      },
    ]);
  });

  it('compiles grouped COUNT HAVING filters over a matching COUNT expression', () => {
    const compiled = adapter.compile(`
      SELECT ?thread (COUNT(?message) AS ?count) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
      }
      GROUP BY ?thread
      HAVING (COUNT(?message) > 1)
    `, BASE);

    expect(compiled.query.having).toEqual([
      {
        variable: 'count',
        operator: '$gt',
        value: expect.objectContaining({
          termType: 'Literal',
          value: '1',
        }),
      },
    ]);
  });

  it('compiles grouped COUNT DISTINCT HAVING filters as hidden aggregate aliases', () => {
    const compiled = adapter.compile(`
      SELECT ?thread (COUNT(?message) AS ?count) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
      }
      GROUP BY ?thread
      HAVING (COUNT(DISTINCT ?message) > 1)
    `, BASE);

    expect(compiled.variables).toEqual(['thread', 'count']);
    expect(compiled.query.select).toEqual(['thread', 'count']);
    expect(compiled.query.aggregates).toEqual([
      {
        type: 'count',
        as: 'count',
        variable: 'message',
        distinct: false,
      },
      {
        type: 'count',
        as: '__rdf_having_aggregate_1',
        variable: 'message',
        distinct: true,
      },
    ]);
    expect(compiled.query.having).toEqual([
      {
        variable: '__rdf_having_aggregate_1',
        operator: '$gt',
        value: expect.objectContaining({
          termType: 'Literal',
          value: '1',
        }),
      },
    ]);
  });

  it('compiles mixed-direction multi-variable ORDER BY for local post-sort', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?createdAt WHERE {
        ?message <http://purl.org/dc/terms/created> ?createdAt .
      }
      ORDER BY DESC(?createdAt) ASC(?message)
      LIMIT 20
    `, BASE);

    expect(compiled.query.orderBy).toEqual([
      { variable: 'createdAt', direction: 'desc' },
      { variable: 'message', direction: 'asc' },
    ]);
    expect(compiled.query.limit).toBe(20);
  });

  it('compiles ORDER BY expressions into local binds for post-sort', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
      }
      ORDER BY STR(?content)
    `, BASE);

    expect(compiled.query.binds).toEqual([
      {
        variable: expect.stringMatching(/^__rdf_order_0_/),
        expression: {
          type: 'stringValue',
          variable: 'content',
        },
      },
    ]);
    expect(compiled.query.orderBy).toEqual([
      { variable: expect.stringMatching(/^__rdf_order_0_/), direction: 'asc' },
    ]);
    expect(compiled.variables).toEqual(['message', 'content']);
    expect(compiled.query.select).toEqual(['message', 'content']);
  });

  it('compiles reversed variable-term FILTER comparisons', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?createdAt WHERE {
        ?message <http://purl.org/dc/terms/created> ?createdAt .
        FILTER("2026-05-18T00:00:02.000Z" >= ?createdAt)
      }
    `, BASE);

    const filter = compiled.query.filters?.[0];
    expect(filter).toMatchObject({
      variable: 'createdAt',
      operator: '$lte',
    });
    expect((filter?.value as any)?.termType).toBe('Literal');
    expect((filter?.value as any)?.value).toBe('2026-05-18T00:00:02.000Z');
  });

  it('compiles same-variable OR equality filters into a local IN filter', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
        FILTER(?content = "hello" || ?content = "second" || ?content IN ("hello", "third"))
      }
      ORDER BY ?message
    `, BASE);

    expect(compiled.query.filters).toHaveLength(1);
    expect(compiled.query.filters?.[0]).toMatchObject({
      variable: 'content',
      operator: '$in',
    });
    expect(compiled.query.filters?.[0].values?.map((value: any) => value.value)).toEqual([
      'hello',
      'second',
      'third',
    ]);
  });

  it('preserves STR lexical semantics when folding OR equality filters into IN', () => {
    const thread1 = `${BASE}.data/chat/default/index.ttl#thread_1`;
    const thread2 = `${BASE}.data/chat/default/index.ttl#thread_2`;
    const compiled = adapter.compile(`
      SELECT ?message ?thread WHERE {
        ?message <${HAS_MEMBER}> ?thread .
        FILTER(STR(?thread) = "${thread1}" || STR(?thread) = "${thread2}")
      }
      ORDER BY ?message
    `, BASE);

    expect(compiled.query.filters).toHaveLength(1);
    expect(compiled.query.filters?.[0]).toMatchObject({
      variable: 'thread',
      operator: '$in',
      operand: 'stringValue',
    });
    expect(compiled.query.filters?.[0].values).toEqual([
      thread1,
      thread2,
    ]);
  });

  it('compiles standard RDF term-test FILTER functions', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
        FILTER(isIRI(?message))
        FILTER(isURI(?message))
        FILTER(isLiteral(?content))
        FILTER(isNumeric(?content))
        FILTER(sameTerm(?message, <${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1>))
        FILTER(lang(?content) = "en")
        FILTER(lang(?content) != "fr")
        FILTER(LANGMATCHES(LANG(?content), "en"))
        FILTER(datatype(?content) = <http://www.w3.org/2001/XMLSchema#string>)
        FILTER(datatype(?content) != <${XSD_INTEGER}>)
      }
    `, BASE);

    expect(compiled.query.filters).toEqual([
      {
        variable: 'message',
        operator: '$termType',
        value: 'iri',
      },
      {
        variable: 'message',
        operator: '$termType',
        value: 'iri',
      },
      {
        variable: 'content',
        operator: '$termType',
        value: 'literal',
      },
      {
        variable: 'content',
        operator: '$termType',
        value: 'numeric',
      },
      {
        variable: 'message',
        operator: '$sameTerm',
        value: expect.objectContaining({
          termType: 'NamedNode',
          value: `${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1`,
        }),
      },
      {
        variable: 'content',
        operator: '$lang',
        value: 'en',
      },
      {
        variable: 'content',
        operator: '$notLang',
        value: 'fr',
      },
      {
        variable: 'content',
        operator: '$langMatches',
        value: 'en',
      },
      {
        variable: 'content',
        operator: '$datatype',
        value: expect.objectContaining({
          termType: 'NamedNode',
          value: 'http://www.w3.org/2001/XMLSchema#string',
        }),
      },
      {
        variable: 'content',
        operator: '$notDatatype',
        value: expect.objectContaining({
          termType: 'NamedNode',
          value: XSD_INTEGER,
        }),
      },
    ]);
  });

  it('compiles safely negated RDF term-test FILTER functions', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?content ?thread WHERE {
        ?message <${CONTENT}> ?content .
        ?message <${HAS_MEMBER}> ?thread .
        FILTER(!isIRI(?content))
        FILTER(!isLiteral(?message))
        FILTER(!isNumeric(?content))
        FILTER(!sameTerm(?message, <${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_2>))
        FILTER(!sameTerm(?message, ?thread))
      }
    `, BASE);

    expect(compiled.query.filters).toEqual([
      {
        variable: 'content',
        operator: '$notTermType',
        value: 'iri',
      },
      {
        variable: 'message',
        operator: '$notTermType',
        value: 'literal',
      },
      {
        variable: 'content',
        operator: '$notTermType',
        value: 'numeric',
      },
      {
        variable: 'message',
        operator: '$notSameTerm',
        value: expect.objectContaining({
          termType: 'NamedNode',
          value: `${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_2`,
        }),
      },
      {
        variable: 'message',
        operator: '$notSameTerm',
        variable2: 'thread',
      },
    ]);
  });

  it('compiles FROM and FROM NAMED dataset scope into local graph constraints', () => {
    const defaultGraphA = `${BASE}.data/chat/default/2026/05/18/messages.ttl`;
    const defaultGraphB = `${BASE}.data/chat/default/2026/05/19/messages.ttl`;
    const namedGraphA = `${BASE}.data/chat/default/a.ttl`;
    const namedGraphB = `${BASE}.data/chat/default/b.ttl`;

    const defaultScoped = adapter.compile(`
      SELECT ?message ?content
      FROM <${defaultGraphA}>
      FROM <${defaultGraphB}>
      WHERE {
        ?message <${CONTENT}> ?content .
      }
    `, BASE);

    expect(defaultScoped.query.patterns).toEqual([
      expect.objectContaining({
        graph: {
          $in: [
            expect.objectContaining({
              termType: 'NamedNode',
              value: defaultGraphA,
            }),
            expect.objectContaining({
              termType: 'NamedNode',
              value: defaultGraphB,
            }),
          ],
        },
        subject: { variable: 'message' },
        object: { variable: 'content' },
      }),
    ]);

    const namedScoped = adapter.compile(`
      SELECT ?graph ?message ?content
      FROM NAMED <${namedGraphA}>
      FROM NAMED <${namedGraphB}>
      WHERE {
        GRAPH ?graph {
          ?message <${CONTENT}> ?content .
        }
      }
    `, BASE);

    expect(namedScoped.query.patterns).toEqual([
      expect.objectContaining({
        graph: { variable: 'graph' },
        subject: { variable: 'message' },
        object: { variable: 'content' },
      }),
    ]);
    expect(namedScoped.query.filters).toEqual([
      {
        variable: 'graph',
        operator: '$in',
        values: [
          expect.objectContaining({
            termType: 'NamedNode',
            value: namedGraphA,
          }),
          expect.objectContaining({
            termType: 'NamedNode',
            value: namedGraphB,
          }),
        ],
      },
    ]);

    const defaultGraphOnly = adapter.compile(`
      SELECT ?message ?content
      FROM NAMED <${namedGraphA}>
      WHERE {
        ?message <${CONTENT}> ?content .
      }
    `, BASE);

    expect(defaultGraphOnly.query.patterns).toEqual([
      expect.objectContaining({
        graph: expect.objectContaining({
          termType: 'NamedNode',
          value: `${BASE}__outside_graph_scope__`,
        }),
      }),
    ]);
  });

  it('compiles sameTerm between two variables', () => {
    const compiled = adapter.compile(`
      SELECT ?left ?right WHERE {
        ?left <${HAS_MEMBER}> ?right .
        FILTER(sameTerm(?left, ?right))
      }
    `, BASE);

    expect(compiled.query.filters).toContainEqual({
      variable: 'left',
      operator: '$sameTerm',
      variable2: 'right',
    });
  });

  it('compiles variable-variable FILTER comparisons into local filters', () => {
    const compiled = adapter.compile(`
      SELECT ?left ?right WHERE {
        ?left <${CONTENT}> ?leftValue .
        ?right <${CONTENT}> ?rightValue .
        FILTER(?leftValue != ?rightValue)
        FILTER(?left < ?right)
      }
    `, BASE);

    expect(compiled.query.filters).toContainEqual({
      variable: 'leftValue',
      operator: '$ne',
      variable2: 'rightValue',
    });
    expect(compiled.query.filters).toContainEqual({
      variable: 'left',
      operator: '$lt',
      variable2: 'right',
    });
  });

  it('compiles variable-variable string-value and string-length filters into local filters', () => {
    const compiled = adapter.compile(`
      SELECT ?left ?right WHERE {
        ?left <${CONTENT}> ?leftValue .
        ?right <${CONTENT}> ?rightValue .
        FILTER(STR(?leftValue) = STR(?rightValue))
        FILTER(STRLEN(STR(?leftValue)) < STRLEN(STR(?rightValue)))
      }
    `, BASE);

    expect(compiled.query.filters).toContainEqual({
      variable: 'leftValue',
      operator: '$eq',
      operand: 'stringValue',
      variable2: 'rightValue',
    });
    expect(compiled.query.filters).toContainEqual({
      variable: 'leftValue',
      operator: '$lt',
      operand: 'stringLength',
      variable2: 'rightValue',
    });
  });

  it('compiles simple CONSTRUCT templates into local query shape', () => {
    const compiled = adapter.compile(`
      CONSTRUCT {
        ?message <${CONTENT}> ?content .
      }
      WHERE {
        ?message <${CONTENT}> ?content .
      }
    `, BASE);

    expect(compiled.queryType).toBe('CONSTRUCT');
    expect(compiled.constructTemplate).toEqual([
      {
        subject: { variable: 'message' },
        predicate: expect.objectContaining({
          termType: 'NamedNode',
          value: CONTENT,
        }),
        object: { variable: 'content' },
      },
    ]);
    expect(compiled.query.patterns).toHaveLength(1);
    expect(compiled.query.patterns[0]).toMatchObject({
      graph: { $startsWith: BASE },
      subject: { variable: 'message' },
      object: { variable: 'content' },
    });
  });

  it('compiles bounded DESCRIBE targets for the embedded direct-description path', () => {
    const msg1 = `${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1`;
    const byIri = adapter.compile(`DESCRIBE <${msg1}>`, BASE);
    const byVariable = adapter.compile(`
      DESCRIBE ?message WHERE {
        ?message a <${MESSAGE}> .
      }
    `, BASE);

    expect(byIri.queryType).toBe('DESCRIBE');
    expect(byIri.query.patterns).toEqual([]);
    expect(byIri.describeTargets).toEqual([
      expect.objectContaining({
        termType: 'NamedNode',
        value: msg1,
      }),
    ]);
    expect(byVariable.queryType).toBe('DESCRIBE');
    expect(byVariable.query.patterns).toHaveLength(1);
    expect(byVariable.describeTargets).toEqual([{ variable: 'message' }]);
  });

  it('compiles standard wildcard DESCRIBE into visible required variables', () => {
    const compiled = adapter.compile(`
      DESCRIBE * WHERE {
        ?message a <${MESSAGE}> .
        ?message <${CONTENT}> ?content .
      }
    `, BASE);

    expect(compiled.queryType).toBe('DESCRIBE');
    expect(compiled.query.patterns).toHaveLength(2);
    expect(compiled.describeTargets).toEqual([
      { variable: 'message' },
      { variable: 'content' },
    ]);
  });

  it('rejects wildcard DESCRIBE when a visible variable is only optional', () => {
    expect(() => adapter.compile(`
      DESCRIBE * WHERE {
        ?message a <${MESSAGE}> .
        OPTIONAL {
          ?message <${CONTENT}> ?content .
        }
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);
  });

  it('normalizes simple inverse property paths at the adapter boundary', () => {
    const thread = `${BASE}.data/chat/default/index.ttl#thread_1`;
    const compiled = adapter.compile(`
      SELECT ?message WHERE {
        <${thread}> ^<${HAS_MEMBER}> ?message .
      }
      ORDER BY ?message
    `, BASE);

    expect(compiled.query.patterns).toHaveLength(1);
    expect(compiled.query.patterns[0]).toMatchObject({
      graph: { $startsWith: BASE },
      subject: { variable: 'message' },
      object: expect.objectContaining({
        termType: 'NamedNode',
        value: thread,
      }),
    });
    expect(termToId(compiled.query.patterns[0].predicate as any)).toBe(HAS_MEMBER);
    expect(compiled.query.orderBy).toEqual([{ variable: 'message', direction: 'asc' }]);
  });

  it('normalizes fixed-length sequence property paths into ordinary BGP joins', () => {
    const compiled = adapter.compile(`
      SELECT ?thread ?content WHERE {
        ?thread ^<${HAS_MEMBER}>/<${CONTENT}> ?content .
      }
      ORDER BY ?content
    `, BASE);

    expect(compiled.query.patterns).toHaveLength(2);
    expect(compiled.query.patterns[0]).toMatchObject({
      graph: { $startsWith: BASE },
      subject: { variable: '__rdf_path_1' },
      object: { variable: 'thread' },
    });
    expect(compiled.query.patterns[1]).toMatchObject({
      graph: { $startsWith: BASE },
      subject: { variable: '__rdf_path_1' },
      object: { variable: 'content' },
    });
    expect(termToId(compiled.query.patterns[0].predicate as any)).toBe(HAS_MEMBER);
    expect(termToId(compiled.query.patterns[1].predicate as any)).toBe(CONTENT);
    expect(compiled.query.orderBy).toEqual([{ variable: 'content', direction: 'asc' }]);
  });

  it('normalizes simple alternative property paths into predicate IN scans', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?value WHERE {
        ?message (<${CONTENT}>|<${HAS_MEMBER}>) ?value .
      }
      ORDER BY ?message ?value
    `, BASE);

    expect(compiled.query.patterns).toHaveLength(1);
    expect(compiled.query.patterns[0]).toMatchObject({
      graph: { $startsWith: BASE },
      subject: { variable: 'message' },
      object: { variable: 'value' },
    });
    expect((compiled.query.patterns[0].predicate as any).$in.map(termToId)).toEqual([
      CONTENT,
      HAS_MEMBER,
    ]);
  });

  it('normalizes fixed alternative segments inside sequence property paths', () => {
    const compiled = adapter.compile(`
      SELECT ?thread ?value WHERE {
        ?thread ^<${HAS_MEMBER}>/(<${CONTENT}>|<http://purl.org/dc/terms/created>) ?value .
      }
      ORDER BY ?value
    `, BASE);

    expect(compiled.query.patterns).toHaveLength(2);
    expect(compiled.query.patterns[0]).toMatchObject({
      graph: { $startsWith: BASE },
      subject: { variable: '__rdf_path_1' },
      object: { variable: 'thread' },
    });
    expect(termToId(compiled.query.patterns[0].predicate as any)).toBe(HAS_MEMBER);
    expect(compiled.query.patterns[1]).toMatchObject({
      graph: { $startsWith: BASE },
      subject: { variable: '__rdf_path_1' },
      object: { variable: 'value' },
    });
    expect((compiled.query.patterns[1].predicate as any).$in.map(termToId)).toEqual([
      CONTENT,
      'http://purl.org/dc/terms/created',
    ]);
  });

  it('normalizes inverse alternative property paths into predicate IN scans', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?value WHERE {
        ?value ^(<${CONTENT}>|<${HAS_MEMBER}>) ?message .
      }
      ORDER BY ?message ?value
    `, BASE);

    expect(compiled.query.patterns).toHaveLength(1);
    expect(compiled.query.patterns[0]).toMatchObject({
      graph: { $startsWith: BASE },
      subject: { variable: 'message' },
      object: { variable: 'value' },
    });
    expect((compiled.query.patterns[0].predicate as any).$in.map(termToId)).toEqual([
      CONTENT,
      HAS_MEMBER,
    ]);
  });

  it('does not expose internal property-path join variables for SELECT wildcard', () => {
    const compiled = adapter.compile(`
      SELECT * WHERE {
        ?thread ^<${HAS_MEMBER}>/<${CONTENT}> ?content .
      }
    `, BASE);

    expect(compiled.variables).toEqual(['thread', 'content']);
    expect(compiled.query.select).toEqual(['thread', 'content']);
  });

  it('compiles controlled UNION branches into the embedded local query shape', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?value WHERE {
        { ?message <${CONTENT}> ?value }
        UNION
        { ?message <${HAS_MEMBER}> ?value }
      }
      ORDER BY ?message
    `, BASE);

    expect(compiled.query.patterns).toEqual([]);
    expect(compiled.query.unions).toHaveLength(1);
    expect(compiled.query.unions?.[0].branches).toHaveLength(2);
    expect(compiled.query.unions?.[0].branches[0].patterns[0]).toMatchObject({
      graph: { $startsWith: BASE },
      subject: { variable: 'message' },
      object: { variable: 'value' },
    });
    expect(termToId(compiled.query.unions?.[0].branches[0].patterns[0].predicate as any)).toBe(CONTENT);
    expect(termToId(compiled.query.unions?.[0].branches[1].patterns[0].predicate as any)).toBe(HAS_MEMBER);
    expect(compiled.query.orderBy).toEqual([{ variable: 'message', direction: 'asc' }]);
  });

  it('compiles BIND inside UNION branches into branch-local bindings', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?label WHERE {
        {
          ?message <${CONTENT}> ?value .
          BIND(CONCAT("content:", STR(?value)) AS ?label)
        }
        UNION
        {
          ?message <${HAS_MEMBER}> ?value .
          BIND(CONCAT("member:", STR(?value)) AS ?label)
        }
      }
      ORDER BY ?message ?label
    `, BASE);

    expect(compiled.query.unions).toHaveLength(1);
    expect(compiled.query.unions?.[0].branches[0]).toMatchObject({
      binds: [
        {
          variable: 'label',
          expression: {
            type: 'concat',
            expressions: [
              {
                type: 'term',
                term: expect.objectContaining({
                  termType: 'Literal',
                  value: 'content:',
                }),
              },
              { type: 'stringValue', variable: 'value' },
            ],
          },
        },
      ],
    });
    expect(compiled.query.unions?.[0].branches[1]).toMatchObject({
      binds: [
        {
          variable: 'label',
          expression: {
            type: 'concat',
            expressions: [
              {
                type: 'term',
                term: expect.objectContaining({
                  termType: 'Literal',
                  value: 'member:',
                }),
              },
              { type: 'stringValue', variable: 'value' },
            ],
          },
        },
      ],
    });
  });

  it('flattens nested controlled UNION branches into one embedded union group', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?value WHERE {
        { ?message <${CONTENT}> ?value }
        UNION
        {
          { ?message <${HAS_MEMBER}> ?value }
          UNION
          { ?message a <${MESSAGE}> }
        }
      }
      ORDER BY ?message
    `, BASE);

    expect(compiled.query.patterns).toEqual([]);
    expect(compiled.query.unions?.[0].branches).toHaveLength(3);
    expect(termToId(compiled.query.unions?.[0].branches[0].patterns[0].predicate as any)).toBe(CONTENT);
    expect(termToId(compiled.query.unions?.[0].branches[1].patterns[0].predicate as any)).toBe(HAS_MEMBER);
    expect(termToId(compiled.query.unions?.[0].branches[2].patterns[0].predicate as any)).toBe(RDF_TYPE);
    expect(termToId(compiled.query.unions?.[0].branches[2].patterns[0].object as any)).toBe(MESSAGE);
  });

  it('compiles UNION branches with local filters and trailing VALUES', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?value WHERE {
        {
          ?message <${CONTENT}> ?value .
          FILTER(CONTAINS(STR(?value), "hello"))
        }
        UNION
        {
          ?message <${HAS_MEMBER}> ?value .
        }
        VALUES ?message { <${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1> }
      }
    `, BASE);

    expect(compiled.query.filters).toContainEqual(expect.objectContaining({
      variable: 'message',
      operator: '$in',
      source: 'values',
    }));
    expect(compiled.query.unions?.[0].branches[0].filters).toContainEqual({
      variable: 'value',
      operator: '$contains',
      operand: 'stringValue',
      value: 'hello',
      flags: undefined,
    });
  });

  it('compiles tuple VALUES inside UNION branches as branch-local constraints', () => {
    const msg1 = `${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1`;
    const msg2 = `${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_2`;
    const thread = `${BASE}.data/chat/default/index.ttl#thread_1`;
    const compiled = adapter.compile(`
      SELECT ?message ?value WHERE {
        {
          VALUES (?message ?value) {
            (<${msg1}> "hello")
            (<${msg2}> "invalid-content")
          }
          ?message <${CONTENT}> ?value .
        }
        UNION
        {
          VALUES (?message ?value) {
            (<${msg2}> <${thread}>)
            (<${msg1}> "invalid-member")
          }
          ?message <${HAS_MEMBER}> ?value .
        }
      }
    `, BASE);

    expect(compiled.query.unions?.[0].branches[0].values).toEqual([
      {
        variables: ['message', 'value'],
        rows: [
          {
            message: expect.objectContaining({ value: msg1 }),
            value: expect.objectContaining({ value: 'hello' }),
          },
          {
            message: expect.objectContaining({ value: msg2 }),
            value: expect.objectContaining({ value: 'invalid-content' }),
          },
        ],
      },
    ]);
    expect(compiled.query.unions?.[0].branches[1].values?.[0].rows[0]).toEqual({
      message: expect.objectContaining({ value: msg2 }),
      value: expect.objectContaining({ value: thread }),
    });
  });

  it('allows VALUES outside UNION when a required pattern already binds the variable', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?value WHERE {
        ?message a <${MESSAGE}> .
        {
          ?message <${CONTENT}> ?value .
        }
        UNION
        {
          ?message <${HAS_MEMBER}> ?thread .
        }
        VALUES ?message { <${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1> }
      }
    `, BASE);

    expect(compiled.query.patterns).toHaveLength(1);
    expect(compiled.query.filters).toContainEqual(expect.objectContaining({
      variable: 'message',
      operator: '$in',
      source: 'values',
    }));
  });

  it('rejects VALUES outside UNION when the variable is not bound by every branch', () => {
    expect(() => adapter.compile(`
      SELECT ?message ?value WHERE {
        {
          ?message <${CONTENT}> ?value .
        }
        UNION
        {
          ?message <${HAS_MEMBER}> ?thread .
        }
        VALUES ?value { "hello" }
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);
  });

  it('compiles nested OPTIONAL groups into optional-local nested groups', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?value ?thread WHERE {
        ?message a <${MESSAGE}> .
        OPTIONAL {
          ?message <${CONTENT}> ?value .
          OPTIONAL {
            { ?message <${HAS_MEMBER}> ?thread }
            UNION
            { ?message a <${MESSAGE}> }
          }
        }
      }
    `, BASE);

    expect(compiled.query.optional).toHaveLength(1);
    const outer = compiled.query.optional?.[0];
    expect(Array.isArray(outer)).toBe(false);
    expect(outer).toMatchObject({
      patterns: [
        expect.objectContaining({
          graph: { $startsWith: BASE },
          subject: { variable: 'message' },
          object: { variable: 'value' },
          predicate: expect.objectContaining({
            termType: 'NamedNode',
            value: CONTENT,
          }),
        }),
      ],
      optional: [
        expect.objectContaining({
          patterns: [],
          unions: [
            expect.objectContaining({
              branches: [
                expect.objectContaining({
                  patterns: [
                    expect.objectContaining({
                      graph: { $startsWith: BASE },
                      subject: { variable: 'message' },
                      object: { variable: 'thread' },
                      predicate: expect.objectContaining({
                        termType: 'NamedNode',
                        value: HAS_MEMBER,
                      }),
                    }),
                  ],
                }),
                expect.objectContaining({
                  patterns: [
                    expect.objectContaining({
                      graph: { $startsWith: BASE },
                      subject: { variable: 'message' },
                      object: expect.objectContaining({
                        termType: 'NamedNode',
                        value: MESSAGE,
                      }),
                      predicate: expect.objectContaining({
                        termType: 'NamedNode',
                        value: RDF_TYPE,
                      }),
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    });
  });

  it('compiles UNION inside OPTIONAL into an optional union group', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?value WHERE {
        ?message a <${MESSAGE}> .
        OPTIONAL {
          {
            ?message <${CONTENT}> ?value
          }
          UNION
          {
            ?message <${HAS_MEMBER}> ?value
          }
        }
      }
    `, BASE);

    expect(compiled.query.optional).toHaveLength(1);
    expect(compiled.query.optional?.[0]).toMatchObject({
      patterns: [],
      unions: [
        {
          branches: [
            {
              patterns: [
                expect.objectContaining({
                  graph: { $startsWith: BASE },
                  subject: { variable: 'message' },
                  object: { variable: 'value' },
                  predicate: expect.objectContaining({
                    termType: 'NamedNode',
                    value: CONTENT,
                  }),
                }),
              ],
            },
            {
              patterns: [
                expect.objectContaining({
                  graph: { $startsWith: BASE },
                  subject: { variable: 'message' },
                  object: { variable: 'value' },
                  predicate: expect.objectContaining({
                    termType: 'NamedNode',
                    value: HAS_MEMBER,
                  }),
                }),
              ],
            },
          ],
        },
      ],
    });
  });

  it('compiles OPTIONAL-local dependent joins into optional groups', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?content ?thread WHERE {
        ?message a <${MESSAGE}> .
        OPTIONAL {
          ?message <${CONTENT}> ?content .
          FILTER EXISTS {
            ?message <${HAS_MEMBER}> ?thread .
          }
          FILTER NOT EXISTS {
            ?message <${CONTENT}> "archived" .
          }
          MINUS {
            ?message <${CONTENT}> "skip" .
          }
        }
      }
    `, BASE);

    expect(compiled.query.optional).toHaveLength(1);
    const optional = compiled.query.optional?.[0];
    expect(Array.isArray(optional)).toBe(false);
    expect(optional).toMatchObject({
      patterns: [
        expect.objectContaining({
          graph: { $startsWith: BASE },
          subject: { variable: 'message' },
          object: { variable: 'content' },
          predicate: expect.objectContaining({
            termType: 'NamedNode',
            value: CONTENT,
          }),
        }),
      ],
      exists: [
        {
          patterns: [
            expect.objectContaining({
              graph: { $startsWith: BASE },
              subject: { variable: 'message' },
              object: { variable: 'thread' },
              predicate: expect.objectContaining({
                termType: 'NamedNode',
                value: HAS_MEMBER,
              }),
            }),
          ],
        },
      ],
      minus: [
        {
          patterns: [
            expect.objectContaining({
              graph: { $startsWith: BASE },
              subject: { variable: 'message' },
              object: expect.objectContaining({
                termType: 'Literal',
                value: 'archived',
              }),
              predicate: expect.objectContaining({
                termType: 'NamedNode',
                value: CONTENT,
              }),
            }),
          ],
        },
        {
          patterns: [
            expect.objectContaining({
              graph: { $startsWith: BASE },
              subject: { variable: 'message' },
              object: expect.objectContaining({
                termType: 'Literal',
                value: 'skip',
              }),
              predicate: expect.objectContaining({
                termType: 'NamedNode',
                value: CONTENT,
              }),
            }),
          ],
        },
      ],
    });
  });

  it('compiles dependent joins with controlled UNION branches', () => {
    const compiled = adapter.compile(`
      SELECT ?message WHERE {
        ?message a <${MESSAGE}> .
        FILTER EXISTS {
          {
            ?message <${CONTENT}> ?value .
          }
          UNION
          {
            ?message <${HAS_MEMBER}> ?value .
          }
        }
        MINUS {
          ?message <${HAS_MEMBER}> ?thread .
          {
            ?message <${CONTENT}> "archived" .
          }
          UNION
          {
            ?message <${CONTENT}> "deleted" .
          }
        }
      }
    `, BASE);

    expect(compiled.query.exists).toHaveLength(1);
    expect(compiled.query.exists?.[0]).toMatchObject({
      patterns: [],
      unions: [
        {
          branches: [
            {
              patterns: [
                expect.objectContaining({
                  graph: { $startsWith: BASE },
                  subject: { variable: 'message' },
                  object: { variable: 'value' },
                  predicate: expect.objectContaining({
                    termType: 'NamedNode',
                    value: CONTENT,
                  }),
                }),
              ],
            },
            {
              patterns: [
                expect.objectContaining({
                  graph: { $startsWith: BASE },
                  subject: { variable: 'message' },
                  object: { variable: 'value' },
                  predicate: expect.objectContaining({
                    termType: 'NamedNode',
                    value: HAS_MEMBER,
                  }),
                }),
              ],
            },
          ],
        },
      ],
    });
    expect(compiled.query.minus).toHaveLength(1);
    expect(compiled.query.minus?.[0]).toMatchObject({
      patterns: [
        expect.objectContaining({
          graph: { $startsWith: BASE },
          subject: { variable: 'message' },
          object: { variable: 'thread' },
          predicate: expect.objectContaining({
            termType: 'NamedNode',
            value: HAS_MEMBER,
          }),
        }),
      ],
      unions: [
        {
          branches: [
            {
              patterns: [
                expect.objectContaining({
                  graph: { $startsWith: BASE },
                  subject: { variable: 'message' },
                  object: expect.objectContaining({
                    termType: 'Literal',
                    value: 'archived',
                  }),
                  predicate: expect.objectContaining({
                    termType: 'NamedNode',
                    value: CONTENT,
                  }),
                }),
              ],
            },
            {
              patterns: [
                expect.objectContaining({
                  graph: { $startsWith: BASE },
                  subject: { variable: 'message' },
                  object: expect.objectContaining({
                    termType: 'Literal',
                    value: 'deleted',
                  }),
                  predicate: expect.objectContaining({
                    termType: 'NamedNode',
                    value: CONTENT,
                  }),
                }),
              ],
            },
          ],
        },
      ],
    });
  });

  it('materializes CONSTRUCT rows into distinct RDF quads', () => {
    const template = adapter.compile(`
      CONSTRUCT {
        ?message <${CONTENT}> ?content .
        ?missing <${CONTENT}> ?content .
      }
      WHERE {
        ?message <${CONTENT}> ?content .
      }
    `, BASE).constructTemplate;

    const quads = adapter.materializeConstruct(template ?? [], [
      {
        message: namedNode(`${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1`),
        content: literal('hello'),
      },
      {
        message: namedNode(`${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1`),
        content: literal('hello'),
      },
    ]);

    expect(quads).toHaveLength(1);
    expect(quads[0].subject.value).toBe(`${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1`);
    expect(quads[0].predicate.value).toBe(CONTENT);
    expect(quads[0].object.value).toBe('hello');
  });

  it('compiles INSERT DATA and DELETE DATA into scoped update deltas', () => {
    const insert = adapter.compileUpdateDelta(`
      INSERT DATA {
        GRAPH <${BASE}.data/chat/default/index.ttl> {
          <${BASE}.data/chat/default/index.ttl#msg_3> <${CONTENT}> "created" .
        }
      }
    `, BASE);
    const remove = adapter.compileUpdateDelta(`
      DELETE DATA {
        GRAPH <${BASE}.data/chat/default/index.ttl> {
          <${BASE}.data/chat/default/index.ttl#msg_3> <${CONTENT}> "created" .
        }
      }
    `, BASE);

    expect(insert.operations).toHaveLength(1);
    expect(insert.inserts).toHaveLength(1);
    expect(insert.deletes).toHaveLength(0);
    expect(insert.inserts[0].graph.value).toBe(`${BASE}.data/chat/default/index.ttl`);
    expect(insert.inserts[0].subject.value).toBe(`${BASE}.data/chat/default/index.ttl#msg_3`);
    expect(insert.inserts[0].predicate.value).toBe(CONTENT);
    expect(insert.inserts[0].object.value).toBe('created');

    expect(remove.operations).toHaveLength(1);
    expect(remove.deletes).toHaveLength(1);
    expect(remove.inserts).toHaveLength(0);
    expect(remove.deletes[0].graph.value).toBe(`${BASE}.data/chat/default/index.ttl`);
  });

  it('compiles DELETE WHERE into a local query-backed update delta', () => {
    const delta = adapter.compileUpdateDelta(`
      DELETE WHERE {
        GRAPH <${BASE}.data/chat/default/index.ttl> {
          ?message <${CONTENT}> ?content .
        }
      }
    `, BASE);

    expect(delta.inserts).toEqual([]);
    expect(delta.deletes).toEqual([]);
    expect(delta.operations).toHaveLength(1);
    expect(delta.operations[0]).toMatchObject({
      type: 'deleteWhere',
      query: {
        patterns: [
          {
            graph: expect.objectContaining({
              termType: 'NamedNode',
              value: `${BASE}.data/chat/default/index.ttl`,
            }),
            subject: { variable: 'message' },
            predicate: expect.objectContaining({
              termType: 'NamedNode',
              value: CONTENT,
            }),
            object: { variable: 'content' },
          },
        ],
      },
      template: [
        {
          graph: expect.objectContaining({
            termType: 'NamedNode',
            value: `${BASE}.data/chat/default/index.ttl`,
          }),
          subject: { variable: 'message' },
          predicate: expect.objectContaining({
            termType: 'NamedNode',
            value: CONTENT,
          }),
          object: { variable: 'content' },
        },
      ],
    });
  });

  it('compiles drizzle-solid graph pattern update templates', () => {
    const graph = `${BASE}.data/settings/credentials.ttl`;
    const subject = `${graph}#cred-status-test`;
    const update = {
      type: 'update',
      prefixes: {},
      updates: [
        {
          updateType: 'insertdelete',
          delete: [
            {
              type: 'graph',
              name: { termType: 'NamedNode', value: graph },
              patterns: [
                {
                  type: 'bgp',
                  triples: [
                    {
                      subject: { termType: 'NamedNode', value: subject },
                      predicate: { termType: 'NamedNode', value: CONTENT },
                      object: { termType: 'Variable', value: 'old_status' },
                    },
                  ],
                },
              ],
            },
          ],
          insert: [],
          where: [
            {
              type: 'graph',
              name: { termType: 'NamedNode', value: graph },
              patterns: [
                {
                  type: 'bgp',
                  triples: [
                    {
                      subject: { termType: 'NamedNode', value: subject },
                      predicate: { termType: 'NamedNode', value: CONTENT },
                      object: { termType: 'Variable', value: 'old_status' },
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          updateType: 'insert',
          insert: [
            {
              type: 'graph',
              name: { termType: 'NamedNode', value: graph },
              patterns: [
                {
                  type: 'bgp',
                  triples: [
                    {
                      subject: { termType: 'NamedNode', value: subject },
                      predicate: { termType: 'NamedNode', value: CONTENT },
                      object: {
                        termType: 'Literal',
                        value: 'active',
                        language: '',
                        datatype: {
                          termType: 'NamedNode',
                          value: 'http://www.w3.org/2001/XMLSchema#string',
                        },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const delta = adapter.compileUpdateDelta(update as any, BASE);

    expect(delta.operations).toHaveLength(2);
    expect(delta.operations[0]).toMatchObject({
      type: 'deleteWhere',
      template: [
        {
          graph: expect.objectContaining({ value: graph }),
          subject: expect.objectContaining({ value: subject }),
          predicate: expect.objectContaining({ value: CONTENT }),
          object: { variable: 'old_status' },
        },
      ],
    });
    expect(delta.operations[1]).toMatchObject({
      type: 'insert',
      quads: [
        {
          graph: expect.objectContaining({ value: graph }),
          subject: expect.objectContaining({ value: subject }),
          predicate: expect.objectContaining({ value: CONTENT }),
          object: expect.objectContaining({ value: 'active' }),
        },
      ],
    });
  });

  it('compiles default graph SPARQL UPDATE only when a write target graph is provided', () => {
    const graph = `${BASE}.data/chat/default/index.ttl`;
    expect(() => adapter.compileUpdateDelta(`
      DELETE WHERE {
        <${graph}#msg_1> <${CONTENT}> ?content .
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    const delta = adapter.compileUpdateDelta(`
      DELETE WHERE {
        <${graph}#msg_1> <${CONTENT}> ?content .
      }
    `, BASE, { defaultGraph: graph });

    expect(delta.operations).toHaveLength(1);
    expect(delta.operations[0]).toMatchObject({
      type: 'deleteWhere',
      query: {
        patterns: [
          {
            graph: expect.objectContaining({
              termType: 'NamedNode',
              value: graph,
            }),
            subject: expect.objectContaining({
              termType: 'NamedNode',
              value: `${graph}#msg_1`,
            }),
            predicate: expect.objectContaining({
              termType: 'NamedNode',
              value: CONTENT,
            }),
            object: { variable: 'content' },
          },
        ],
      },
      template: [
        {
          graph: expect.objectContaining({
            termType: 'NamedNode',
            value: graph,
          }),
          subject: expect.objectContaining({
            termType: 'NamedNode',
            value: `${graph}#msg_1`,
          }),
          object: { variable: 'content' },
        },
      ],
    });
  });

  it('compiles default graph DELETE/INSERT WHERE against the explicit write target graph', () => {
    const graph = `${BASE}.data/chat/default/index.ttl`;
    const delta = adapter.compileUpdateDelta(`
      DELETE {
        <${graph}#msg_1> <${CONTENT}> ?old .
      }
      INSERT {
        <${graph}#msg_1> <${CONTENT}> "changed" .
      }
      WHERE {
        <${graph}#msg_1> <${CONTENT}> ?old .
      }
    `, BASE, { defaultGraph: graph });

    expect(delta.operations).toHaveLength(1);
    expect(delta.operations[0]).toMatchObject({
      type: 'insertDeleteWhere',
      query: {
        patterns: [
          {
            graph: expect.objectContaining({
              termType: 'NamedNode',
              value: graph,
            }),
            object: { variable: 'old' },
          },
        ],
      },
      deletes: [
        {
          graph: expect.objectContaining({
            termType: 'NamedNode',
            value: graph,
          }),
          object: { variable: 'old' },
        },
      ],
      inserts: [
        {
          graph: expect.objectContaining({
            termType: 'NamedNode',
            value: graph,
          }),
          object: expect.objectContaining({
            termType: 'Literal',
            value: 'changed',
          }),
        },
      ],
    });
  });

  it('compiles DELETE/INSERT WHERE into a local query-backed update delta', () => {
    const delta = adapter.compileUpdateDelta(`
      DELETE {
        GRAPH <${BASE}.data/chat/default/index.ttl> {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH <${BASE}.data/chat/default/index.ttl> {
          ?message <${CONTENT}> "changed" .
        }
      }
      WHERE {
        GRAPH <${BASE}.data/chat/default/index.ttl> {
          ?message <${CONTENT}> ?old .
        }
      }
    `, BASE);

    expect(delta.inserts).toEqual([]);
    expect(delta.deletes).toEqual([]);
    expect(delta.operations).toHaveLength(1);
    expect(delta.operations[0]).toMatchObject({
      type: 'insertDeleteWhere',
      query: {
        patterns: [
          {
            graph: expect.objectContaining({
              termType: 'NamedNode',
              value: `${BASE}.data/chat/default/index.ttl`,
            }),
            subject: { variable: 'message' },
            predicate: expect.objectContaining({
              termType: 'NamedNode',
              value: CONTENT,
            }),
            object: { variable: 'old' },
          },
        ],
      },
      deletes: [
        {
          subject: { variable: 'message' },
          object: { variable: 'old' },
        },
      ],
      inserts: [
        {
          subject: { variable: 'message' },
          object: expect.objectContaining({
            termType: 'Literal',
            value: 'changed',
          }),
        },
      ],
    });
  });

  it('compiles INSERT WHERE into a local query-backed update delta', () => {
    const delta = adapter.compileUpdateDelta(`
      INSERT {
        GRAPH <${BASE}.data/chat/default/index.ttl> {
          ?message <${CONTENT}> "created from where" .
        }
      }
      WHERE {
        GRAPH <${BASE}.data/chat/default/index.ttl> {
          ?message a <${MESSAGE}> .
        }
      }
    `, BASE);

    expect(delta.inserts).toEqual([]);
    expect(delta.deletes).toEqual([]);
    expect(delta.operations).toHaveLength(1);
    expect(delta.operations[0]).toMatchObject({
      type: 'insertWhere',
      query: {
        patterns: [
          {
            graph: expect.objectContaining({
              termType: 'NamedNode',
              value: `${BASE}.data/chat/default/index.ttl`,
            }),
            subject: { variable: 'message' },
            predicate: expect.objectContaining({
              termType: 'NamedNode',
              value: RDF_TYPE,
            }),
            object: expect.objectContaining({
              termType: 'NamedNode',
              value: MESSAGE,
            }),
          },
        ],
      },
      inserts: [
        {
          subject: { variable: 'message' },
          predicate: expect.objectContaining({
            termType: 'NamedNode',
            value: CONTENT,
          }),
          object: expect.objectContaining({
            termType: 'Literal',
            value: 'created from where',
          }),
        },
      ],
    });
  });

  it('compiles DELETE/INSERT WHERE with BIND in WHERE into a local query-backed update delta', () => {
    const delta = adapter.compileUpdateDelta(`
      DELETE {
        GRAPH <${BASE}.data/chat/default/index.ttl> {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH <${BASE}.data/chat/default/index.ttl> {
          ?message <${CONTENT}> ?next .
        }
      }
      WHERE {
        GRAPH <${BASE}.data/chat/default/index.ttl> {
          ?message <${CONTENT}> ?old .
          BIND(CONCAT(STR(?old), " rewritten") AS ?next)
        }
      }
    `, BASE);

    expect(delta.operations).toHaveLength(1);
    expect(delta.operations[0]).toMatchObject({
      type: 'insertDeleteWhere',
      query: {
        patterns: [
          {
            graph: expect.objectContaining({
              termType: 'NamedNode',
              value: `${BASE}.data/chat/default/index.ttl`,
            }),
            subject: { variable: 'message' },
            predicate: expect.objectContaining({
              termType: 'NamedNode',
              value: CONTENT,
            }),
            object: { variable: 'old' },
          },
        ],
        binds: [
          {
            variable: 'next',
            expression: {
              type: 'concat',
              expressions: [
                {
                  type: 'stringValue',
                  variable: 'old',
                },
                {
                  type: 'term',
                  term: expect.objectContaining({
                    termType: 'Literal',
                    value: ' rewritten',
                  }),
                },
              ],
            },
          },
        ],
      },
      deletes: [
        {
          subject: { variable: 'message' },
          object: { variable: 'old' },
        },
      ],
      inserts: [
        {
          subject: { variable: 'message' },
          object: { variable: 'next' },
        },
      ],
    });
  });

  it('compiles DELETE/INSERT WHERE with controlled UNION branches', () => {
    const delta = adapter.compileUpdateDelta(`
      DELETE {
        GRAPH <${BASE}.data/chat/default/index.ttl> {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH <${BASE}.data/chat/default/index.ttl> {
          ?message <${CONTENT}> "union changed" .
        }
      }
      WHERE {
        {
          GRAPH <${BASE}.data/chat/default/index.ttl> {
            ?message <${CONTENT}> ?old .
            FILTER(?old = "one")
          }
        }
        UNION
        {
          GRAPH <${BASE}.data/chat/default/index.ttl> {
            ?message <${CONTENT}> ?old .
            FILTER(?old = "two")
          }
        }
      }
    `, BASE);

    expect(delta.operations).toHaveLength(1);
    expect(delta.operations[0]).toMatchObject({
      type: 'insertDeleteWhere',
      query: {
        patterns: [],
        unions: [
          {
            branches: [
              {
                patterns: [
                  {
                    graph: expect.objectContaining({
                      termType: 'NamedNode',
                      value: `${BASE}.data/chat/default/index.ttl`,
                    }),
                    subject: { variable: 'message' },
                    predicate: expect.objectContaining({
                      termType: 'NamedNode',
                      value: CONTENT,
                    }),
                    object: { variable: 'old' },
                  },
                ],
                filters: [
                  expect.objectContaining({
                    variable: 'old',
                    operator: '$eq',
                  }),
                ],
              },
              {
                patterns: [
                  {
                    graph: expect.objectContaining({
                      termType: 'NamedNode',
                      value: `${BASE}.data/chat/default/index.ttl`,
                    }),
                    subject: { variable: 'message' },
                    predicate: expect.objectContaining({
                      termType: 'NamedNode',
                      value: CONTENT,
                    }),
                    object: { variable: 'old' },
                  },
                ],
                filters: [
                  expect.objectContaining({
                    variable: 'old',
                    operator: '$eq',
                  }),
                ],
              },
            ],
          },
        ],
      },
      deletes: [
        {
          subject: { variable: 'message' },
          object: { variable: 'old' },
        },
      ],
      inserts: [
        {
          subject: { variable: 'message' },
          object: expect.objectContaining({
            termType: 'Literal',
            value: 'union changed',
          }),
        },
      ],
    });
  });

  it('compiles DELETE/INSERT WHERE with fixed-length property paths in WHERE', () => {
    const graph = `${BASE}.data/chat/default/index.ttl`;
    const thread = `${graph}#thread_1`;
    const delta = adapter.compileUpdateDelta(`
      DELETE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH <${graph}> {
          ?message <${CONTENT}> "path changed" .
        }
      }
      WHERE {
        GRAPH <${graph}> {
          <${thread}> ^<${HAS_MEMBER}>/<${CONTENT}> ?old .
          <${thread}> ^<${HAS_MEMBER}> ?message .
          ?message <${CONTENT}> ?old .
        }
      }
    `, BASE);

    const operation = delta.operations[0];
    expect(operation.type).toBe('insertDeleteWhere');
    if (operation.type !== 'insertDeleteWhere') {
      throw new Error(`Unexpected operation type: ${operation.type}`);
    }

    expect(operation.query.patterns).toHaveLength(4);
    expect(operation.query.patterns[0]).toMatchObject({
      graph: expect.objectContaining({
        termType: 'NamedNode',
        value: graph,
      }),
      subject: { variable: '__rdf_path_1' },
      object: expect.objectContaining({
        termType: 'NamedNode',
        value: thread,
      }),
    });
    expect(operation.query.patterns[1]).toMatchObject({
      subject: { variable: '__rdf_path_1' },
      object: { variable: 'old' },
    });
    expect(operation.query.patterns[2]).toMatchObject({
      subject: { variable: 'message' },
      object: expect.objectContaining({
        termType: 'NamedNode',
        value: thread,
      }),
    });
    expect(operation.query.patterns[3]).toMatchObject({
      subject: { variable: 'message' },
      object: { variable: 'old' },
    });
    expect(termToId(operation.query.patterns[0].predicate as any)).toBe(HAS_MEMBER);
    expect(termToId(operation.query.patterns[1].predicate as any)).toBe(CONTENT);
    expect(termToId(operation.query.patterns[2].predicate as any)).toBe(HAS_MEMBER);
    expect(termToId(operation.query.patterns[3].predicate as any)).toBe(CONTENT);
    expect(operation.inserts[0]).toMatchObject({
      subject: { variable: 'message' },
      object: expect.objectContaining({
        termType: 'Literal',
        value: 'path changed',
      }),
    });
  });

  it('compiles WITH-scoped DELETE/INSERT WHERE into an explicit graph delta', () => {
    const graph = `${BASE}.data/chat/default/index.ttl`;
    const delta = adapter.compileUpdateDelta(`
      WITH <${graph}>
      DELETE {
        ?message <${CONTENT}> ?old .
      }
      INSERT {
        ?message <${CONTENT}> "with changed" .
      }
      WHERE {
        ?message <${CONTENT}> ?old .
      }
    `, BASE);

    const operation = delta.operations[0];
    expect(operation.type).toBe('insertDeleteWhere');
    if (operation.type !== 'insertDeleteWhere') {
      throw new Error(`Unexpected operation type: ${operation.type}`);
    }
    expect(operation.query.patterns).toEqual([
      expect.objectContaining({
        graph: expect.objectContaining({
          termType: 'NamedNode',
          value: graph,
        }),
        subject: { variable: 'message' },
        predicate: expect.objectContaining({
          termType: 'NamedNode',
          value: CONTENT,
        }),
        object: { variable: 'old' },
      }),
    ]);
    expect(operation.deletes[0]).toMatchObject({
      graph: expect.objectContaining({
        termType: 'NamedNode',
        value: graph,
      }),
      subject: { variable: 'message' },
      object: { variable: 'old' },
    });
    expect(operation.inserts[0]).toMatchObject({
      graph: expect.objectContaining({
        termType: 'NamedNode',
        value: graph,
      }),
      subject: { variable: 'message' },
      object: expect.objectContaining({
        termType: 'Literal',
        value: 'with changed',
      }),
    });
  });

  it('compiles WITH-scoped DELETE WHERE and INSERT WHERE variants', () => {
    const graph = `${BASE}.data/chat/default/index.ttl`;
    const deleteOnly = adapter.compileUpdateDelta(`
      WITH <${graph}>
      DELETE {
        ?message <${CONTENT}> ?old .
      }
      WHERE {
        ?message <${CONTENT}> ?old .
      }
    `, BASE);
    const insertOnly = adapter.compileUpdateDelta(`
      WITH <${graph}>
      INSERT {
        ?message <${CONTENT}> "with created" .
      }
      WHERE {
        ?message a <${MESSAGE}> .
      }
    `, BASE);

    expect(deleteOnly.operations[0]).toMatchObject({
      type: 'deleteWhere',
      query: {
        patterns: [
          {
            graph: expect.objectContaining({
              termType: 'NamedNode',
              value: graph,
            }),
            subject: { variable: 'message' },
            object: { variable: 'old' },
          },
        ],
      },
      template: [
        {
          graph: expect.objectContaining({
            termType: 'NamedNode',
            value: graph,
          }),
          subject: { variable: 'message' },
          object: { variable: 'old' },
        },
      ],
    });
    expect(insertOnly.operations[0]).toMatchObject({
      type: 'insertWhere',
      query: {
        patterns: [
          {
            graph: expect.objectContaining({
              termType: 'NamedNode',
              value: graph,
            }),
            subject: { variable: 'message' },
            predicate: expect.objectContaining({
              termType: 'NamedNode',
              value: RDF_TYPE,
            }),
          },
        ],
      },
      inserts: [
        {
          graph: expect.objectContaining({
            termType: 'NamedNode',
            value: graph,
          }),
          subject: { variable: 'message' },
          object: expect.objectContaining({
            termType: 'Literal',
            value: 'with created',
          }),
        },
      ],
    });
  });

  it('compiles single USING default graph into the local update WHERE scope', () => {
    const graph = `${BASE}.data/chat/default/index.ttl`;
    const delta = adapter.compileUpdateDelta(`
      DELETE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH <${graph}> {
          ?message <${CONTENT}> "using changed" .
        }
      }
      USING <${graph}>
      WHERE {
        ?message <${CONTENT}> ?old .
      }
    `, BASE);

    const operation = delta.operations[0];
    expect(operation.type).toBe('insertDeleteWhere');
    if (operation.type !== 'insertDeleteWhere') {
      throw new Error(`Unexpected operation type: ${operation.type}`);
    }
    expect(operation.query.patterns).toEqual([
      expect.objectContaining({
        graph: expect.objectContaining({
          termType: 'NamedNode',
          value: graph,
        }),
        subject: { variable: 'message' },
        predicate: expect.objectContaining({
          termType: 'NamedNode',
          value: CONTENT,
        }),
        object: { variable: 'old' },
      }),
    ]);
    expect(operation.deletes[0]).toMatchObject({
      graph: expect.objectContaining({
        termType: 'NamedNode',
        value: graph,
      }),
      subject: { variable: 'message' },
      object: { variable: 'old' },
    });
    expect(operation.inserts[0]).toMatchObject({
      graph: expect.objectContaining({
        termType: 'NamedNode',
        value: graph,
      }),
      subject: { variable: 'message' },
      object: expect.objectContaining({
        termType: 'Literal',
        value: 'using changed',
      }),
    });
  });

  it('compiles multiple USING default graphs into the local update WHERE scope', () => {
    const targetGraph = `${BASE}.data/chat/default/index.ttl`;
    const otherGraph = `${BASE}.data/chat/default/other.ttl`;
    const delta = adapter.compileUpdateDelta(`
      INSERT {
        GRAPH <${targetGraph}> {
          ?message <${CONTENT}> "multi using changed" .
        }
      }
      USING <${targetGraph}>
      USING <${otherGraph}>
      WHERE {
        ?message <${CONTENT}> ?old .
      }
    `, BASE);

    const operation = delta.operations[0];
    expect(operation.type).toBe('insertWhere');
    if (operation.type !== 'insertWhere') {
      throw new Error(`Unexpected operation type: ${operation.type}`);
    }
    expect(operation.query.patterns).toEqual([
      expect.objectContaining({
        graph: {
          $in: [
            expect.objectContaining({
              termType: 'NamedNode',
              value: targetGraph,
            }),
            expect.objectContaining({
              termType: 'NamedNode',
              value: otherGraph,
            }),
          ],
        },
        subject: { variable: 'message' },
        predicate: expect.objectContaining({
          termType: 'NamedNode',
          value: CONTENT,
        }),
        object: { variable: 'old' },
      }),
    ]);
    expect(operation.inserts[0]).toMatchObject({
      graph: expect.objectContaining({
        termType: 'NamedNode',
        value: targetGraph,
      }),
      subject: { variable: 'message' },
      object: expect.objectContaining({
        termType: 'Literal',
        value: 'multi using changed',
      }),
    });
  });

  it('compiles USING NAMED graphs into GRAPH variable update WHERE scope', () => {
    const targetGraph = `${BASE}.data/chat/default/index.ttl`;
    const namedGraphA = `${BASE}.data/chat/default/a.ttl`;
    const namedGraphB = `${BASE}.data/chat/default/b.ttl`;
    const delta = adapter.compileUpdateDelta(`
      INSERT {
        GRAPH <${targetGraph}> {
          ?message <${HAS_MEMBER}> ?g .
        }
      }
      USING NAMED <${namedGraphA}>
      USING NAMED <${namedGraphB}>
      WHERE {
        GRAPH ?g {
          ?message <${CONTENT}> ?old .
        }
      }
    `, BASE);

    const operation = delta.operations[0];
    expect(operation.type).toBe('insertWhere');
    if (operation.type !== 'insertWhere') {
      throw new Error(`Unexpected operation type: ${operation.type}`);
    }
    expect(operation.query.patterns).toEqual([
      expect.objectContaining({
        graph: { variable: 'g' },
        subject: { variable: 'message' },
        predicate: expect.objectContaining({
          termType: 'NamedNode',
          value: CONTENT,
        }),
        object: { variable: 'old' },
      }),
    ]);
    expect(operation.query.filters).toEqual([
      {
        variable: 'g',
        operator: '$in',
        values: [
          expect.objectContaining({
            termType: 'NamedNode',
            value: namedGraphA,
          }),
          expect.objectContaining({
            termType: 'NamedNode',
            value: namedGraphB,
          }),
        ],
      },
    ]);
    expect(operation.inserts[0]).toMatchObject({
      graph: expect.objectContaining({
        termType: 'NamedNode',
        value: targetGraph,
      }),
      subject: { variable: 'message' },
      object: { variable: 'g' },
    });
  });

  it('compiles finite GRAPH variable update templates', () => {
    const namedGraphA = `${BASE}.data/chat/default/a.ttl`;
    const namedGraphB = `${BASE}.data/chat/default/b.ttl`;
    const delta = adapter.compileUpdateDelta(`
      DELETE {
        GRAPH ?g {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH ?g {
          ?message <${CONTENT}> "rewritten by graph var" .
        }
      }
      USING NAMED <${namedGraphA}>
      USING NAMED <${namedGraphB}>
      WHERE {
        GRAPH ?g {
          ?message <${CONTENT}> ?old .
        }
      }
    `, BASE);

    const operation = delta.operations[0];
    expect(operation.type).toBe('insertDeleteWhere');
    if (operation.type !== 'insertDeleteWhere') {
      throw new Error(`Unexpected operation type: ${operation.type}`);
    }
    expect(operation.query.filters).toEqual([
      {
        variable: 'g',
        operator: '$in',
        values: [
          expect.objectContaining({
            termType: 'NamedNode',
            value: namedGraphA,
          }),
          expect.objectContaining({
            termType: 'NamedNode',
            value: namedGraphB,
          }),
        ],
      },
    ]);
    expect(operation.deletes[0]).toMatchObject({
      graph: { variable: 'g' },
      subject: { variable: 'message' },
      object: { variable: 'old' },
    });
    expect(operation.inserts[0]).toMatchObject({
      graph: { variable: 'g' },
      subject: { variable: 'message' },
      object: expect.objectContaining({
        termType: 'Literal',
        value: 'rewritten by graph var',
      }),
    });
  });

  it('compiles GRAPH variable update templates constrained by explicit graph filters', () => {
    const namedGraphA = `${BASE}.data/chat/default/a.ttl`;
    const namedGraphB = `${BASE}.data/chat/default/b.ttl`;
    const delta = adapter.compileUpdateDelta(`
      DELETE {
        GRAPH ?g {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH ?g {
          ?message <${CONTENT}> "rewritten by explicit graph filter" .
        }
      }
      WHERE {
        GRAPH ?g {
          ?message <${CONTENT}> ?old .
        }
        FILTER(?g IN (<${namedGraphA}>, <${namedGraphB}>))
      }
    `, BASE);

    const operation = delta.operations[0];
    expect(operation.type).toBe('insertDeleteWhere');
    if (operation.type !== 'insertDeleteWhere') {
      throw new Error(`Unexpected operation type: ${operation.type}`);
    }
    expect(operation.query.filters).toEqual(expect.arrayContaining([
      {
        variable: 'g',
        operator: '$startsWith',
        value: BASE,
      },
      {
        variable: 'g',
        operator: '$in',
        values: [
          expect.objectContaining({
            termType: 'NamedNode',
            value: namedGraphA,
          }),
          expect.objectContaining({
            termType: 'NamedNode',
            value: namedGraphB,
          }),
        ],
      },
    ]));
    expect(operation.deletes[0]).toMatchObject({
      graph: { variable: 'g' },
      subject: { variable: 'message' },
      object: { variable: 'old' },
    });
    expect(operation.inserts[0]).toMatchObject({
      graph: { variable: 'g' },
      subject: { variable: 'message' },
      object: expect.objectContaining({
        termType: 'Literal',
        value: 'rewritten by explicit graph filter',
      }),
    });
  });

  it('rejects update shapes that cannot be safely applied as embedded deltas', () => {
    expect(() => adapter.compileUpdateDelta(`
      INSERT DATA {
        <${BASE}.data/chat/default/index.ttl#msg_3> <${CONTENT}> "created" .
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compileUpdateDelta(`
      INSERT DATA {
        GRAPH <https://external.example/data.ttl> {
          <https://external.example/data.ttl#msg_3> <${CONTENT}> "created" .
        }
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compileUpdateDelta(`
      DELETE WHERE {
        GRAPH ?g {
          ?s <${CONTENT}> ?o .
        }
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compileUpdateDelta(`
      DELETE WHERE {
        GRAPH <https://external.example/data.ttl> {
          ?s <${CONTENT}> ?o .
        }
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compileUpdateDelta(`
      DELETE {
        GRAPH ?g {
          ?s <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH ?g {
          ?s <${CONTENT}> "changed" .
        }
      }
      WHERE {
        GRAPH ?g {
          ?s <${CONTENT}> ?old .
        }
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compileUpdateDelta(`
      INSERT {
        GRAPH <${BASE}.data/chat/default/index.ttl> {
          ?s <${CONTENT}> "changed" .
        }
      }
      WHERE {
        {
          GRAPH <${BASE}.data/chat/default/index.ttl> {
            ?s <${CONTENT}> "one" .
          }
        }
        UNION
        {
          GRAPH <${BASE}.data/chat/default/index.ttl> {
            ?s <${CONTENT}> "two" .
          }
        }
      }
    `, 'https://external.example/')).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compileUpdateDelta(`
      WITH <https://external.example/data.ttl>
      DELETE {
        ?s <${CONTENT}> ?old .
      }
      INSERT {
        ?s <${CONTENT}> "changed" .
      }
      WHERE {
        ?s <${CONTENT}> ?old .
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compileUpdateDelta(`
      INSERT {
        GRAPH <${BASE}.data/chat/default/index.ttl> {
          ?s <${CONTENT}> "changed" .
        }
      }
      USING NAMED <https://external.example/data.ttl>
      WHERE {
        GRAPH ?g {
          ?s <${CONTENT}> ?old .
        }
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compileUpdateDelta(`
      DELETE {
        GRAPH ?g {
          ?s <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH ?g {
          ?s <${CONTENT}> "changed" .
        }
      }
      WHERE {
        GRAPH ?g {
          ?s <${CONTENT}> ?old .
        }
        FILTER(?g IN (<${BASE}.data/chat/default/a.ttl>, <https://external.example/data.ttl>))
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compileUpdateDelta(`
      DELETE {
        GRAPH <${BASE}.data/chat/default/index.ttl> {
          ?s <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH <${BASE}.data/chat/default/index.ttl> {
          ?s <${CONTENT}> "changed" .
        }
      }
      USING <https://external.example/data.ttl>
      WHERE {
        ?s <${CONTENT}> ?old .
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);
  });

  it('rejects unsafe MINUS shapes outside the embedded subset', () => {
    expect(() => adapter.compile(`
      SELECT ?message WHERE {
        ?message a <${MESSAGE}> .
        MINUS {
          ?other <${CONTENT}> ?content .
        }
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compile(`
      SELECT ?message WHERE {
        ?message a <${MESSAGE}> .
        MINUS {
          {
            ?other <${CONTENT}> ?content .
          }
          UNION
          {
            ?other <${HAS_MEMBER}> ?thread .
          }
        }
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);
  });

  it('rejects unsafe FILTER EXISTS shapes outside the embedded subset', () => {
    expect(() => adapter.compile(`
      SELECT ?message WHERE {
        ?message a <${MESSAGE}> .
        FILTER NOT EXISTS {
          ?other <${CONTENT}> ?content .
        }
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compile(`
      SELECT ?message WHERE {
        ?message a <${MESSAGE}> .
        FILTER EXISTS {
          ?other <${CONTENT}> ?content .
        }
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compile(`
      SELECT ?message WHERE {
        ?message a <${MESSAGE}> .
        OPTIONAL {
          FILTER EXISTS {
            ?other <${CONTENT}> ?content .
          }
        }
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);
  });

  it('rejects grouped query shapes outside the embedded subset', () => {
    expect(() => adapter.compile(`
      SELECT ?thread (SUM(?message) AS ?count) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
      }
      GROUP BY ?thread
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    const groupedWildcard = new Parser({ baseIRI: BASE }).parse(`
      SELECT ?thread (COUNT(?message) AS ?count) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
      }
      GROUP BY ?thread
    `) as any;
    groupedWildcard.variables = [new Wildcard()];
    expect(() => adapter.compile(groupedWildcard, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compile(`
      SELECT ?thread (COUNT(?message) AS ?count) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
      }
      GROUP BY ?thread
      HAVING (?thread > 1)
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compile(`
      SELECT ?thread (STR(?thread) AS ?threadKey) (COUNT(?message) AS ?count) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
      }
      GROUP BY ?thread
    `, BASE)).toThrow(UnsupportedSparqlQueryError);
  });

  it('compiles SELECT DISTINCT without falling back to the compatibility engine', () => {
    const compiled = adapter.compile(`
      SELECT DISTINCT ?message WHERE {
        ?message a <${MESSAGE}> .
      }
      ORDER BY ?message
    `, BASE);

    expect(compiled.query.distinct).toBe(true);
    expect(compiled.query.select).toEqual(['message']);
    expect(compiled.query.orderBy).toEqual([{ variable: 'message', direction: 'asc' }]);
  });

  it('compiles SELECT REDUCED as a regular local SELECT', () => {
    const compiled = adapter.compile(`
      SELECT REDUCED ?message WHERE {
        ?message a <${MESSAGE}> .
      }
      ORDER BY ?message
    `, BASE);

    expect(compiled.queryType).toBe('SELECT');
    expect(compiled.variables).toEqual(['message']);
    expect(compiled.query.distinct).not.toBe(true);
    expect(compiled.query.select).toEqual(['message']);
    expect(compiled.query.orderBy).toEqual([{ variable: 'message', direction: 'asc' }]);
  });

  it('compiles negated BOUND filters for OPTIONAL anti-join queries', () => {
    const compiled = adapter.compile(`
      SELECT ?message WHERE {
        ?message a <${MESSAGE}> .
        OPTIONAL {
          ?message <${CONTENT}> ?content .
        }
        FILTER(!BOUND(?content))
      }
    `, BASE);

    expect(compiled.query.patterns).toHaveLength(1);
    expect(compiled.query.optional).toHaveLength(1);
    expect(compiled.query.filters).toContainEqual({
      variable: 'content',
      operator: '$bound',
      value: false,
    });
  });

  it('compiles FILTER inside OPTIONAL as an optional-local filter', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?content WHERE {
        ?message a <${MESSAGE}> .
        OPTIONAL {
          ?message <${CONTENT}> ?content .
          FILTER(CONTAINS(STR(?content), "ell"))
        }
      }
    `, BASE);

    expect(compiled.query.filters).toEqual([]);
    expect(compiled.query.optional).toHaveLength(1);
    expect(compiled.query.optional?.[0]).toMatchObject({
      filters: [
        {
          variable: 'content',
          operator: '$contains',
          operand: 'stringValue',
          value: 'ell',
        },
      ],
    });
  });

  it('compiles BIND inside OPTIONAL as an optional-local binding', () => {
    const compiled = adapter.compile(`
      SELECT ?message ?contentLabel WHERE {
        ?message a <${MESSAGE}> .
        OPTIONAL {
          ?message <${CONTENT}> ?content .
          BIND(CONCAT(STR(?content), "-optional") AS ?contentLabel)
        }
      }
      ORDER BY ?message
    `, BASE);

    expect(compiled.query.optional).toHaveLength(1);
    expect(compiled.query.optional?.[0]).toMatchObject({
      patterns: [
        expect.objectContaining({
          subject: { variable: 'message' },
          object: { variable: 'content' },
        }),
      ],
      binds: [
        {
          variable: 'contentLabel',
          expression: {
            type: 'concat',
            expressions: [
              { type: 'stringValue', variable: 'content' },
              {
                type: 'term',
                term: expect.objectContaining({
                  termType: 'Literal',
                  value: '-optional',
                }),
              },
            ],
          },
        },
      ],
    });
    expect(compiled.variables).toEqual(['message', 'contentLabel']);
  });

  it('compiles single-variable VALUES into a local IN filter', () => {
    const msg1 = `${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1`;
    const msg2 = `${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_2`;
    const compiled = adapter.compile(`
      SELECT ?message WHERE {
        VALUES ?message { <${msg1}> <${msg2}> }
        ?message a <${MESSAGE}> .
      }
      ORDER BY ?message
    `, BASE);

    expect(compiled.query.filters).toHaveLength(1);
    expect(compiled.query.filters?.[0]).toMatchObject({
      variable: 'message',
      operator: '$in',
      source: 'values',
    });
    expect(compiled.query.filters?.[0].values?.map((value: any) => value.value)).toEqual([msg1, msg2]);
  });

  it('compiles trailing single-variable VALUES when it constrains a required pattern variable', () => {
    const msg1 = `${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1`;
    const compiled = adapter.compile(`
      SELECT ?message WHERE {
        ?message a <${MESSAGE}> .
      }
      VALUES ?message { <${msg1}> }
    `, BASE);

    expect(compiled.query.filters).toContainEqual(expect.objectContaining({
      variable: 'message',
      operator: '$in',
      source: 'values',
    }));
  });

  it('compiles tuple VALUES as a correlated local binding source', () => {
    const msg1 = `${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1`;
    const msg2 = `${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_2`;
    const compiled = adapter.compile(`
      SELECT ?message ?kind WHERE {
        VALUES (?message ?kind) {
          (<${msg1}> <${MESSAGE}>)
          (<${msg2}> <${CONTENT}>)
        }
        ?message a ?kind .
      }
      ORDER BY ?message
    `, BASE);

    expect(compiled.query.values).toHaveLength(1);
    expect(compiled.query.values?.[0].variables).toEqual(['kind', 'message']);
    expect(compiled.query.values?.[0].rows.map((row) => ({
      kind: (row.kind as any).value,
      message: (row.message as any).value,
    }))).toEqual([
      { kind: MESSAGE, message: msg1 },
      { kind: CONTENT, message: msg2 },
    ]);
  });

  it('compiles VALUES UNDEF as an unbound row in the local binding source', () => {
    const msg1 = `${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1`;
    const compiled = adapter.compile(`
      SELECT ?message WHERE {
        VALUES ?message { UNDEF <${msg1}> }
        ?message a <${MESSAGE}> .
      }
      ORDER BY ?message
    `, BASE);

    expect(compiled.query.values).toHaveLength(1);
    expect(compiled.query.values?.[0].variables).toEqual(['message']);
    expect(compiled.query.values?.[0].rows.map((row) => row.message ? (row.message as any).value : undefined)).toEqual([
      undefined,
      msg1,
    ]);
    expect(compiled.query.filters).toEqual([]);
  });

  it('compiles VALUES inside OPTIONAL as an optional-local binding source', () => {
    const msg1 = `${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1`;
    const compiled = adapter.compile(`
      SELECT ?message ?tag ?content WHERE {
        ?message a <${MESSAGE}> .
        OPTIONAL {
          VALUES (?message ?tag) {
            (<${msg1}> "selected")
          }
          ?message <${CONTENT}> ?content .
        }
      }
    `, BASE);

    expect(compiled.query.values).toBeUndefined();
    expect(compiled.query.filters).toEqual([]);
    expect(compiled.query.optional).toHaveLength(1);
    const optional = compiled.query.optional?.[0];
    expect(Array.isArray(optional)).toBe(false);
    expect(optional).toMatchObject({
      values: [
        {
          variables: ['message', 'tag'],
        },
      ],
    });
    expect((optional as any).values[0].rows.map((row: any) => ({
      message: row.message?.value,
      tag: row.tag?.value,
    }))).toEqual([
      {
        message: msg1,
        tag: 'selected',
      },
    ]);
  });

  it('falls back for unsupported SPARQL shapes instead of returning partial results', () => {
    expect(() => adapter.compile(`
      SELECT ?s WHERE { OPTIONAL { GRAPH ?g { ?s ?p ?o } } }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compile(`
      SELECT ?message WHERE {
        VALUES ?message { <${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1> }
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compile(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
        FILTER(?content = "hello" || CONTAINS(STR(?content), "ell"))
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compile(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
        FILTER(?content = "hello" || ?message = <${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1>)
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compile(`
      SELECT ?s WHERE {
        ?s a <${MESSAGE}> .
        OPTIONAL {
          ?s <${CONTENT}> ?value .
          MINUS {
            ?s <${HAS_MEMBER}> ?thread .
            FILTER EXISTS {
              ?thread <${CONTENT}> ?threadContent .
            }
          }
        }
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compile(`
      SELECT ?content WHERE {
        ?message <${HAS_MEMBER}>* ?thread .
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compile(`
      SELECT ?value WHERE {
        ?message (<${HAS_MEMBER}>/<${CONTENT}>|<${CONTENT}>)/<${CONTENT}> ?value .
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);

    expect(() => adapter.compile(`
      DESCRIBE ?message WHERE {
        OPTIONAL {
          ?message a <${MESSAGE}> .
        }
      }
    `, BASE)).toThrow(UnsupportedSparqlQueryError);
  });

  it('rejects SERVICE federation instead of treating it as a compatibility fallback', () => {
    expect(() => adapter.compile(`
      SELECT ?message WHERE {
        SERVICE <https://remote.example/sparql> {
          ?message <${CONTENT}> ?content .
        }
      }
    `, BASE)).toThrow(DisabledSparqlFeatureError);

    expect(() => adapter.compileUpdateDelta(`
      INSERT {
        GRAPH <${BASE}.data/chat/default/index.ttl> {
          ?message <${CONTENT}> "copied" .
        }
      }
      WHERE {
        SERVICE <https://remote.example/sparql> {
          ?message <${CONTENT}> ?content .
        }
      }
    `, BASE)).toThrow(DisabledSparqlFeatureError);
  });

  it('rejects FROM outside the server-owned Pod instead of treating it as federation', () => {
    expect(() => adapter.compile(`
      SELECT ?message
      FROM <https://remote.example/data.ttl>
      WHERE {
        ?message <${CONTENT}> ?content .
      }
    `, BASE)).toThrow(DisabledSparqlFeatureError);

    expect(() => adapter.compile(`
      SELECT ?message
      FROM NAMED <https://remote.example/data.ttl>
      WHERE {
        GRAPH ?g {
          ?message <${CONTENT}> ?content .
        }
      }
    `, BASE)).toThrow(DisabledSparqlFeatureError);
  });
});
