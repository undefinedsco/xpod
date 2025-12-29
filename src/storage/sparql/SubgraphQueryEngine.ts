import type { Quad, Quad_Graph, Quad_Object, Quad_Predicate, Quad_Subject } from '@rdfjs/types';
import type { Bindings } from '@comunica/types';
import type { AsyncIterator } from 'asynciterator';
import { QueryEngine } from '@comunica/query-sparql';
import { Quadstore } from 'quadstore';
import { DataFactory } from 'n3';
import { getLoggerFor } from 'global-logger-factory';
import { getBackend } from '../../libs/backends/index';
import { OptimizedQuadstoreEngine } from './OptimizedQuadstoreEngine';
import { ComunicaQuintEngine } from './ComunicaQuintEngine';
import type { QuintStore } from '../quint/types';

interface QueryContext {
  sources: [{ type: 'rdfjsSource'; value: { match: (subject?: Quad_Subject | null, predicate?: Quad_Predicate | null, object?: Quad_Object | null, graph?: Quad_Graph | null) => AsyncIterator<Quad> }}];
  unionDefaultGraph: boolean;
  baseIRI: string;
}

/**
 * SPARQL Engine interface - common abstraction for SPARQL query engines
 */
export interface SparqlEngine {
  queryBindings(query: string, basePath: string): Promise<any>;
  queryQuads(query: string, basePath: string): Promise<any>;
  queryBoolean(query: string, basePath: string): Promise<boolean>;
  queryVoid(query: string, basePath: string): Promise<void>;
  constructGraph(graph: string, basePath: string): Promise<AsyncIterator<Quad>>;
  listGraphs(basePath: string): Promise<Set<string>>;
  close(): Promise<void>;
}

/**
 * Quadstore-based SPARQL engine implementation
 */
export class QuadstoreSparqlEngine implements SparqlEngine {
  private readonly store: Quadstore;
  private readonly engine: QueryEngine;
  private readonly optimizedEngine: OptimizedQuadstoreEngine;
  private readonly ready: Promise<void>;

  public constructor(endpoint: string) {
    const backend = getBackend(endpoint, { tableName: 'quadstore' });
    this.store = new Quadstore({
      backend: backend as any,
      dataFactory: DataFactory as any,
    });
    this.engine = new QueryEngine();
    this.optimizedEngine = new OptimizedQuadstoreEngine(this.store);
    this.ready = this.store.open();
  }

  public async queryBindings(query: string, basePath: string): Promise<any> {
    await this.ready;
    return this.engine.queryBindings(query, this.createContext(basePath) as unknown as any);
  }

  public async queryQuads(query: string, basePath: string): Promise<any> {
    await this.ready;
    return this.engine.queryQuads(query, this.createContext(basePath) as unknown as any);
  }

  public async queryBoolean(query: string, basePath: string): Promise<boolean> {
    await this.ready;
    return this.engine.queryBoolean(query, this.createContext(basePath) as unknown as any);
  }

  public async queryVoid(query: string, basePath: string): Promise<void> {
    await this.ready;
    await this.optimizedEngine.queryVoid(query, { baseIRI: basePath });
  }

  public async constructGraph(graph: string, basePath: string): Promise<AsyncIterator<Quad>> {
    await this.ready;
    const constructQuery = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`;
    return this.engine.queryQuads(constructQuery, this.createContext(basePath) as unknown as any) as unknown as AsyncIterator<Quad>;
  }

  public async listGraphs(basePath: string): Promise<Set<string>> {
    await this.ready;
    const graphs = new Set<string>();
    
    const query = `
      SELECT DISTINCT ?g WHERE {
        GRAPH ?g { ?s ?p ?o }
        FILTER(STRSTARTS(STR(?g), "${basePath}"))
      }
    `;
    
    const stream = await this.optimizedEngine.queryBindings(query);
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

  public async close(): Promise<void> {
    await this.store.close();
  }

  private createContext(basePath: string): QueryContext {
    return {
      unionDefaultGraph: true,
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

    if (graphValue.startsWith('meta:')) {
      graphValue = graphValue.slice(5);
    }

    if (graphValue === basePath) {
      return true;
    }

    const childPrefix = basePath.endsWith('/') ? basePath : `${basePath}/`;
    const fragmentPrefix = `${basePath}#`;

    if (graphValue.startsWith(childPrefix) || graphValue.startsWith(fragmentPrefix)) {
      return true;
    }

    let pathOnly = basePath;
    try {
      const url = new URL(basePath);
      pathOnly = url.pathname;
    } catch {
      // basePath is already a path
    }

    if (pathOnly === basePath) {
      return false;
    }

    if (graphValue.startsWith('meta:')) {
       graphValue = graphValue.slice(5);
    }

    if (graphValue === pathOnly) {
      return true;
    }

    const pathChildPrefix = pathOnly.endsWith('/') ? pathOnly : `${pathOnly}/`;
    const pathFragmentPrefix = `${pathOnly}#`;

    return graphValue.startsWith(pathChildPrefix) || graphValue.startsWith(pathFragmentPrefix);
  }
}

/**
 * QuintStore-based SPARQL engine implementation
 * 
 * Uses security filters to enforce access boundaries,
 * which are pushed down to the storage layer.
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

  public async queryBindings(query: string, basePath: string): Promise<any> {
    await this.ready;
    return this.engine.queryBindings(query, {
      baseIRI: basePath,
      filters: { graph: { $startsWith: basePath } },
    });
  }

  public async queryQuads(query: string, basePath: string): Promise<any> {
    await this.ready;
    return this.engine.queryQuads(query, {
      baseIRI: basePath,
      filters: { graph: { $startsWith: basePath } },
    });
  }

  public async queryBoolean(query: string, basePath: string): Promise<boolean> {
    await this.ready;
    return this.engine.queryBoolean(query, {
      baseIRI: basePath,
      filters: { graph: { $startsWith: basePath } },
    });
  }

  public async queryVoid(query: string, basePath: string): Promise<void> {
    await this.ready;
    // UPDATE queries have their own graph validation in SubgraphSparqlHttpHandler
    return this.engine.queryVoid(query, {
      baseIRI: basePath,
      filters: { graph: { $startsWith: basePath } },
    });
  }

  public async constructGraph(graph: string, basePath: string): Promise<AsyncIterator<Quad>> {
    await this.ready;
    // CONSTRUCT with explicit graph IRI - security filter still applies
    const constructQuery = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`;
    return this.engine.queryQuads(constructQuery, {
      baseIRI: basePath,
      filters: { graph: { $startsWith: basePath } },
    }) as unknown as AsyncIterator<Quad>;
  }

  public async listGraphs(basePath: string): Promise<Set<string>> {
    await this.ready;
    const graphs = new Set<string>();
    
    const query = `SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }`;
    
    const stream = await this.engine.queryBindings(query, {
      baseIRI: basePath,
      filters: { graph: { $startsWith: basePath } },
    });
    
    try {
      for await (const binding of stream as unknown as AsyncIterator<Bindings>) {
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

  public async close(): Promise<void> {
    await this.store.close();
  }
}

/**
 * SubgraphQueryEngine - SPARQL engine with subgraph (tenant) isolation
 * 
 * Wraps a SparqlEngine implementation for use in the system.
 */
export class SubgraphQueryEngine {
  private readonly logger = getLoggerFor(this);
  private readonly impl: SparqlEngine;

  /**
   * Create a SubgraphQueryEngine
   * @param engine - A SparqlEngine implementation (QuadstoreSparqlEngine or QuintstoreSparqlEngine)
   */
  public constructor(engine: SparqlEngine) {
    this.impl = engine;
  }

  public async queryBindings(query: string, basePath: string): Promise<any> {
    return this.impl.queryBindings(query, basePath);
  }

  public async queryQuads(query: string, basePath: string): Promise<any> {
    return this.impl.queryQuads(query, basePath);
  }

  public async queryBoolean(query: string, basePath: string): Promise<boolean> {
    return this.impl.queryBoolean(query, basePath);
  }

  public async queryVoid(query: string, basePath: string): Promise<void> {
    return this.impl.queryVoid(query, basePath);
  }

  public async constructGraph(graph: string, basePath: string): Promise<AsyncIterator<Quad>> {
    return this.impl.constructGraph(graph, basePath);
  }

  public async listGraphs(basePath: string): Promise<Set<string>> {
    return this.impl.listGraphs(basePath);
  }

  public async close(): Promise<void> {
    return this.impl.close();
  }
}
