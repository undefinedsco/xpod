import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataFactory } from 'n3';
import { SqliteQuintStore } from '../../src/storage/quint';
import { QuintstoreSparqlEngine } from '../../src/storage/sparql/CompatibilitySparqlEngine';
import {
  RdfQuadIndex,
  SolidRdfEngine,
  SolidRdfSparqlEngine,
} from '../../src/storage/rdf';
import { arrayFromStream } from '../helpers/arrayFromStream';

const { namedNode, literal, quad } = DataFactory;

const BASE = 'https://pod.example/alice/';
const GRAPH = `${BASE}w3c/basic.ttl`;
const NAMED_GRAPH = `${BASE}w3c/named.ttl`;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const PERSON = 'http://xmlns.com/foaf/0.1/Person';
const NAME = 'http://xmlns.com/foaf/0.1/name';
const AGE = 'http://xmlns.com/foaf/0.1/age';
const KNOWS = 'http://xmlns.com/foaf/0.1/knows';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const STATUS = 'https://undefineds.co/ns#status';

describe('SolidRdfSparqlEngine W3C target subset', () => {
  let rdfEngine: SolidRdfEngine;
  let compatibilityStore: SqliteQuintStore;
  let fallback: QuintstoreSparqlEngine;
  let engine: SolidRdfSparqlEngine;

  beforeEach(async () => {
    rdfEngine = new SolidRdfEngine({
      index: new RdfQuadIndex({ path: ':memory:' }),
      autoOpen: true,
    });
    compatibilityStore = new SqliteQuintStore({ path: ':memory:' });
    fallback = new QuintstoreSparqlEngine(compatibilityStore);
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      vi.fn(),
    );

    rdfEngine.put([
      q(`${GRAPH}#alice`, RDF_TYPE, namedNode(PERSON)),
      q(`${GRAPH}#alice`, NAME, literal('Alice')),
      q(`${GRAPH}#alice`, AGE, literal('13', namedNode(XSD_INTEGER))),
      q(`${GRAPH}#alice`, KNOWS, namedNode(`${GRAPH}#bob`)),
      q(`${GRAPH}#bob`, RDF_TYPE, namedNode(PERSON)),
      q(`${GRAPH}#bob`, NAME, literal('Bob')),
    ]);
  });

  afterEach(async () => {
    await engine.close();
  });

  it('covers SELECT BGP, OPTIONAL, FILTER, ORDER BY, and LIMIT without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');

    const stream = await engine.queryBindings(`
      SELECT ?person ?name ?age WHERE {
        ?person a <${PERSON}> .
        ?person <${NAME}> ?name .
        OPTIONAL {
          ?person <${AGE}> ?age .
          FILTER(?age >= 13)
        }
        FILTER(STRSTARTS(STR(?person), "${BASE}w3c/"))
      }
      ORDER BY ?name
      LIMIT 2
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      person: binding.get('person')?.value,
      name: binding.get('name')?.value,
      age: binding.get('age')?.value ?? null,
    }))).toEqual([
      {
        person: `${GRAPH}#alice`,
        name: 'Alice',
        age: '13',
      },
      {
        person: `${GRAPH}#bob`,
        name: 'Bob',
        age: null,
      },
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      totalCount: 1,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers OPTIONAL GRAPH variable scope without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');

    const stream = await engine.queryBindings(`
      SELECT ?person ?name ?ageGraph ?age WHERE {
        ?person <${NAME}> ?name .
        OPTIONAL {
          GRAPH ?ageGraph {
            ?person <${AGE}> ?age .
          }
        }
      }
      ORDER BY ?person
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      person: binding.get('person')?.value,
      name: binding.get('name')?.value,
      ageGraph: binding.get('ageGraph')?.value ?? null,
      age: binding.get('age')?.value ?? null,
    }))).toEqual([
      {
        person: `${GRAPH}#alice`,
        name: 'Alice',
        ageGraph: GRAPH,
        age: '13',
      },
      {
        person: `${GRAPH}#bob`,
        name: 'Bob',
        ageGraph: null,
        age: null,
      },
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      totalCount: 1,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers FROM and FROM NAMED dataset scopes without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    rdfEngine.put([
      q(`${NAMED_GRAPH}#carol`, RDF_TYPE, namedNode(PERSON), NAMED_GRAPH),
      q(`${NAMED_GRAPH}#carol`, NAME, literal('Carol'), NAMED_GRAPH),
    ]);

    let stream = await engine.queryBindings(`
      SELECT ?person ?name
      FROM <${GRAPH}>
      WHERE {
        ?person <${NAME}> ?name .
      }
      ORDER BY ?person
    `, BASE);
    let results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      person: binding.get('person')?.value,
      name: binding.get('name')?.value,
    }))).toEqual([
      {
        person: `${GRAPH}#alice`,
        name: 'Alice',
      },
      {
        person: `${GRAPH}#bob`,
        name: 'Bob',
      },
    ]);

    stream = await engine.queryBindings(`
      SELECT ?graph ?person ?name
      FROM NAMED <${NAMED_GRAPH}>
      WHERE {
        GRAPH ?graph {
          ?person <${NAME}> ?name .
        }
      }
    `, BASE);
    results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      graph: binding.get('graph')?.value,
      person: binding.get('person')?.value,
      name: binding.get('name')?.value,
    }))).toEqual([
      {
        graph: NAMED_GRAPH,
        person: `${NAMED_GRAPH}#carol`,
        name: 'Carol',
      },
    ]);

    stream = await engine.queryBindings(`
      SELECT ?person ?name
      FROM NAMED <${NAMED_GRAPH}>
      WHERE {
        ?person <${NAME}> ?name .
      }
    `, BASE);
    results = await arrayFromStream(stream);

    expect(results).toEqual([]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 3,
      fallbackCount: 0,
      totalCount: 3,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 0,
      },
    });
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers CONCAT BIND expressions without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');

    const stream = await engine.queryBindings(`
      SELECT ?person ?label WHERE {
        ?person <${NAME}> ?name .
        BIND(CONCAT(STR(?person), ":", STR(?name)) AS ?label)
      }
      ORDER BY ?person
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('label')?.value)).toEqual([
      `${GRAPH}#alice:Alice`,
      `${GRAPH}#bob:Bob`,
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      totalCount: 1,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers SELECT expression aliases without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');

    const stream = await engine.queryBindings(`
      SELECT ?person (STR(?person) AS ?personKey) (CONCAT(STR(?person), ":", STR(?name)) AS ?label) WHERE {
        ?person <${NAME}> ?name .
      }
      ORDER BY ?personKey
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      person: binding.get('person')?.value,
      personKey: binding.get('personKey')?.value,
      label: binding.get('label')?.value,
    }))).toEqual([
      {
        person: `${GRAPH}#alice`,
        personKey: `${GRAPH}#alice`,
        label: `${GRAPH}#alice:Alice`,
      },
      {
        person: `${GRAPH}#bob`,
        personKey: `${GRAPH}#bob`,
        label: `${GRAPH}#bob:Bob`,
      },
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      totalCount: 1,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers substring expression aliases without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');

    const stream = await engine.queryBindings(`
      PREFIX fn: <http://www.w3.org/2005/xpath-functions#>
      SELECT ?person (SUBSTR(STR(?name), 1, 2) AS ?prefix) (fn:substring(STR(?name), 3) AS ?suffix) WHERE {
        ?person <${NAME}> ?name .
      }
      ORDER BY ?person
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      person: binding.get('person')?.value,
      prefix: binding.get('prefix')?.value,
      suffix: binding.get('suffix')?.value,
    }))).toEqual([
      {
        person: `${GRAPH}#alice`,
        prefix: 'Al',
        suffix: 'ice',
      },
      {
        person: `${GRAPH}#bob`,
        prefix: 'Bo',
        suffix: 'b',
      },
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      totalCount: 1,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers lowercase and uppercase BIND expressions without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');

    const stream = await engine.queryBindings(`
      SELECT ?person ?lower ?upper WHERE {
        ?person <${NAME}> ?name .
        BIND(LCASE(STR(?name)) AS ?lower)
        BIND(UCASE(STR(?name)) AS ?upper)
      }
      ORDER BY ?person
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      lower: binding.get('lower')?.value,
      upper: binding.get('upper')?.value,
    }))).toEqual([
      { lower: 'alice', upper: 'ALICE' },
      { lower: 'bob', upper: 'BOB' },
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      totalCount: 1,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers COALESCE, IF, STRDT, and STRLANG expression aliases without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');

    const stream = await engine.queryBindings(`
      SELECT ?person ?safeName ?personKey ?typedName ?localizedName WHERE {
        ?person <${NAME}> ?name .
        BIND(COALESCE(STR(?name), "unknown") AS ?safeName)
        BIND(IF(BOUND(?name), STR(?person), "missing") AS ?personKey)
        BIND(STRDT(STR(?name), <http://www.w3.org/2001/XMLSchema#string>) AS ?typedName)
        BIND(STRLANG(STR(?name), "en") AS ?localizedName)
      }
      ORDER BY ?person
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      person: binding.get('person')?.value,
      safeName: binding.get('safeName')?.value,
      personKey: binding.get('personKey')?.value,
      typedName: {
        value: binding.get('typedName')?.value,
        datatype: binding.get('typedName')?.termType === 'Literal'
          ? binding.get('typedName')?.datatype.value
          : undefined,
      },
      localizedName: {
        value: binding.get('localizedName')?.value,
        language: binding.get('localizedName')?.termType === 'Literal'
          ? binding.get('localizedName')?.language
          : undefined,
      },
    }))).toEqual([
      {
        person: `${GRAPH}#alice`,
        safeName: 'Alice',
        personKey: `${GRAPH}#alice`,
        typedName: {
          value: 'Alice',
          datatype: 'http://www.w3.org/2001/XMLSchema#string',
        },
        localizedName: {
          value: 'Alice',
          language: 'en',
        },
      },
      {
        person: `${GRAPH}#bob`,
        safeName: 'Bob',
        personKey: `${GRAPH}#bob`,
        typedName: {
          value: 'Bob',
          datatype: 'http://www.w3.org/2001/XMLSchema#string',
        },
        localizedName: {
          value: 'Bob',
          language: 'en',
        },
      },
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      totalCount: 1,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers BIND inside OPTIONAL without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');

    const stream = await engine.queryBindings(`
      SELECT ?person ?ageLabel WHERE {
        ?person a <${PERSON}> .
        OPTIONAL {
          ?person <${AGE}> ?age .
          BIND(CONCAT("age:", STR(?age)) AS ?ageLabel)
        }
      }
      ORDER BY ?person
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      person: binding.get('person')?.value,
      ageLabel: binding.get('ageLabel')?.value ?? null,
    }))).toEqual([
      {
        person: `${GRAPH}#alice`,
        ageLabel: 'age:13',
      },
      {
        person: `${GRAPH}#bob`,
        ageLabel: null,
      },
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      totalCount: 1,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('OptionalBind(?ageLabel:=CONCAT("age:",STR(?age)))');
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers BIND inside UNION branches without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');

    const stream = await engine.queryBindings(`
      SELECT ?person ?label WHERE {
        {
          ?person <${NAME}> ?name .
          BIND(CONCAT("name:", STR(?name)) AS ?label)
        }
        UNION
        {
          ?person <${AGE}> ?age .
          BIND(CONCAT("age:", STR(?age)) AS ?label)
        }
      }
      ORDER BY ?person ?label
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      person: binding.get('person')?.value,
      label: binding.get('label')?.value,
    }))).toEqual([
      {
        person: `${GRAPH}#alice`,
        label: 'age:13',
      },
      {
        person: `${GRAPH}#alice`,
        label: 'name:Alice',
      },
      {
        person: `${GRAPH}#bob`,
        label: 'name:Bob',
      },
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      totalCount: 1,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 3,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan.some((entry) => entry.startsWith('UnionBind('))).toBe(true);
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers branch-local tuple VALUES inside UNION without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');

    const stream = await engine.queryBindings(`
      SELECT ?person ?value WHERE {
        {
          VALUES (?person ?value) {
            (<${GRAPH}#alice> "Alice")
            (<${GRAPH}#bob> "wrong-name")
          }
          ?person <${NAME}> ?value .
        }
        UNION
        {
          VALUES (?person ?value) {
            (<${GRAPH}#alice> 13)
            (<${GRAPH}#bob> "wrong-age")
          }
          ?person <${AGE}> ?value .
        }
      }
      ORDER BY ?person ?value
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      person: binding.get('person')?.value,
      value: binding.get('value')?.value,
    }))).toEqual([
      {
        person: `${GRAPH}#alice`,
        value: '13',
      },
      {
        person: `${GRAPH}#alice`,
        value: 'Alice',
      },
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      totalCount: 1,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('UnionValues(?person,?value)');
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers nested OPTIONAL without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');

    const stream = await engine.queryBindings(`
      SELECT ?person ?name ?knownName WHERE {
        ?person a <${PERSON}> .
        OPTIONAL {
          ?person <${NAME}> ?name .
          OPTIONAL {
            ?person <${KNOWS}> ?known .
            ?known <${NAME}> ?knownName .
          }
        }
      }
      ORDER BY ?person
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      person: binding.get('person')?.value,
      name: binding.get('name')?.value ?? null,
      knownName: binding.get('knownName')?.value ?? null,
    }))).toEqual([
      {
        person: `${GRAPH}#alice`,
        name: 'Alice',
        knownName: 'Bob',
      },
      {
        person: `${GRAPH}#bob`,
        name: 'Bob',
        knownName: null,
      },
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      totalCount: 1,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan.some((entry) => entry.startsWith('OptionalNestedJoin('))).toBe(true);
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers dependent joins with UNION branches without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');

    let stream = await engine.queryBindings(`
      SELECT ?person WHERE {
        ?person a <${PERSON}> .
        FILTER EXISTS {
          {
            ?person <${NAME}> ?value .
          }
          UNION
          {
            ?person <${KNOWS}> ?value .
          }
        }
      }
      ORDER BY ?person
    `, BASE);
    let results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('person')?.value)).toEqual([
      `${GRAPH}#alice`,
      `${GRAPH}#bob`,
    ]);
    expect(engine.getMetrics().lastPrimary?.plan.some((entry) => entry.startsWith('ExistsUnion('))).toBe(true);

    stream = await engine.queryBindings(`
      SELECT ?person WHERE {
        ?person a <${PERSON}> .
        MINUS {
          ?person <${NAME}> ?name .
          {
            ?person <${NAME}> "Alice" .
          }
          UNION
          {
            ?person <${STATUS}> "inactive" .
          }
        }
      }
      ORDER BY ?person
    `, BASE);
    results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('person')?.value)).toEqual([
      `${GRAPH}#bob`,
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 2,
      fallbackCount: 0,
      totalCount: 2,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan.some((entry) => entry.startsWith('MinusUnion('))).toBe(true);
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers OPTIONAL-local dependent joins without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');

    let stream = await engine.queryBindings(`
      SELECT ?person ?name ?knownName WHERE {
        ?person a <${PERSON}> .
        OPTIONAL {
          ?person <${NAME}> ?name .
          FILTER EXISTS {
            ?person <${KNOWS}> ?known .
          }
          FILTER NOT EXISTS {
            ?person <${STATUS}> "inactive" .
          }
          OPTIONAL {
            ?person <${KNOWS}> ?known .
            ?known <${NAME}> ?knownName .
          }
        }
      }
      ORDER BY ?person
    `, BASE);
    let results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      person: binding.get('person')?.value,
      name: binding.get('name')?.value ?? null,
      knownName: binding.get('knownName')?.value ?? null,
    }))).toEqual([
      {
        person: `${GRAPH}#alice`,
        name: 'Alice',
        knownName: 'Bob',
      },
      {
        person: `${GRAPH}#bob`,
        name: null,
        knownName: null,
      },
    ]);
    expect(engine.getMetrics().lastPrimary?.plan).toContain('OptionalExists(graph:op,subject:?person,predicate:http://xmlns.com/foaf/0.1/knows,object:?known)');

    stream = await engine.queryBindings(`
      SELECT ?person ?name WHERE {
        ?person a <${PERSON}> .
        OPTIONAL {
          ?person <${NAME}> ?name .
          FILTER NOT EXISTS {
            ?person <${STATUS}> "inactive" .
          }
          MINUS {
            ?person <${NAME}> "Alice" .
          }
        }
      }
      ORDER BY ?person
    `, BASE);
    results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      person: binding.get('person')?.value,
      name: binding.get('name')?.value ?? null,
    }))).toEqual([
      {
        person: `${GRAPH}#alice`,
        name: null,
      },
      {
        person: `${GRAPH}#bob`,
        name: 'Bob',
      },
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 2,
      fallbackCount: 0,
      totalCount: 2,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('OptionalMinus(graph:op,subject:?person,predicate:https://undefineds.co/ns#status,object:"inactive")');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('OptionalMinus(graph:op,subject:?person,predicate:http://xmlns.com/foaf/0.1/name,object:"Alice")');
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers VALUES, MINUS, and fixed-length property paths without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');

    let stream = await engine.queryBindings(`
      SELECT ?person ?name WHERE {
        VALUES ?person { <${GRAPH}#alice> <${GRAPH}#missing> }
        ?person <${NAME}> ?name .
      }
    `, BASE);
    let results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      person: binding.get('person')?.value,
      name: binding.get('name')?.value,
    }))).toEqual([
      {
        person: `${GRAPH}#alice`,
        name: 'Alice',
      },
    ]);

    stream = await engine.queryBindings(`
      SELECT ?person WHERE {
        VALUES ?person { UNDEF <${GRAPH}#alice> }
        ?person a <${PERSON}> .
      }
      ORDER BY ?person
    `, BASE);
    results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('person')?.value)).toEqual([
      `${GRAPH}#alice`,
      `${GRAPH}#alice`,
      `${GRAPH}#bob`,
    ]);

    stream = await engine.queryBindings(`
      SELECT ?person ?tag ?name WHERE {
        ?person a <${PERSON}> .
        OPTIONAL {
          VALUES (?person ?tag) {
            (<${GRAPH}#alice> "selected")
            (<${GRAPH}#missing> "ignored")
          }
          ?person <${NAME}> ?name .
        }
      }
      ORDER BY ?person
    `, BASE);
    results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      person: binding.get('person')?.value,
      tag: binding.get('tag')?.value ?? null,
      name: binding.get('name')?.value ?? null,
    }))).toEqual([
      {
        person: `${GRAPH}#alice`,
        tag: 'selected',
        name: 'Alice',
      },
      {
        person: `${GRAPH}#bob`,
        tag: null,
        name: null,
      },
    ]);

    stream = await engine.queryBindings(`
      SELECT ?person WHERE {
        ?person a <${PERSON}> .
        MINUS {
          ?person <${AGE}> ?age .
        }
      }
      ORDER BY ?person
    `, BASE);
    results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('person')?.value)).toEqual([
      `${GRAPH}#bob`,
    ]);

    stream = await engine.queryBindings(`
      SELECT ?person ?knownName WHERE {
        ?person <${KNOWS}>/<${NAME}> ?knownName .
      }
      ORDER BY ?person
    `, BASE);
    results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      person: binding.get('person')?.value,
      knownName: binding.get('knownName')?.value,
    }))).toEqual([
      {
        person: `${GRAPH}#alice`,
        knownName: 'Bob',
      },
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 5,
      fallbackCount: 0,
      totalCount: 5,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan.some((entry) => entry.includes('#path_'))).toBe(false);
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers case-normalized string filters without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');

    const stream = await engine.queryBindings(`
      PREFIX fn: <http://www.w3.org/2005/xpath-functions#>
      SELECT ?person ?name WHERE {
        ?person <${NAME}> ?name .
        FILTER(LCASE(STR(?name)) = "alice")
        FILTER(fn:contains(fn:upper-case(STR(?name)), "LIC"))
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      person: binding.get('person')?.value,
      name: binding.get('name')?.value,
    }))).toEqual([
      {
        person: `${GRAPH}#alice`,
        name: 'Alice',
      },
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      fallbackCount: 0,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Filter(?name:lowerStringValue$eq,?name:upperStringValue$contains)');
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers language and datatype membership filters without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    rdfEngine.put([
      q(`${GRAPH}#alice`, LABEL, literal('Ally', 'en')),
      q(`${GRAPH}#bob`, LABEL, literal('Robert', 'fr')),
      q(`${GRAPH}#bob`, AGE, literal('21', namedNode(XSD_INTEGER))),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?person ?label ?age WHERE {
        ?person <${LABEL}> ?label .
        ?person <${AGE}> ?age .
        FILTER(LANG(?label) IN ("en", "zh"))
        FILTER(LANG(?label) NOT IN ("fr"))
        FILTER(DATATYPE(?age) IN (<${XSD_INTEGER}>))
        FILTER(DATATYPE(?age) NOT IN (<http://www.w3.org/2001/XMLSchema#string>))
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      person: binding.get('person')?.value,
      label: binding.get('label')?.value,
      age: binding.get('age')?.value,
    }))).toEqual([
      {
        person: `${GRAPH}#alice`,
        label: 'Ally',
        age: '13',
      },
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      fallbackCount: 0,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Filter(?label$langIn,?label$notLangIn,?age$datatypeIn,?age$notDatatypeIn)');
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers grouped COUNT/HAVING and DESCRIBE without fallback', async () => {
    const bindingsFallbackSpy = vi.spyOn(fallback, 'queryBindings');
    const quadsFallbackSpy = vi.spyOn(fallback, 'queryQuads');

    const stream = await engine.queryBindings(`
      SELECT ?type (COUNT(?person) AS ?count) WHERE {
        ?person a ?type .
      }
      GROUP BY ?type
      HAVING (?count >= 2)
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      type: binding.get('type')?.value,
      count: binding.get('count')?.value,
    }))).toEqual([
      {
        type: PERSON,
        count: '2',
      },
    ]);

    const quads = await arrayFromStream(await engine.queryQuads(`
      DESCRIBE ?person WHERE {
        ?person <${NAME}> "Alice" .
      }
    `, BASE));

    expect(quads.map((result) => [
      result.subject.value,
      result.predicate.value,
      result.object.value,
      result.graph.termType,
    ]).sort()).toEqual([
      [`${GRAPH}#alice`, AGE, '13', 'DefaultGraph'],
      [`${GRAPH}#alice`, KNOWS, `${GRAPH}#bob`, 'DefaultGraph'],
      [`${GRAPH}#alice`, NAME, 'Alice', 'DefaultGraph'],
      [`${GRAPH}#alice`, RDF_TYPE, PERSON, 'DefaultGraph'],
    ].sort());
    expect(bindingsFallbackSpy).not.toHaveBeenCalled();
    expect(quadsFallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 2,
      fallbackCount: 0,
      totalCount: 2,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryQuads',
        returnedRows: 4,
      },
    });
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers guarded numeric aggregates without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    rdfEngine.put([
      q(`${GRAPH}#bob`, AGE, literal('21', namedNode(XSD_INTEGER))),
    ]);

    const stream = await engine.queryBindings(`
      SELECT (SUM(?age) AS ?sum) (AVG(?age) AS ?avg) (MIN(?age) AS ?min) (MAX(?age) AS ?max) WHERE {
        ?person <${AGE}> ?age .
        FILTER(isNumeric(?age))
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      sum: binding.get('sum')?.value,
      avg: binding.get('avg')?.value,
      min: binding.get('min')?.value,
      max: binding.get('max')?.value,
    }))).toEqual([
      {
        sum: '34',
        avg: '17',
        min: '13',
        max: '21',
      },
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      fallbackCount: 0,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Aggregate(basic-multi)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Aggregate(join-basic-multi-index)');
  });

  it('covers COUNT DISTINCT star over merged local graphs without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    rdfEngine.put([
      q(`${GRAPH}#alice`, STATUS, literal('active')),
      quad(
        namedNode(`${GRAPH}#alice`),
        namedNode(STATUS),
        literal('active'),
        namedNode(NAMED_GRAPH),
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT (COUNT(DISTINCT *) AS ?count) WHERE {
        ?person <${STATUS}> ?status .
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('count')?.value)).toEqual(['1']);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      fallbackCount: 0,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Aggregate(count-distinct-tuple-index)');
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers grouped guarded numeric aggregates without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    rdfEngine.put([
      q(`${GRAPH}#bob`, AGE, literal('21', namedNode(XSD_INTEGER))),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?type (COUNT(?person) AS ?count) (SUM(?age) AS ?sum) (AVG(?age) AS ?avg) WHERE {
        ?person a ?type .
        ?person <${AGE}> ?age .
        FILTER(isNumeric(?age))
      }
      GROUP BY ?type
      HAVING (?sum > 20)
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      type: binding.get('type')?.value,
      count: binding.get('count')?.value,
      sum: binding.get('sum')?.value,
      avg: binding.get('avg')?.value,
    }))).toEqual([
      {
        type: PERSON,
        count: '2',
        sum: '34',
        avg: '17',
      },
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      fallbackCount: 0,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('IndexGroupAggregateHaving(?sum$gt)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Aggregate(group-basic-multi-index)');
  });

  it('covers ASK and CONSTRUCT graph-pattern queries without fallback', async () => {
    const booleanFallbackSpy = vi.spyOn(fallback, 'queryBoolean');
    const quadsFallbackSpy = vi.spyOn(fallback, 'queryQuads');

    await expect(engine.queryBoolean(`
      ASK {
        ?person a <${PERSON}> .
        FILTER(sameTerm(?person, <${GRAPH}#alice>))
      }
    `, BASE)).resolves.toBe(true);

    const stream = await engine.queryQuads(`
      CONSTRUCT {
        ?person <${LABEL}> ?name .
      }
      WHERE {
        ?person <${NAME}> ?name .
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((result) => [
      result.subject.value,
      result.predicate.value,
      result.object.value,
      result.graph.termType,
    ])).toEqual([
      [`${GRAPH}#alice`, LABEL, 'Alice', 'DefaultGraph'],
      [`${GRAPH}#bob`, LABEL, 'Bob', 'DefaultGraph'],
    ]);
    expect(booleanFallbackSpy).not.toHaveBeenCalled();
    expect(quadsFallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 2,
      fallbackCount: 0,
      totalCount: 2,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryQuads',
        returnedRows: 2,
      },
    });
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('keeps repeated-variable row consistency before LIMIT and COUNT on the embedded path', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    rdfEngine.put([
      q(`${GRAPH}#bob`, KNOWS, namedNode(`${GRAPH}#bob`)),
    ]);

    let stream = await engine.queryBindings(`
      SELECT ?person WHERE {
        ?person <${KNOWS}> ?person .
      }
      ORDER BY ?person
      LIMIT 1
    `, BASE);
    let results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('person')?.value)).toEqual([
      `${GRAPH}#bob`,
    ]);
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Limit');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('IndexLimit');

    stream = await engine.queryBindings(`
      SELECT (COUNT(?person) AS ?count) WHERE {
        ?person <${KNOWS}> ?person .
      }
    `, BASE);
    results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('count')?.value)).toEqual(['1']);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      fallbackCount: 0,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Aggregate(count)');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Aggregate(count-index)');
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers scoped INSERT DATA and DELETE DATA updates without duplicate quads', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryVoid');
    const run = `${BASE}w3c/runs.ttl#run_1`;
    const graph = `${BASE}w3c/runs.ttl`;

    const insert = `
      INSERT DATA {
        GRAPH <${graph}> {
          <${run}> <${STATUS}> "queued" .
        }
      }
    `;

    await engine.queryVoid(insert, BASE);
    await engine.queryVoid(insert, BASE);

    let stream = await engine.queryBindings(`
      SELECT ?status WHERE {
        <${run}> <${STATUS}> ?status .
      }
    `, BASE);
    let results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('status')?.value)).toEqual(['queued']);

    await engine.queryVoid(`
      DELETE DATA {
        GRAPH <${graph}> {
          <${run}> <${STATUS}> "queued" .
        }
      }
    `, BASE);

    stream = await engine.queryBindings(`
      SELECT ?status WHERE {
        <${run}> <${STATUS}> ?status .
      }
    `, BASE);
    results = await arrayFromStream(stream);

    expect(results).toEqual([]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      fallbackCount: 0,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 0,
      },
    });
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('covers query-backed DELETE/INSERT WHERE updates without fallback', async () => {
    const fallbackSpy = vi.spyOn(fallback, 'queryVoid');

    rdfEngine.put([
      q(`${GRAPH}#alice`, STATUS, literal('queued')),
    ]);

    await engine.queryVoid(`
      DELETE {
        GRAPH <${GRAPH}> {
          ?person <${STATUS}> ?oldStatus .
        }
      }
      INSERT {
        GRAPH <${GRAPH}> {
          ?person <${STATUS}> "minor" .
          ?person <${LABEL}> ?statusLabel .
        }
      }
      WHERE {
        GRAPH <${GRAPH}> {
          ?person <${STATUS}> ?oldStatus .
          ?person <${AGE}> ?age .
          BIND(STRLANG(STR(?oldStatus), "en") AS ?statusLabel)
          FILTER(?age >= 13)
        }
      }
    `, BASE);

    const stream = await engine.queryBindings(`
      SELECT ?status ?label WHERE {
        <${GRAPH}#alice> <${STATUS}> ?status .
        <${GRAPH}#alice> <${LABEL}> ?label .
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      status: binding.get('status')?.value,
      label: binding.get('label')?.value,
      labelLanguage: binding.get('label')?.termType === 'Literal'
        ? binding.get('label')?.language
        : undefined,
    }))).toEqual([
      {
        status: 'minor',
        label: 'queued',
        labelLanguage: 'en',
      },
    ]);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      fallbackCount: 0,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });
});

function q(
  subject: string,
  predicate: string,
  object: ReturnType<typeof namedNode> | ReturnType<typeof literal>,
  graph = GRAPH,
) {
  return quad(
    namedNode(subject),
    namedNode(predicate),
    object,
    namedNode(graph),
  );
}
