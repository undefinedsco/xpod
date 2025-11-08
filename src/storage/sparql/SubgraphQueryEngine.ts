import type { Quad, Quad_Graph, Quad_Object, Quad_Predicate, Quad_Subject } from '@rdfjs/types';
import type { Bindings } from '@comunica/types';
import type { AsyncIterator } from 'asynciterator';
import { QueryEngine } from '@comunica/query-sparql';
import { Quadstore } from 'quadstore';
import { DataFactory } from 'n3';
import { getBackend } from '../../libs/backends';

interface QueryContext {
  sources: [{ type: 'rdfjsSource'; value: { match: (subject?: Quad_Subject | null, predicate?: Quad_Predicate | null, object?: Quad_Object | null, graph?: Quad_Graph | null) => AsyncIterator<Quad> }}];
}

export class SubgraphQueryEngine {
  private readonly store: Quadstore;
  private readonly engine: QueryEngine;
  private readonly ready: Promise<void>;

  public constructor(endpoint: string) {
    const backend = getBackend(endpoint, { tableName: 'quadstore' });
    this.store = new Quadstore({
      backend,
      dataFactory: DataFactory,
    });
    this.engine = new QueryEngine();
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
    await this.engine.queryVoid(query, this.createContext(basePath) as unknown as any);
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
              const filtered = (iterator as unknown as AsyncIterator<Quad>).filter((quad): boolean => this.isInScope(basePath, quad.graph));
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

    if (graph.value === basePath || graph.value === `${basePath}.metadata`) {
      return true;
    }

    if (basePath.endsWith('/')) {
      return graph.value.startsWith(basePath);
    }

    return false;
  }
}
