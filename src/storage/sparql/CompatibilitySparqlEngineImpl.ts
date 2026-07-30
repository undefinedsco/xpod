import type { Quad, Variable } from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import { ComunicaQuintEngine } from './ComunicaQuintEngine';
import { QuintEngine } from './QuintEngine';
import type { SparqlEngine, SparqlVoidOptions } from './SubgraphQueryEngine';
import type { QuintStore } from '../quint/types';
import { isRestrictiveRdfAccessScope, type RdfAccessScope } from '../rdf/RdfAccessScope';

/**
 * @deprecated Compatibility wrapper preserved for older call sites.
 * Mainline xpod uses SolidRdfEngine for server-owned Pod queries.
 */
export class QuadstoreSparqlEngine implements SparqlEngine {
  private readonly delegate: QuintstoreSparqlEngine;

  public constructor(endpoint: string) {
    const store = new QuintEngine({ endpoint }).getStore();
    this.delegate = new QuintstoreSparqlEngine(store);
  }

  public async queryBindings(query: string, basePath: string, accessScope?: RdfAccessScope): Promise<any> {
    return this.delegate.queryBindings(query, basePath, accessScope);
  }

  public async queryQuads(query: string, basePath: string, accessScope?: RdfAccessScope): Promise<any> {
    return this.delegate.queryQuads(query, basePath, accessScope);
  }

  public async queryBoolean(query: string, basePath: string, accessScope?: RdfAccessScope): Promise<boolean> {
    return this.delegate.queryBoolean(query, basePath, accessScope);
  }

  public async queryVoid(query: string, basePath: string, accessScope?: RdfAccessScope, options?: SparqlVoidOptions): Promise<void> {
    await this.delegate.queryVoid(query, basePath, accessScope, options);
  }

  public async constructGraph(graph: string, basePath: string, accessScope?: RdfAccessScope): Promise<AsyncIterator<Quad>> {
    return this.delegate.constructGraph(graph, basePath, accessScope);
  }

  public async listGraphs(basePath: string, accessScope?: RdfAccessScope): Promise<Set<string>> {
    return this.delegate.listGraphs(basePath, accessScope);
  }

  public async close(): Promise<void> {
    await this.delegate.close();
  }
}

/**
 * Comunica-backed compatibility engine.
 */
export class QuintstoreSparqlEngine implements SparqlEngine {
  private readonly store: QuintStore;
  private readonly engine: ComunicaQuintEngine;
  private readonly ready: Promise<void>;

  public constructor(store: QuintStore) {
    this.store = store;
    this.engine = new ComunicaQuintEngine(this.store);
    this.ready = this.store.open();
  }

  public async queryBindings(query: string, basePath: string, accessScope?: RdfAccessScope): Promise<any> {
    assertCompatibilityAccessScope(accessScope, 'queryBindings');
    await this.ready;
    return this.engine.queryBindings(query, {
      baseIRI: basePath,
      filters: { graph: { $startsWith: basePath } },
    });
  }

  public async queryQuads(query: string, basePath: string, accessScope?: RdfAccessScope): Promise<any> {
    assertCompatibilityAccessScope(accessScope, 'queryQuads');
    await this.ready;
    return this.engine.queryQuads(query, {
      baseIRI: basePath,
      filters: { graph: { $startsWith: basePath } },
    });
  }

  public async queryBoolean(query: string, basePath: string, accessScope?: RdfAccessScope): Promise<boolean> {
    assertCompatibilityAccessScope(accessScope, 'queryBoolean');
    await this.ready;
    return this.engine.queryBoolean(query, {
      baseIRI: basePath,
      filters: { graph: { $startsWith: basePath } },
    });
  }

  public async queryVoid(query: string, basePath: string, accessScope?: RdfAccessScope, options?: SparqlVoidOptions): Promise<void> {
    assertCompatibilityAccessScope(accessScope, 'queryVoid');
    await this.ready;
    return this.engine.queryVoid(query, {
      baseIRI: basePath,
      filters: { graph: { $startsWith: basePath } },
    });
  }

  public async constructGraph(graph: string, basePath: string, accessScope?: RdfAccessScope): Promise<AsyncIterator<Quad>> {
    assertCompatibilityAccessScope(accessScope, 'constructGraph');
    await this.ready;
    const constructQuery = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`;
    return this.engine.queryQuads(constructQuery, {
      baseIRI: basePath,
      filters: { graph: { $startsWith: basePath } },
    }) as unknown as AsyncIterator<Quad>;
  }

  public async listGraphs(basePath: string, accessScope?: RdfAccessScope): Promise<Set<string>> {
    assertCompatibilityAccessScope(accessScope, 'listGraphs');
    await this.ready;
    const graphs = new Set<string>();
    const query = 'SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }';
    const stream = await this.engine.queryBindings(query, {
      baseIRI: basePath,
      filters: { graph: { $startsWith: basePath } },
    });

    try {
      for await (const binding of stream as unknown as AsyncIterator<Map<string | Variable, { termType?: string; value: string }>>) {
        const value = binding.get('g');
        if (value?.termType === 'NamedNode') {
          graphs.add(value.value);
        }
      }
    } finally {
      // Keep the AsyncIterator receiver. Detaching close() loses `this` and
      // makes asynciterator crash while reading its internal `_changeState`.
      (stream as unknown as { close?: () => void }).close?.();
    }

    return graphs;
  }

  public async close(): Promise<void> {
    await this.store.close();
  }
}

function assertCompatibilityAccessScope(accessScope: RdfAccessScope | undefined, operation: string): void {
  if (isRestrictiveRdfAccessScope(accessScope)) {
    throw new Error(`Compatibility SPARQL engine cannot safely execute ${operation} with ACL/ACR graph restrictions`);
  }
}
