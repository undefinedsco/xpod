import type { Quad } from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import type { SparqlEngine } from './SubgraphQueryEngine';
import type { QuintStore } from '../quint/types';

type CompatibilityModule = typeof import('./CompatibilitySparqlEngineImpl');

function loadCompatibilityModule(): CompatibilityModule {
  return require('./CompatibilitySparqlEngineImpl') as CompatibilityModule;
}

/**
 * @deprecated Compatibility wrapper preserved for older call sites.
 * Mainline xpod uses SolidRdfEngine for server-owned Pod queries.
 *
 * This file intentionally avoids static Comunica imports so exposing the
 * component type does not load the compatibility implementation.
 */
export class QuadstoreSparqlEngine implements SparqlEngine {
  private readonly delegate: SparqlEngine;

  public constructor(endpoint: string) {
    const { QuadstoreSparqlEngine } = loadCompatibilityModule();
    this.delegate = new QuadstoreSparqlEngine(endpoint);
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
 * Comunica-backed compatibility engine component.
 */
export class QuintstoreSparqlEngine implements SparqlEngine {
  private readonly delegate: SparqlEngine;

  public constructor(store: QuintStore) {
    const { QuintstoreSparqlEngine } = loadCompatibilityModule();
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
