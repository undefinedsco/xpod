import type { SPARQLQueryEngine } from '@undefineds.co/drizzle-solid';

type SparqlJsonTerm = {
  type?: unknown;
  value?: unknown;
  datatype?: unknown;
  'xml:lang'?: unknown;
};

type SparqlJsonPayload = {
  boolean?: unknown;
  results?: {
    bindings?: Array<Record<string, SparqlJsonTerm>>;
  };
};

type RdfTerm = {
  termType: 'NamedNode' | 'BlankNode' | 'Literal';
  value: string;
  language?: string;
  datatype?: { termType: 'NamedNode'; value: string };
};

export function createSparqlEndpointQueryEngine(): SPARQLQueryEngine {
  return {
    async queryBindings(query, context) {
      if (!hasExplicitSparqlSource(context)) {
        const documentEngine = await getDocumentEngine();
        return documentEngine.queryBindings(query, context as any) as any;
      }
      const payload = await queryEndpoint(query, context);
      const bindings = payload.results?.bindings;
      if (!Array.isArray(bindings)) {
        throw new Error('SPARQL SELECT response does not contain bindings');
      }
      return {
        async toArray() {
          return bindings.map((row) => new Map(
            Object.entries(row).map(([name, term]) => [name, toRdfTerm(term)]),
          ));
        },
      };
    },
    async queryBoolean(query, context) {
      if (!hasExplicitSparqlSource(context)) {
        const documentEngine = await getDocumentEngine();
        return documentEngine.queryBoolean(query, context as any);
      }
      const payload = await queryEndpoint(query, context);
      if (typeof payload.boolean !== 'boolean') {
        throw new Error('SPARQL ASK response does not contain a boolean');
      }
      return payload.boolean;
    },
  };
}

type ActionObserverConstructor = {
  prototype: {
    onRun: (actor: unknown, action: unknown, output: unknown) => unknown;
    __xpodObservedActorsPatched?: boolean;
  };
};

let documentEnginePromise: Promise<SPARQLQueryEngine> | undefined;

function getDocumentEngine(): Promise<SPARQLQueryEngine> {
  documentEnginePromise ??= Promise.all([
    import('@comunica/query-sparql-solid'),
    import('@comunica/actor-query-result-serialize-sparql-json'),
    import('@comunica/actor-query-result-serialize-stats'),
  ]).then(([{ QueryEngine }, { ActionObserverHttp: JsonObserver }, { ActionObserverHttp: StatsObserver }]) => {
    patchComunicaActionObservers([JsonObserver, StatsObserver] as ActionObserverConstructor[]);
    return new QueryEngine() as unknown as SPARQLQueryEngine;
  });
  return documentEnginePromise;
}

function patchComunicaActionObservers(observers: ActionObserverConstructor[]): void {
  for (const Observer of observers) {
    const prototype = Observer.prototype;
    if (prototype.__xpodObservedActorsPatched) {
      continue;
    }
    const originalOnRun = prototype.onRun;
    prototype.onRun = function(this: { observedActors?: string[] }, actor, action, output): unknown {
      if (!Array.isArray(this.observedActors)) {
        this.observedActors = [];
      }
      return originalOnRun.call(this, actor, action, output);
    };
    prototype.__xpodObservedActorsPatched = true;
  }
}

function hasExplicitSparqlSource(context: Record<string, unknown>): boolean {
  const source = Array.isArray(context.sources) ? context.sources[0] : undefined;
  return Boolean(
    source
    && typeof source === 'object'
    && (source as { type?: unknown }).type === 'sparql'
    && typeof (source as { value?: unknown }).value === 'string',
  );
}

async function queryEndpoint(query: string, context: Record<string, unknown>): Promise<SparqlJsonPayload> {
  const endpoint = endpointFromContext(context);
  if (typeof context.fetch !== 'function') {
    throw new Error('SPARQL endpoint query requires the authenticated context fetch');
  }
  const fetchFn = context.fetch as typeof fetch;
  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/sparql-results+json',
      'Content-Type': 'application/sparql-query',
    },
    body: query,
  });
  if (!response.ok) {
    throw new Error(`SPARQL endpoint query failed: ${response.status} ${response.statusText}`.trim());
  }
  return await response.json() as SparqlJsonPayload;
}

function endpointFromContext(context: Record<string, unknown>): string {
  const source = Array.isArray(context.sources) ? context.sources[0] : undefined;
  if (hasExplicitSparqlSource(context)) {
    return (source as { value: string }).value;
  }
  throw new Error('SPARQL endpoint query requires one explicit endpoint source');
}

function toRdfTerm(term: SparqlJsonTerm): RdfTerm {
  if (typeof term.value !== 'string') {
    throw new Error('SPARQL binding term does not contain a string value');
  }
  if (term.type === 'uri') {
    return { termType: 'NamedNode', value: term.value };
  }
  if (term.type === 'bnode') {
    return { termType: 'BlankNode', value: term.value };
  }
  if (term.type === 'literal' || term.type === 'typed-literal') {
    const language = typeof term['xml:lang'] === 'string' ? term['xml:lang'] : undefined;
    const datatype = typeof term.datatype === 'string' ? term.datatype : undefined;
    return {
      termType: 'Literal',
      value: term.value,
      ...(language ? { language } : {}),
      ...(datatype ? { datatype: { termType: 'NamedNode', value: datatype } } : {}),
    };
  }
  throw new Error(`Unsupported SPARQL binding term type: ${String(term.type)}`);
}
