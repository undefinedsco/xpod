import type { AsyncIterator } from 'asynciterator';
import { ArrayIterator } from 'asynciterator';
import type { Quad, Term, Variable } from '@rdfjs/types';
import { Parser as N3Parser } from 'n3';
import { DataFactory as RdfDataFactory } from 'rdf-data-factory';
import type {
  SparqlEngine,
  SparqlQueryOptions,
  SparqlVoidOptions,
} from '../sparql/SubgraphQueryEngine';
import type { RdfAccessScope } from './RdfAccessScope';
import {
  assertServerOwnedNativeSparqlQuery,
  NativeSparqlExecutionError,
  NativeSparqlTimeoutError,
  UnsupportedSparqlQueryError,
} from './RdfSparqlBoundary';
import { serializeSparqlIri } from './RdfSparqlSerialization';
import type {
  RdfEngineLike,
  RdfNativeSparqlResult,
} from './types';

type QleverBindingsStream = AsyncIterator<QleverBindings> & {
  metadata(): Promise<{ variables: Variable[] }>;
};

const rdfDataFactory = new RdfDataFactory();
const XPOD_RDF_STATUS_CANCELLED = 3;

/**
 * Thin CSS SparqlEngine adapter over the shared native QLever envelope.
 *
 * It performs product-boundary validation and result decoding only. It has no
 * alternate evaluator, planner, update compiler, or secondary execution path.
 */
export class QleverSparqlEngine implements SparqlEngine {
  public constructor(private readonly rdfEngine: RdfEngineLike) {
    if (typeof rdfEngine.sparqlQuery !== 'function') {
      throw new Error('QleverSparqlEngine requires an RdfEngine with native SPARQL support');
    }
  }

  public async queryBindings(
    query: string,
    basePath: string,
    accessScope?: RdfAccessScope,
    options?: SparqlQueryOptions,
  ): Promise<QleverBindingsStream> {
    const result = await this.execute(
      query,
      basePath,
      'queryBindings',
      'application/sparql-results+json',
      accessScope,
      options,
    );
    const payload = parseSparqlJson(result);
    if (!payload.results) {
      throw new NativeSparqlExecutionError('QLever SELECT result does not contain bindings');
    }
    const variables = payload.head?.vars ?? inferVariableNames(payload.results.bindings ?? []);
    const rows = (payload.results.bindings ?? []).map((row) => toBindings(row, variables));
    const iterator = new ArrayIterator(rows) as unknown as QleverBindingsStream;
    iterator.metadata = async () => ({
      variables: variables.map((name) => rdfDataFactory.variable(name) as Variable),
    });
    return iterator;
  }

  public async queryBoolean(
    query: string,
    basePath: string,
    accessScope?: RdfAccessScope,
    options?: SparqlQueryOptions,
  ): Promise<boolean> {
    const result = await this.execute(
      query,
      basePath,
      'queryBoolean',
      'application/sparql-results+json',
      accessScope,
      options,
    );
    const payload = parseSparqlJson(result);
    if (typeof payload.boolean !== 'boolean') {
      throw new NativeSparqlExecutionError('QLever ASK result does not contain a boolean');
    }
    return payload.boolean;
  }

  public async queryQuads(
    query: string,
    basePath: string,
    accessScope?: RdfAccessScope,
    options?: SparqlQueryOptions,
  ): Promise<AsyncIterator<Quad>> {
    const result = await this.execute(
      query,
      basePath,
      'queryQuads',
      'application/n-quads',
      accessScope,
      options,
    );
    return new ArrayIterator(parseGraph(result));
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
    return this.queryQuads(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ${serializeSparqlIri(graph)} { ?s ?p ?o } }`,
      basePath,
      accessScope,
    );
  }

  public async listGraphs(
    basePath: string,
    accessScope?: RdfAccessScope,
  ): Promise<Set<string>> {
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
    return graphs;
  }

  public async close(): Promise<void> {
    await this.rdfEngine.close();
  }

  private async execute(
    query: string,
    basePath: string,
    operation: string,
    acceptMediaType: string,
    accessScope?: RdfAccessScope,
    options?: SparqlQueryOptions,
  ): Promise<RdfNativeSparqlResult> {
    assertServerOwnedNativeSparqlQuery(query, basePath);
    const result = await this.rdfEngine.sparqlQuery!(query, {
      basePath,
      operation,
      acceptMediaType,
      ...(accessScope ? { accessScope } : {}),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (result.status === 'ok') {
      return result;
    }
    if (result.status === 'unsupported') {
      throw new UnsupportedSparqlQueryError(
        result.error || 'QLever reported the SPARQL query as unsupported',
        { capability: 'sparql.qlever' },
      );
    }
    if (options?.timeoutMs !== undefined && result.queryStatus === XPOD_RDF_STATUS_CANCELLED) {
      throw new NativeSparqlTimeoutError(options.timeoutMs, result.error);
    }
    throw new NativeSparqlExecutionError(result.error || 'QLever returned an error result');
  }
}

interface SparqlJsonPayload {
  head?: { vars?: string[] };
  boolean?: boolean;
  results?: { bindings?: Array<Record<string, unknown>> };
}

function parseSparqlJson(result: RdfNativeSparqlResult): SparqlJsonPayload {
  try {
    return JSON.parse(result.body) as SparqlJsonPayload;
  } catch (error) {
    throw new NativeSparqlExecutionError(
      `QLever returned invalid SPARQL JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseGraph(result: RdfNativeSparqlResult): Quad[] {
  const mediaType = result.mediaType.toLowerCase();
  try {
    return new N3Parser({
      format: mediaType.includes('n-quads')
        ? 'N-Quads'
        : mediaType.includes('turtle')
          ? 'Turtle'
          : 'N-Triples',
    }).parse(result.body) as unknown as Quad[];
  } catch (error) {
    throw new NativeSparqlExecutionError(
      `QLever returned an invalid graph result: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function toBindings(row: Record<string, unknown>, variables: string[]): QleverBindings {
  const entries: [Variable, Term][] = [];
  for (const variable of variables) {
    const term = sparqlJsonTerm(row[variable]);
    if (term) {
      entries.push([ rdfDataFactory.variable(variable) as Variable, term ]);
    }
  }
  return new QleverBindings(entries);
}

function inferVariableNames(rows: Array<Record<string, unknown>>): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    for (const name of Object.keys(row)) {
      names.add(name);
    }
  }
  return [ ...names ];
}

function sparqlJsonTerm(value: unknown): Term | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const term = value as {
    type?: string;
    value?: string;
    datatype?: string;
    'xml:lang'?: string;
  };
  if (typeof term.value !== 'string') {
    return undefined;
  }
  if (term.type === 'uri') {
    return rdfDataFactory.namedNode(term.value);
  }
  if (term.type === 'bnode') {
    return rdfDataFactory.blankNode(term.value);
  }
  if (term.type === 'literal' || term.type === 'typed-literal') {
    if (term['xml:lang']) {
      return rdfDataFactory.literal(term.value, term['xml:lang']);
    }
    if (term.datatype) {
      return rdfDataFactory.literal(term.value, rdfDataFactory.namedNode(term.datatype));
    }
    return rdfDataFactory.literal(term.value);
  }
  return undefined;
}

class QleverBindings extends Map<Variable, Term> {
  private readonly byName = new Map<string, Term>();

  public constructor(entries: [Variable, Term][]) {
    super(entries);
    for (const [ variable, term ] of entries) {
      this.byName.set(variable.value, term);
    }
  }

  public override get(key: string | Variable): Term | undefined {
    return typeof key === 'string'
      ? this.byName.get(key)
      : this.byName.get(key.value) ?? super.get(key);
  }

  public override has(key: string | Variable): boolean {
    return typeof key === 'string'
      ? this.byName.has(key)
      : this.byName.has(key.value) || super.has(key);
  }
}
