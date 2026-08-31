import type { Quad } from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import { getLoggerFor } from 'global-logger-factory';
import type { RdfAccessScope } from '../rdf/RdfAccessScope';

export interface SparqlLoadDocumentOptions {
  sourceUri: string;
  body: string;
  mediaType?: string;
}

export interface SparqlQueryOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SparqlVoidOptions extends SparqlQueryOptions {
  loadDocument?: SparqlLoadDocumentOptions;
}

/**
 * SPARQL Engine interface - common abstraction for SPARQL query engines
 */
export interface SparqlEngine {
  queryBindings(query: string, basePath: string, accessScope?: RdfAccessScope, options?: SparqlQueryOptions): Promise<any>;
  queryQuads(query: string, basePath: string, accessScope?: RdfAccessScope, options?: SparqlQueryOptions): Promise<any>;
  queryBoolean(query: string, basePath: string, accessScope?: RdfAccessScope, options?: SparqlQueryOptions): Promise<boolean>;
  queryVoid(query: string, basePath: string, accessScope?: RdfAccessScope, options?: SparqlVoidOptions): Promise<void>;
  constructGraph(graph: string, basePath: string, accessScope?: RdfAccessScope): Promise<AsyncIterator<Quad>>;
  listGraphs(basePath: string, accessScope?: RdfAccessScope): Promise<Set<string>>;
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

  public async queryBindings(query: string, basePath: string, accessScope?: RdfAccessScope, options?: SparqlQueryOptions): Promise<any> {
    return this.impl.queryBindings(query, basePath, accessScope, options);
  }

  public async queryQuads(query: string, basePath: string, accessScope?: RdfAccessScope, options?: SparqlQueryOptions): Promise<any> {
    return this.impl.queryQuads(query, basePath, accessScope, options);
  }

  public async queryBoolean(query: string, basePath: string, accessScope?: RdfAccessScope, options?: SparqlQueryOptions): Promise<boolean> {
    return this.impl.queryBoolean(query, basePath, accessScope, options);
  }

  public async queryVoid(query: string, basePath: string, accessScope?: RdfAccessScope, options?: SparqlVoidOptions): Promise<void> {
    return this.impl.queryVoid(query, basePath, accessScope, options);
  }

  public async constructGraph(graph: string, basePath: string, accessScope?: RdfAccessScope): Promise<AsyncIterator<Quad>> {
    return this.impl.constructGraph(graph, basePath, accessScope);
  }

  public async listGraphs(basePath: string, accessScope?: RdfAccessScope): Promise<Set<string>> {
    return this.impl.listGraphs(basePath, accessScope);
  }

  public async close(): Promise<void> {
    return this.impl.close();
  }
}
