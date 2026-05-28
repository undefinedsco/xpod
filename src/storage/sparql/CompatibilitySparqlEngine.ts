import type { Quad } from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import type { SparqlEngine } from './SubgraphQueryEngine';
import type { QuintStore } from '../quint/types';

type CompatibilityModule = typeof import('./CompatibilitySparqlEngineImpl');

async function loadCompatibilityModule(): Promise<CompatibilityModule> {
  return import('./CompatibilitySparqlEngineImpl');
}

/**
 * @deprecated Compatibility wrapper preserved for older call sites.
 * Mainline xpod uses SolidRdfEngine for server-owned Pod queries.
 *
 * This file intentionally avoids static Comunica imports so exposing the
 * component type does not load the compatibility implementation.
 */
export class QuadstoreSparqlEngine implements SparqlEngine {
  private readonly delegate: Promise<SparqlEngine>;

  public constructor(endpoint: string) {
    this.delegate = loadCompatibilityModule()
      .then(({ QuadstoreSparqlEngine }) => new QuadstoreSparqlEngine(endpoint));
  }

  public async queryBindings(query: string, basePath: string): Promise<any> {
    return (await this.delegate).queryBindings(query, basePath);
  }

  public async queryQuads(query: string, basePath: string): Promise<any> {
    return (await this.delegate).queryQuads(query, basePath);
  }

  public async queryBoolean(query: string, basePath: string): Promise<boolean> {
    return (await this.delegate).queryBoolean(query, basePath);
  }

  public async queryVoid(query: string, basePath: string): Promise<void> {
    await (await this.delegate).queryVoid(query, basePath);
  }

  public async constructGraph(graph: string, basePath: string): Promise<AsyncIterator<Quad>> {
    return (await this.delegate).constructGraph(graph, basePath);
  }

  public async listGraphs(basePath: string): Promise<Set<string>> {
    return (await this.delegate).listGraphs(basePath);
  }

  public async close(): Promise<void> {
    await (await this.delegate).close();
  }
}

/**
 * Comunica-backed compatibility engine component.
 */
export class QuintstoreSparqlEngine implements SparqlEngine {
  private readonly delegate: Promise<SparqlEngine>;

  public constructor(store: QuintStore) {
    this.delegate = loadCompatibilityModule()
      .then(({ QuintstoreSparqlEngine }) => new QuintstoreSparqlEngine(store));
  }

  public async queryBindings(query: string, basePath: string): Promise<any> {
    return (await this.delegate).queryBindings(query, basePath);
  }

  public async queryQuads(query: string, basePath: string): Promise<any> {
    return (await this.delegate).queryQuads(query, basePath);
  }

  public async queryBoolean(query: string, basePath: string): Promise<boolean> {
    return (await this.delegate).queryBoolean(query, basePath);
  }

  public async queryVoid(query: string, basePath: string): Promise<void> {
    await (await this.delegate).queryVoid(query, basePath);
  }

  public async constructGraph(graph: string, basePath: string): Promise<AsyncIterator<Quad>> {
    return (await this.delegate).constructGraph(graph, basePath);
  }

  public async listGraphs(basePath: string): Promise<Set<string>> {
    return (await this.delegate).listGraphs(basePath);
  }

  public async close(): Promise<void> {
    await (await this.delegate).close();
  }
}
