import type { AsyncIterator } from 'asynciterator';
import { ArrayIterator } from 'asynciterator';
import type { BindingsStream } from '@comunica/types';
import { DataFactory } from 'n3';
import type { Quad, Quad_Object, Quad_Subject, Term, Variable } from '@rdfjs/types';
import type {
  SparqlEngine,
  SparqlQueryOptions,
  SparqlVoidOptions,
} from '../sparql/SubgraphQueryEngine';
import {
  filterRdfAccessGraphs,
  rdfAccessGraphAllowed,
  RdfAccessMode,
  type RdfAccessScope,
} from './RdfAccessScope';
import { RdfEngineRdfJsSource } from './RdfEngineRdfJsSource';
import {
  assertServerOwnedNativeSparqlQuery,
  DisabledSparqlFeatureError,
  NativeSparqlTimeoutError,
  UnsupportedSparqlQueryError,
} from './RdfSparqlBoundary';
import { serializeSparqlIri } from './RdfSparqlSerialization';
import type { RdfEngineLike } from './types';
import { createXpodComunicaQueryEngine } from './XpodComunicaQueryEngine';

const { namedNode, quad } = DataFactory;

type RdfBindingsStream = BindingsStream & {
  metadata(): Promise<{ variables: Variable[] }>;
};

interface ComunicaBindingsResult {
  resultType: 'bindings';
  execute(): Promise<BindingsStream>;
  metadata(): Promise<{ variables: Variable[] }>;
}

/**
 * Public Cloud SPARQL authority.
 *
 * Comunica is the sole SPARQL algebra evaluator. Every RDF/JS source match is
 * translated into an access-scoped query against the PostgreSQL RDF facts
 * authority; there is no second evaluator or alternate per-query route.
 */
export class RdfQuerySparqlEngine implements SparqlEngine {
  private readonly comunica = createXpodComunicaQueryEngine();

  public constructor(private readonly rdfEngine: RdfEngineLike) {}

  public async queryBindings(
    query: string,
    basePath: string,
    accessScope?: RdfAccessScope,
    options?: SparqlQueryOptions,
  ): Promise<RdfBindingsStream> {
    this.assertCloudQuery(query, basePath);
    const abort = createQueryAbort(options);
    try {
      assertQueryNotAborted(abort.signal);
      const result = await this.comunica.query(query, this.context(basePath, accessScope, abort.signal));
      if (result.resultType !== 'bindings') {
        throw new UnsupportedSparqlQueryError(`${result.resultType} query cannot produce bindings`);
      }
      const bindingsResult = result as ComunicaBindingsResult;
      const bindings = await bindingsResult.execute() as RdfBindingsStream;
      bindings.metadata = bindingsResult.metadata.bind(bindingsResult);
      return abort.watchStream(bindings);
    } catch (error) {
      abort.dispose();
      throw abort.normalize(error);
    }
  }

  public async queryBoolean(
    query: string,
    basePath: string,
    accessScope?: RdfAccessScope,
    options?: SparqlQueryOptions,
  ): Promise<boolean> {
    this.assertCloudQuery(query, basePath);
    const abort = createQueryAbort(options);
    try {
      assertQueryNotAborted(abort.signal);
      const result = await this.comunica.query(query, this.context(basePath, accessScope, abort.signal));
      if (result.resultType !== 'boolean') {
        throw new UnsupportedSparqlQueryError(`${result.resultType} query cannot produce a boolean`);
      }
      return await result.execute();
    } catch (error) {
      throw abort.normalize(error);
    } finally {
      abort.dispose();
    }
  }

  public async queryQuads(
    query: string,
    basePath: string,
    accessScope?: RdfAccessScope,
    options?: SparqlQueryOptions,
  ): Promise<AsyncIterator<Quad>> {
    this.assertCloudQuery(query, basePath);
    const abort = createQueryAbort(options);
    try {
      assertQueryNotAborted(abort.signal);
      const result = await this.comunica.query(query, this.context(basePath, accessScope, abort.signal));
      if (result.resultType !== 'quads') {
        throw new UnsupportedSparqlQueryError(`${result.resultType} query cannot produce quads`);
      }
      return abort.watchStream(await result.execute());
    } catch (error) {
      abort.dispose();
      throw abort.normalize(error);
    }
  }

  public async queryVoid(
    _query: string,
    _basePath: string,
    _accessScope?: RdfAccessScope,
    _options?: SparqlVoidOptions,
  ): Promise<void> {
    throw new UnsupportedSparqlQueryError(
      'Direct SPARQL UPDATE execution is disabled; use the Pod update authority prepared-delta path',
      {
        code: 'rdf.sparql.update_authority_required',
        capability: 'sparql.update.authority',
        hint: 'Send the update through the Pod SPARQL HTTP endpoint so the authority can prepare and atomically commit source-file changes.',
      },
    );
  }

  public async constructGraph(
    graph: string,
    basePath: string,
    accessScope?: RdfAccessScope,
  ): Promise<AsyncIterator<Quad>> {
    if (!graph.startsWith(basePath) || (accessScope && !rdfAccessGraphAllowed(graph, accessScope))) {
      return new ArrayIterator([] as Quad[]);
    }
    const stream = await this.queryBindings(
      `SELECT ?s ?p ?o WHERE { GRAPH ${serializeSparqlIri(graph)} { ?s ?p ?o } }`,
      basePath,
      accessScope,
    );
    const graphNode = namedNode(graph);
    const quads: Quad[] = [];
    for await (const binding of stream) {
      const subject = binding.get('s');
      const predicate = binding.get('p');
      const object = binding.get('o');
      if (isQuadSubjectTerm(subject) && predicate?.termType === 'NamedNode' && isQuadObjectTerm(object)) {
        quads.push(quad(subject, predicate, object, graphNode));
      }
    }
    return new ArrayIterator(quads);
  }

  public async listGraphs(basePath: string, accessScope?: RdfAccessScope): Promise<Set<string>> {
    const stream = await this.queryBindings(
      'SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }',
      basePath,
      accessScope,
    );
    const graphs = new Set<string>();
    for await (const binding of stream) {
      const graph = binding.get('g');
      if (graph?.termType === 'NamedNode') {
        graphs.add(graph.value);
      }
    }
    return filterRdfAccessGraphs(graphs, {
      ...accessScope,
      basePath,
      mode: RdfAccessMode.READ,
    });
  }

  public async close(): Promise<void> {
    await this.rdfEngine.close();
  }

  private context(basePath: string, accessScope: RdfAccessScope | undefined, signal: AbortSignal) {
    const scope: RdfAccessScope = {
      ...accessScope,
      basePath,
      mode: RdfAccessMode.READ,
    };
    return {
      sources: [new RdfEngineRdfJsSource(this.rdfEngine, { accessScope: scope, signal })],
      baseIRI: basePath,
      readOnly: true,
    };
  }

  private assertCloudQuery(query: string, basePath: string): void {
    if (assertServerOwnedNativeSparqlQuery(query, basePath)) {
      throw new DisabledSparqlFeatureError('QLever extension SERVICE clauses are disabled in public Cloud queries');
    }
  }
}

interface QueryAbort {
  signal: AbortSignal;
  dispose(): void;
  normalize(error: unknown): Error;
  watchStream<T extends AsyncIterator<any>>(stream: T): T;
}

function createQueryAbort(options?: SparqlQueryOptions): QueryAbort {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = (): void => controller.abort(options?.signal?.reason);
  if (options?.signal?.aborted) {
    abortFromCaller();
  } else {
    options?.signal?.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timer = options?.timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
        timedOut = true;
        controller.abort(new NativeSparqlTimeoutError(options.timeoutMs!));
      }, options.timeoutMs);
  const dispose = (): void => {
    if (timer) clearTimeout(timer);
    options?.signal?.removeEventListener('abort', abortFromCaller);
  };
  return {
    signal: controller.signal,
    dispose,
    normalize(error: unknown): Error {
      if (timedOut && options?.timeoutMs !== undefined) {
        return new NativeSparqlTimeoutError(options.timeoutMs, errorMessage(error));
      }
      return error instanceof Error ? error : new Error(String(error));
    },
    watchStream<T extends AsyncIterator<any>>(stream: T): T {
      stream.once('end', dispose);
      stream.once('error', dispose);
      const close = stream.close.bind(stream);
      stream.close = (): void => {
        dispose();
        close();
      };
      const destroy = stream.destroy.bind(stream);
      stream.destroy = (cause?: Error): void => {
        dispose();
        destroy(cause);
      };
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = () => {
        const iterator = iterate();
        return {
          next: iterator.next.bind(iterator),
          return: async () => {
            stream.destroy();
            return { done: true, value: undefined };
          },
        };
      };
      return stream;
    },
  };
}

function isQuadObjectTerm(term: Term | undefined): term is Quad_Object {
  return Boolean(
    term
      && term.termType !== 'Variable'
      && term.termType !== 'DefaultGraph'
      && term.termType !== 'Quad',
  );
}

function assertQueryNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('SPARQL query aborted', 'AbortError');
  }
}

function isQuadSubjectTerm(term: Term | undefined): term is Quad_Subject {
  return term?.termType === 'NamedNode' || term?.termType === 'BlankNode';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
