import type { Quad, Quad_Graph, Quad_Object, Quad_Predicate, Quad_Subject } from '@rdfjs/types';
import type { Bindings } from '@comunica/types';
import type { AsyncIterator } from 'asynciterator';
import { QueryEngine } from '@comunica/query-sparql';
import { Quadstore } from 'quadstore';
import { Engine as QuadstoreEngine } from 'quadstore-comunica';
import { DataFactory } from 'n3';
import { getLoggerFor } from '@solid/community-server';
import { getBackend } from '../../libs/backends';

interface QueryContext {
  sources: [{ type: 'rdfjsSource'; value: { match: (subject?: Quad_Subject | null, predicate?: Quad_Predicate | null, object?: Quad_Object | null, graph?: Quad_Graph | null) => AsyncIterator<Quad> }}];
  // Treat all named graphs as part of the default graph for queries without GRAPH pattern
  unionDefaultGraph: boolean;
  // Base IRI for resolving relative IRIs in queries
  baseIRI: string;
}

export class SubgraphQueryEngine {
  private readonly logger = getLoggerFor(this);
  private readonly store: Quadstore;
  private readonly engine: QueryEngine;
  private readonly updateEngine: QuadstoreEngine;
  private readonly ready: Promise<void>;

  public constructor(endpoint: string) {
    const backend = getBackend(endpoint, { tableName: 'quadstore' });
    this.store = new Quadstore({
      backend,
      dataFactory: DataFactory,
    });
    this.engine = new QueryEngine();
    this.updateEngine = new QuadstoreEngine(this.store);
    this.ready = this.store.open();
  }

  public async queryBindings(query: string, basePath: string) {
    await this.ensureReady();
    return this.engine.queryBindings(query, this.createContext(basePath) as unknown as any);
  }

  public async queryQuads(query: string, basePath: string) {
    await this.ensureReady();
    return this.engine.queryQuads(query, this.createContext(basePath) as unknown as any);
  }

  public async queryBoolean(query: string, basePath: string): Promise<boolean> {
    await this.ensureReady();
    return this.engine.queryBoolean(query, this.createContext(basePath) as unknown as any);
  }

  public async queryVoid(query: string, basePath: string): Promise<void> {
    await this.ensureReady();
    // Use quadstore-comunica engine for updates (supports direct quadstore access)
    // Scope validation is done before calling this method in SubgraphSparqlHttpHandler
    await this.updateEngine.queryVoid(query, { baseIRI: basePath });
  }

  public async constructGraph(graph: string, basePath: string): Promise<AsyncIterator<Quad>> {
    await this.ensureReady();
    const constructQuery = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`;
    return this.engine.queryQuads(constructQuery, this.createContext(basePath) as unknown as any);
  }

  public async listGraphs(basePath: string): Promise<Set<string>> {
    await this.ensureReady();
    const graphs = new Set<string>();
    const query = `
      SELECT DISTINCT ?g WHERE {
        GRAPH ?g { ?s ?p ?o }
        FILTER(STRSTARTS(STR(?g), "${basePath}"))
      }
    `;
    const stream = await this.engine.queryBindings(query, this.createContext(basePath) as unknown as any);
    try {
      for await (const binding of stream as AsyncIterator<Bindings>) {
        const value = binding.get('g');
        if (value && typeof value === 'object' && 'termType' in value && value.termType === 'NamedNode') {
          graphs.add(value.value);
        }
      }
    } finally {
      const close = (stream as unknown as { close?: () => void }).close;
      if (typeof close === 'function') {
        close();
      }
    }
    return graphs;
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  private createContext(basePath: string): QueryContext {
    return {
      // Treat all named graphs as part of the default graph for queries without GRAPH pattern
      unionDefaultGraph: true,
      // Base IRI for resolving relative IRIs (e.g., <#charlie> → <basePath#charlie>)
      baseIRI: basePath,
      sources: [
        {
          type: 'rdfjsSource',
          value: {
            match: (subject?: Quad_Subject | null, predicate?: Quad_Predicate | null, object?: Quad_Object | null, graph?: Quad_Graph | null): AsyncIterator<Quad> => {
              const iterator = this.store.match(
                subject ?? undefined,
                predicate ?? undefined,
                object ?? undefined,
                graph ?? undefined,
              );
              const filtered = (iterator as unknown as AsyncIterator<Quad>).filter((quad): boolean =>
                this.isInScope(basePath, quad.graph)
              );
              return filtered;
            },
          },
        },
      ],
    };
  }

  private isInScope(basePath: string, graph: Quad_Graph): boolean {
    if (!graph || graph.termType !== 'NamedNode') {
      return false;
    }

    let graphValue = graph.value;

    // Support CSS standard "meta:" prefix for metadata graphs
    // e.g. meta:http://pod/doc.ttl -> http://pod/doc.ttl
    if (graphValue.startsWith('meta:')) {
      graphValue = graphValue.slice(5);
    }

    // 1. Direct match with full URL
    if (graphValue === basePath) {
      return true;
    }

    // 2. Safe prefix matching (Container scope or Fragment) for full URL
    const childPrefix = basePath.endsWith('/') ? basePath : `${basePath}/`;
    const fragmentPrefix = `${basePath}#`;

    if (graphValue.startsWith(childPrefix) || graphValue.startsWith(fragmentPrefix)) {
      return true;
    }

    // 3. Path-only matching (legacy support or relative graphs)
    let pathOnly = basePath;
    try {
      const url = new URL(basePath);
      pathOnly = url.pathname;
    } catch {
      // basePath is already a path, not a URL
    }

    // Avoid re-checking if pathOnly is same as basePath (e.g. if basePath was already relative)
    if (pathOnly === basePath) {
      return false;
    }

    // Handle meta: in path-only mode too (though unlikely for named nodes)
    if (graphValue.startsWith('meta:')) {
       graphValue = graphValue.slice(5);
    }

    if (graphValue === pathOnly) {
      return true;
    }

    const pathChildPrefix = pathOnly.endsWith('/') ? pathOnly : `${pathOnly}/`;
    const pathFragmentPrefix = `${pathOnly}#`;

    if (graphValue.startsWith(pathChildPrefix) || graphValue.startsWith(pathFragmentPrefix)) {
      return true;
    }

    return false;
  }

  public async close(): Promise<void> {
    await this.store.close();
  }
}
