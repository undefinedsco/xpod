import type { Quad } from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import type { SparqlEngine } from './SubgraphQueryEngine';
import type { QuintStore } from '../quint/types';
import type { RdfAccessScope } from '../rdf/RdfAccessScope';

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

  public async queryBindings(query: string, basePath: string, accessScope?: RdfAccessScope): Promise<any> {
    return (await this.delegate).queryBindings(query, basePath, accessScope);
  }

  public async queryQuads(query: string, basePath: string, accessScope?: RdfAccessScope): Promise<any> {
    return (await this.delegate).queryQuads(query, basePath, accessScope);
  }

  public async queryBoolean(query: string, basePath: string, accessScope?: RdfAccessScope): Promise<boolean> {
    return (await this.delegate).queryBoolean(query, basePath, accessScope);
  }

  public async queryVoid(query: string, basePath: string, accessScope?: RdfAccessScope): Promise<void> {
    await (await this.delegate).queryVoid(query, basePath, accessScope);
  }

  public async constructGraph(graph: string, basePath: string, accessScope?: RdfAccessScope): Promise<AsyncIterator<Quad>> {
    return (await this.delegate).constructGraph(graph, basePath, accessScope);
  }

  public async listGraphs(basePath: string, accessScope?: RdfAccessScope): Promise<Set<string>> {
    return (await this.delegate).listGraphs(basePath, accessScope);
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

  public async queryBindings(query: string, basePath: string, accessScope?: RdfAccessScope): Promise<any> {
    return (await this.delegate).queryBindings(query, basePath, accessScope);
  }

  public async queryQuads(query: string, basePath: string, accessScope?: RdfAccessScope): Promise<any> {
    return (await this.delegate).queryQuads(query, basePath, accessScope);
  }

  public async queryBoolean(query: string, basePath: string, accessScope?: RdfAccessScope): Promise<boolean> {
    return (await this.delegate).queryBoolean(query, basePath, accessScope);
  }

  public async queryVoid(query: string, basePath: string, accessScope?: RdfAccessScope): Promise<void> {
    await (await this.delegate).queryVoid(query, basePath, accessScope);
  }

  public async constructGraph(graph: string, basePath: string, accessScope?: RdfAccessScope): Promise<AsyncIterator<Quad>> {
    return (await this.delegate).constructGraph(graph, basePath, accessScope);
  }

  public async listGraphs(basePath: string, accessScope?: RdfAccessScope): Promise<Set<string>> {
    return (await this.delegate).listGraphs(basePath, accessScope);
  }

  public async close(): Promise<void> {
    await (await this.delegate).close();
  }
}
