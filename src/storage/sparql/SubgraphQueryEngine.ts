import type { Quad } from '@rdfjs/types';
import type { Bindings } from '@comunica/types';
import type { AsyncIterator } from 'asynciterator';
import { getLoggerFor } from 'global-logger-factory';
import { ComunicaQuintEngine } from './ComunicaQuintEngine';
import { QuintEngine } from './QuintEngine';
import type { QuintStore } from '../quint/types';

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
 * @deprecated Compatibility wrapper preserved for older call sites.
 * Mainline xpod now executes subgraph queries through QuintStore.
 */
export class QuadstoreSparqlEngine implements SparqlEngine {
  private readonly delegate: QuintstoreSparqlEngine;

  public constructor(endpoint: string) {
    const store = new QuintEngine({ endpoint }).getStore();
    this.delegate = new QuintstoreSparqlEngine(store);
  }

  public async queryBindings(query: string, basePath: string): Promise<any> {
    return this.delegate.queryBindings(query, basePath);
  }

  public async queryQuads(query: string, basePath: string): Promise<any> {
    return this.delegate.queryQuads(query, basePath);
  }

  public async queryBoolean(query: string, basePath: string): Promise<boolean> {
    return this.delegate.queryBoolean(query, basePath);
  }

  public async queryVoid(query: string, basePath: string): Promise<void> {
    await this.delegate.queryVoid(query, basePath);
  }

  public async constructGraph(graph: string, basePath: string): Promise<AsyncIterator<Quad>> {
    return this.delegate.constructGraph(graph, basePath);
  }

  public async listGraphs(basePath: string): Promise<Set<string>> {
    return this.delegate.listGraphs(basePath);
  }

  public async close(): Promise<void> {
    await this.delegate.close();
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
