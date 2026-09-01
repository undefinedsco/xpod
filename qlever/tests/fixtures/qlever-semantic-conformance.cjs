'use strict';

const REQUIRED_CASES = Object.freeze([
  'term/same-term-vs-value-equality',
  'term/numeric-promotion',
  'term/boolean-ebv',
  'term/nan-infinity-order',
  'term/date-time-order',
  'term/date-extraction',
  'term/language-literal',
  'term/incompatible-relational-error',
  'term/unbound-expression-error',
  'algebra/optional-union-minus-exists',
  'algebra/aggregation-order-pagination-bag',
  'graph/default-and-named',
  'scope/graph-denied',
  'scope/source-denied',
  'update/insert-delete-where',
]);

const READ_SCOPE = Object.freeze({
  principal: 'urn:xpod:semantic-reader',
  mode: 'read',
  allowedGraphs: Object.freeze([]),
  allowedSources: Object.freeze([]),
  deniedGraphs: Object.freeze([]),
  deniedSources: Object.freeze([]),
});

const ALLOWED_GRAPH = 'urn:xpod:semantic:g:allowed';
const DENIED_GRAPH = 'urn:xpod:semantic:g:denied';
const DEFAULT_GRAPH_SOURCE = 'urn:xpod:semantic:source:default-graph';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function rows(bindings, variables = ['s', 'p', 'o', 'g']) {
  return {
    kind: 'bindings',
    variables: Object.freeze(variables),
    rows: Object.freeze(bindings.map((binding) => Object.freeze(binding))),
  };
}

function scopeProof({ deniedGraphIds = [], deniedSourceIds = [] } = {}) {
  return {
    deniedRowsObserved: 0,
    deniedKeysObserved: Object.freeze({
      scan: Object.freeze([]),
      termLookup: Object.freeze([]),
      cache: Object.freeze([]),
      binding: Object.freeze([]),
    }),
    deniedGraphIds: Object.freeze(deniedGraphIds),
    deniedSourceIds: Object.freeze(deniedSourceIds),
  };
}

function document(sourceUri, body, options = {}) {
  return Object.freeze({
    sourceUri,
    graph: options.graph ?? 'source',
    contentType: 'text/turtle',
    body,
  });
}

function update(sourceUri, sparql) {
  return Object.freeze({ sourceUri, sparql });
}

function freshCase(testCase) {
  return {
    isolation: 'fresh-schema',
    documents: Object.freeze([]),
    updates: Object.freeze([]),
    ...testCase,
  };
}

const semanticConformanceCases = deepFreeze([
  freshCase(
  {
    id: 'term/same-term-vs-value-equality',
    documents: Object.freeze([document(ALLOWED_GRAPH, `
      <urn:xpod:semantic:s:term> <urn:xpod:semantic:p:lexical> "01"^^<http://www.w3.org/2001/XMLSchema#integer> .
      <urn:xpod:semantic:s:term> <urn:xpod:semantic:p:lexical> "1"^^<http://www.w3.org/2001/XMLSchema#integer> .
    `)]),
    query: `
      PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      SELECT ?lexical ?sameAsCanonical ?valueEqualsCanonical ?queryOnlyDistinctLexical ?queryOnlySameLexical WHERE {
        GRAPH ?g { ?s ?p ?o }
        BIND(STR(?o) AS ?lexical)
        BIND(sameTerm(?o, "1"^^xsd:integer) AS ?sameAsCanonical)
        BIND(?o = "1"^^xsd:integer AS ?valueEqualsCanonical)
        BIND(sameTerm("3.0"^^xsd:double, "3.0E0"^^xsd:double) AS ?queryOnlyDistinctLexical)
        BIND(sameTerm("3.0E0"^^xsd:double, "3.0E0"^^xsd:double) AS ?queryOnlySameLexical)
      }
      ORDER BY ?lexical
    `,
    acceptMediaType: 'application/sparql-results+json',
    accessScope: READ_SCOPE,
    expectedCanonical: rows([
      {
        lexical: '"01"',
        sameAsCanonical: '"false"^^xsd:boolean',
        valueEqualsCanonical: '"true"^^xsd:boolean',
        queryOnlyDistinctLexical: '"false"^^xsd:boolean',
        queryOnlySameLexical: '"true"^^xsd:boolean',
      },
      {
        lexical: '"1"',
        sameAsCanonical: '"true"^^xsd:boolean',
        valueEqualsCanonical: '"true"^^xsd:boolean',
        queryOnlyDistinctLexical: '"false"^^xsd:boolean',
        queryOnlySameLexical: '"true"^^xsd:boolean',
      },
    ], [
      'lexical',
      'sameAsCanonical',
      'valueEqualsCanonical',
      'queryOnlyDistinctLexical',
      'queryOnlySameLexical',
    ]),
  },
  ),
  freshCase(
  {
    id: 'term/numeric-promotion',
    documents: Object.freeze([document(ALLOWED_GRAPH, `
      <urn:xpod:semantic:s:numeric> <urn:xpod:semantic:p:value> "2"^^<http://www.w3.org/2001/XMLSchema#integer> .
      <urn:xpod:semantic:s:numeric> <urn:xpod:semantic:p:value> "2.5"^^<http://www.w3.org/2001/XMLSchema#decimal> .
      <urn:xpod:semantic:s:numeric> <urn:xpod:semantic:p:value> "3.0E0"^^<http://www.w3.org/2001/XMLSchema#double> .
    `)]),
    query: 'SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER((?o + 1) > 3 && ?o < 10) } ORDER BY ?o',
    acceptMediaType: 'application/sparql-results+json',
    accessScope: READ_SCOPE,
    expectedCanonical: rows([
      { s: 'urn:xpod:semantic:s:numeric', p: 'urn:xpod:semantic:p:value', o: '"2.5"^^xsd:decimal', g: 'urn:xpod:semantic:g:allowed' },
      { s: 'urn:xpod:semantic:s:numeric', p: 'urn:xpod:semantic:p:value', o: '"3.0E0"^^xsd:double', g: 'urn:xpod:semantic:g:allowed' },
    ]),
  },
  ),
  freshCase(
  {
    id: 'term/boolean-ebv',
    documents: Object.freeze([document(ALLOWED_GRAPH, `
      <urn:xpod:semantic:s:boolean> <urn:xpod:semantic:p:value> true .
      <urn:xpod:semantic:s:boolean> <urn:xpod:semantic:p:value> false .
      <urn:xpod:semantic:s:boolean> <urn:xpod:semantic:p:value> "" .
    `)]),
    query: 'SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(?o) } ORDER BY ?o',
    acceptMediaType: 'application/sparql-results+json',
    accessScope: READ_SCOPE,
    expectedCanonical: rows([
      { s: 'urn:xpod:semantic:s:boolean', p: 'urn:xpod:semantic:p:value', o: '"true"^^xsd:boolean', g: 'urn:xpod:semantic:g:allowed' },
    ]),
  },
  ),
  freshCase(
  {
    id: 'term/nan-infinity-order',
    documents: Object.freeze([document(ALLOWED_GRAPH, `
      <urn:xpod:semantic:s:float> <urn:xpod:semantic:p:value> "NaN"^^<http://www.w3.org/2001/XMLSchema#double> .
      <urn:xpod:semantic:s:float> <urn:xpod:semantic:p:value> "INF"^^<http://www.w3.org/2001/XMLSchema#double> .
      <urn:xpod:semantic:s:float> <urn:xpod:semantic:p:value> "-INF"^^<http://www.w3.org/2001/XMLSchema#double> .
    `)]),
    query: 'SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?o',
    acceptMediaType: 'application/sparql-results+json',
    accessScope: READ_SCOPE,
    expectedCanonical: rows([
      { s: 'urn:xpod:semantic:s:float', p: 'urn:xpod:semantic:p:value', o: '"-INF"^^xsd:double', g: 'urn:xpod:semantic:g:allowed' },
      { s: 'urn:xpod:semantic:s:float', p: 'urn:xpod:semantic:p:value', o: '"INF"^^xsd:double', g: 'urn:xpod:semantic:g:allowed' },
      { s: 'urn:xpod:semantic:s:float', p: 'urn:xpod:semantic:p:value', o: '"NaN"^^xsd:double', g: 'urn:xpod:semantic:g:allowed' },
    ]),
  },
  ),
  freshCase(
  {
    id: 'term/date-time-order',
    documents: Object.freeze([document(ALLOWED_GRAPH, `
      <urn:xpod:semantic:s:time> <urn:xpod:semantic:p:value> "2026-08-12T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
      <urn:xpod:semantic:s:time> <urn:xpod:semantic:p:value> "2026-08-12T08:00:00+08:00"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
      <urn:xpod:semantic:s:time> <urn:xpod:semantic:p:value> "2026-08-13T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
      <urn:xpod:semantic:s:time-mutation> <urn:xpod:semantic:p:value> "2026-08-14T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
    `)]),
    updates: Object.freeze([update(ALLOWED_GRAPH, `
      DELETE {
        GRAPH <urn:xpod:semantic:g:allowed> {
          <urn:xpod:semantic:s:time-mutation> <urn:xpod:semantic:p:value> ?old
        }
      }
      INSERT {
        GRAPH <urn:xpod:semantic:g:allowed> {
          <urn:xpod:semantic:s:time-mutation> <urn:xpod:semantic:p:value> "2026-08-15T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>
        }
      }
      WHERE {
        GRAPH <urn:xpod:semantic:g:allowed> {
          <urn:xpod:semantic:s:time-mutation> <urn:xpod:semantic:p:value> ?old
        }
      }
    `)]),
    query: `
      PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      SELECT ?s ?p ?o ?g WHERE {
        GRAPH ?g { ?s ?p ?o }
        FILTER(?o >= "2026-08-12T00:00:00Z"^^xsd:dateTime)
      }
      ORDER BY STR(?o)
    `,
    acceptMediaType: 'application/sparql-results+json',
    accessScope: READ_SCOPE,
    expectedCanonical: rows([
      { s: 'urn:xpod:semantic:s:time', p: 'urn:xpod:semantic:p:value', o: '"2026-08-12T00:00:00Z"^^xsd:dateTime', g: 'urn:xpod:semantic:g:allowed' },
      { s: 'urn:xpod:semantic:s:time', p: 'urn:xpod:semantic:p:value', o: '"2026-08-12T08:00:00+08:00"^^xsd:dateTime', g: 'urn:xpod:semantic:g:allowed' },
      { s: 'urn:xpod:semantic:s:time', p: 'urn:xpod:semantic:p:value', o: '"2026-08-13T00:00:00Z"^^xsd:dateTime', g: 'urn:xpod:semantic:g:allowed' },
      { s: 'urn:xpod:semantic:s:time-mutation', p: 'urn:xpod:semantic:p:value', o: '"2026-08-15T00:00:00Z"^^xsd:dateTime', g: 'urn:xpod:semantic:g:allowed' },
    ]),
  },
  ),
  freshCase(
  {
    id: 'term/date-extraction',
    documents: Object.freeze([document(ALLOWED_GRAPH, `
      <urn:xpod:semantic:s:date> <urn:xpod:semantic:p:value> "2026-07-10"^^<http://www.w3.org/2001/XMLSchema#date> .
    `)]),
    query: `
      SELECT (YEAR(?value) AS ?year) WHERE {
        GRAPH <urn:xpod:semantic:g:allowed> {
          <urn:xpod:semantic:s:date> <urn:xpod:semantic:p:value> ?value
        }
      }
    `,
    acceptMediaType: 'application/sparql-results+json',
    accessScope: READ_SCOPE,
    expectedCanonical: rows([
      { year: '"2026"^^xsd:integer' },
    ], ['year']),
  },
  ),
  freshCase(
  {
    id: 'term/language-literal',
    documents: Object.freeze([document(ALLOWED_GRAPH, `
      <urn:xpod:semantic:s:lang> <urn:xpod:semantic:p:label> "color"@en .
      <urn:xpod:semantic:s:lang> <urn:xpod:semantic:p:label> "colour"@en-GB .
      <urn:xpod:semantic:s:lang> <urn:xpod:semantic:p:label> "颜色"@zh-Hans .
    `)]),
    query: 'SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(LANGMATCHES(LANG(?o), "en")) } ORDER BY LANG(?o) STR(?o)',
    acceptMediaType: 'application/sparql-results+json',
    accessScope: READ_SCOPE,
    expectedCanonical: rows([
      { s: 'urn:xpod:semantic:s:lang', p: 'urn:xpod:semantic:p:label', o: '"color"@en', g: 'urn:xpod:semantic:g:allowed' },
      { s: 'urn:xpod:semantic:s:lang', p: 'urn:xpod:semantic:p:label', o: '"colour"@en-gb', g: 'urn:xpod:semantic:g:allowed' },
    ]),
  },
  ),
  freshCase(
  {
    id: 'term/incompatible-relational-error',
    documents: Object.freeze([document(ALLOWED_GRAPH, '<urn:xpod:semantic:s:error> <urn:xpod:semantic:p:value> "abc" .')]),
    query: 'SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } FILTER(?o < 7) }',
    acceptMediaType: 'application/sparql-results+json',
    accessScope: READ_SCOPE,
    expectedCanonical: rows([], ['s']),
  },
  ),
  freshCase(
  {
    id: 'term/unbound-expression-error',
    documents: Object.freeze([document(ALLOWED_GRAPH, '<urn:xpod:semantic:s:error> <urn:xpod:semantic:p:value> 1 .')]),
    query: 'SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } BIND((?missing + 1) AS ?computed) }',
    acceptMediaType: 'application/sparql-results+json',
    accessScope: READ_SCOPE,
    expectedCanonical: rows([
      { s: 'urn:xpod:semantic:s:error' },
    ], ['s']),
  },
  ),
  freshCase(
  {
    id: 'algebra/optional-union-minus-exists',
    documents: Object.freeze([document(ALLOWED_GRAPH, `
      <urn:xpod:semantic:s:a> <urn:xpod:semantic:p:type> <urn:xpod:semantic:t:thing> .
      <urn:xpod:semantic:s:a> <urn:xpod:semantic:p:label> "a" .
      <urn:xpod:semantic:s:b> <urn:xpod:semantic:p:type> <urn:xpod:semantic:t:thing> .
      <urn:xpod:semantic:s:b> <urn:xpod:semantic:p:blocked> true .
      <urn:xpod:semantic:s:c> <urn:xpod:semantic:p:altType> <urn:xpod:semantic:t:thing> .
    `)]),
    query: `
      SELECT ?s ?p ?o ?g WHERE {
        { GRAPH ?g { ?s <urn:xpod:semantic:p:type> ?o } }
        UNION
        { GRAPH ?g { ?s <urn:xpod:semantic:p:altType> ?o } }
        OPTIONAL { GRAPH ?g { ?s <urn:xpod:semantic:p:label> ?label } }
        FILTER EXISTS { GRAPH ?g { ?s ?any ?o } }
        MINUS { GRAPH ?g { ?s <urn:xpod:semantic:p:blocked> true } }
        BIND(<urn:xpod:semantic:p:result> AS ?p)
      }
      ORDER BY ?s
    `,
    acceptMediaType: 'application/sparql-results+json',
    accessScope: READ_SCOPE,
    expectedCanonical: rows([
      { s: 'urn:xpod:semantic:s:a', p: 'urn:xpod:semantic:p:result', o: 'urn:xpod:semantic:t:thing', g: 'urn:xpod:semantic:g:allowed' },
      { s: 'urn:xpod:semantic:s:c', p: 'urn:xpod:semantic:p:result', o: 'urn:xpod:semantic:t:thing', g: 'urn:xpod:semantic:g:allowed' },
    ]),
  },
  ),
  freshCase(
  {
    id: 'algebra/aggregation-order-pagination-bag',
    documents: Object.freeze([document(ALLOWED_GRAPH, `
      <urn:xpod:semantic:s:group-a> <urn:xpod:semantic:p:score> 1 .
      <urn:xpod:semantic:s:group-a> <urn:xpod:semantic:p:score> 2 .
      <urn:xpod:semantic:s:group-b> <urn:xpod:semantic:p:score> 4 .
      <urn:xpod:semantic:s:group-c> <urn:xpod:semantic:p:score> 8 .
    `)]),
    query: `
      SELECT ?s (COUNT(?o) AS ?count) (SUM(?o) AS ?sum) WHERE {
        GRAPH <urn:xpod:semantic:g:allowed> { ?s <urn:xpod:semantic:p:score> ?o }
      }
      GROUP BY ?s
      ORDER BY DESC(?sum) ?s
      LIMIT 2
      OFFSET 1
    `,
    acceptMediaType: 'application/sparql-results+json',
    accessScope: READ_SCOPE,
    expectedCanonical: {
      kind: 'bindings',
      variables: Object.freeze(['s', 'count', 'sum']),
      rows: Object.freeze([
        Object.freeze({ s: 'urn:xpod:semantic:s:group-b', count: '"1"^^xsd:integer', sum: '"4"^^xsd:integer' }),
        Object.freeze({ s: 'urn:xpod:semantic:s:group-a', count: '"2"^^xsd:integer', sum: '"3"^^xsd:integer' }),
      ]),
    },
  },
  ),
  freshCase(
  {
    id: 'graph/default-and-named',
    documents: Object.freeze([
      document(
        DEFAULT_GRAPH_SOURCE,
        '<urn:xpod:semantic:s:default> <urn:xpod:semantic:p:value> "default" .',
        { graph: 'default' },
      ),
      document(ALLOWED_GRAPH, '<urn:xpod:semantic:s:named> <urn:xpod:semantic:p:value> "named" .'),
    ]),
    query: `
      SELECT ?s ?p ?o ?g WHERE {
        { ?s ?p ?o BIND(<urn:xpod:semantic:g:default> AS ?g) }
        UNION
        { GRAPH ?g { ?s ?p ?o } }
      }
      ORDER BY ?g ?s
    `,
    acceptMediaType: 'application/sparql-results+json',
    accessScope: READ_SCOPE,
    expectedCanonical: rows([
      { s: 'urn:xpod:semantic:s:named', p: 'urn:xpod:semantic:p:value', o: '"named"', g: 'urn:xpod:semantic:g:allowed' },
      { s: 'urn:xpod:semantic:s:default', p: 'urn:xpod:semantic:p:value', o: '"default"', g: 'urn:xpod:semantic:g:default' },
    ]),
  },
  ),
  freshCase(
  {
    id: 'scope/graph-denied',
    documents: Object.freeze([
      document(ALLOWED_GRAPH, '<urn:xpod:semantic:s:allowed-graph> <urn:xpod:semantic:p:value> "allowed" .'),
      document(DENIED_GRAPH, '<urn:xpod:semantic:s:denied-graph> <urn:xpod:semantic:p:value> "denied" .'),
    ]),
    query: 'SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?s',
    acceptMediaType: 'application/sparql-results+json',
    accessScope: {
      ...READ_SCOPE,
      allowedGraphs: Object.freeze(['urn:xpod:semantic:g:allowed']),
      deniedGraphs: Object.freeze(['urn:xpod:semantic:g:denied']),
    },
    expectedCanonical: {
      ...rows([
        { s: 'urn:xpod:semantic:s:allowed-graph', p: 'urn:xpod:semantic:p:value', o: '"allowed"', g: 'urn:xpod:semantic:g:allowed' },
      ]),
      authorization: scopeProof({ deniedGraphIds: ['urn:xpod:semantic:g:denied'] }),
    },
  },
  ),
  freshCase(
  {
    id: 'scope/source-denied',
    query: 'SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?s',
    acceptMediaType: 'application/sparql-results+json',
    accessScope: {
      ...READ_SCOPE,
      allowedSources: Object.freeze(['urn:xpod:semantic:source:allowed']),
      deniedSources: Object.freeze(['urn:xpod:semantic:source:denied']),
    },
    documents: Object.freeze([
      document(
        'urn:xpod:semantic:source:allowed',
        '<urn:xpod:semantic:s:allowed-source> <urn:xpod:semantic:p:value> "allowed" .',
      ),
      document(
        'urn:xpod:semantic:source:denied',
        '<urn:xpod:semantic:s:denied-source> <urn:xpod:semantic:p:value> "denied" .',
      ),
    ]),
    expectedCanonical: {
      ...rows([
        { s: 'urn:xpod:semantic:s:allowed-source', p: 'urn:xpod:semantic:p:value', o: '"allowed"', g: 'urn:xpod:semantic:source:allowed' },
      ]),
      authorization: scopeProof({ deniedSourceIds: ['urn:xpod:semantic:source:denied'] }),
    },
  },
  ),
  freshCase(
  {
    id: 'update/insert-delete-where',
    documents: Object.freeze([document(
      ALLOWED_GRAPH,
      '<urn:xpod:semantic:s:update> <urn:xpod:semantic:p:old> "old" .',
    )]),
    updates: Object.freeze([update(ALLOWED_GRAPH, `
      DELETE { GRAPH <urn:xpod:semantic:g:allowed> { ?s <urn:xpod:semantic:p:old> ?old } }
      INSERT { GRAPH <urn:xpod:semantic:g:allowed> { ?s <urn:xpod:semantic:p:new> "new" } }
      WHERE { GRAPH <urn:xpod:semantic:g:allowed> { ?s <urn:xpod:semantic:p:old> ?old } }
    `)]),
    query: 'SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?p',
    acceptMediaType: 'application/sparql-results+json',
    accessScope: READ_SCOPE,
    expectedCanonical: rows([
      { s: 'urn:xpod:semantic:s:update', p: 'urn:xpod:semantic:p:new', o: '"new"', g: 'urn:xpod:semantic:g:allowed' },
    ]),
  },
  ),
]);

module.exports = {
  REQUIRED_CASES,
  semanticConformanceCases,
};
