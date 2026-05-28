import type { Quad } from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import { getLoggerFor } from 'global-logger-factory';

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
 * SubgraphQueryEngine - SPARQL engine with subgraph (tenant) isolation
 * 
 * Wraps a SparqlEngine implementation for use in the system.
 */
export class SubgraphQueryEngine {
  private readonly logger = getLoggerFor(this);
  private readonly impl: SparqlEngine;

  /**
   * Create a SubgraphQueryEngine
   * @param engine - A SparqlEngine implementation
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
