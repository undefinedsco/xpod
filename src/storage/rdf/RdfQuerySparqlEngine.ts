import { ArrayIterator } from 'asynciterator';
import type { AsyncIterator } from 'asynciterator';
import type { DefaultGraph, Quad, Quad_Graph, Quad_Object, Term, Variable } from '@rdfjs/types';
import { DataFactory as RdfDataFactory } from 'rdf-data-factory';
import { termToId } from 'n3';
import type {
  SparqlEngine,
  SparqlQueryOptions,
  SparqlVoidOptions,
} from '../sparql/SubgraphQueryEngine';
import {
  applyRdfAccessScope,
  filterRdfAccessGraphs,
  rdfAccessGraphAllowed,
  type RdfAccessScope,
} from './RdfAccessScope';
import {
  DisabledSparqlFeatureError,
  UnsupportedSparqlQueryError,
} from './RdfSparqlBoundary';
import {
  DisabledSparqlFeatureError as AdapterDisabledSparqlFeatureError,
  RdfSparqlAdapter,
  UnsupportedSparqlQueryError as AdapterUnsupportedSparqlQueryError,
} from './RdfSparqlAdapter';
import type {
  RdfBindingRow,
  RdfEngineLike,
  RdfQuery,
  RdfQueryResult,
  RdfQueryTermPattern,
} from './types';

type BindingsStream = AsyncIterator<RdfBindings> & {
  metadata(): Promise<{ variables: Variable[] }>;
};

const rdfDataFactory = new RdfDataFactory();

/**
 * Public SPARQL engine over the in-process RDF query executor.
 *
 * This is the default Cloud path in the public repository: PostgreSQL facts,
 * RDF-3X/PG acceleration, and no native QLever extension requirement.
 */
export class RdfQuerySparqlEngine implements SparqlEngine {
  private readonly adapter = new RdfSparqlAdapter();

  public constructor(private readonly rdfEngine: RdfEngineLike) {}

  public async queryBindings(
    query: string,
    basePath: string,
    accessScope?: RdfAccessScope,
    _options?: SparqlQueryOptions,
  ): Promise<BindingsStream> {
    const compiled = this.compile(query, basePath);
    if (compiled.queryType !== 'SELECT') {
      throw new UnsupportedSparqlQueryError(`compiled ${compiled.queryType} cannot produce bindings`);
    }
    const result = await this.rdfEngine.query(applyRdfAccessScope(compiled.query, accessScope));
    return this.bindingsStream(result, compiled.variables);
  }

  public async queryBoolean(
    query: string,
    basePath: string,
    accessScope?: RdfAccessScope,
    _options?: SparqlQueryOptions,
  ): Promise<boolean> {
    const compiled = this.compile(query, basePath);
    if (compiled.queryType !== 'ASK') {
      throw new UnsupportedSparqlQueryError(`compiled ${compiled.queryType} cannot produce boolean`);
    }
    const result = await this.rdfEngine.query(applyRdfAccessScope(compiled.query, accessScope));
    return result.bindings.length > 0;
  }

  public async queryQuads(
    query: string,
    basePath: string,
    accessScope?: RdfAccessScope,
    _options?: SparqlQueryOptions,
  ): Promise<AsyncIterator<Quad>> {
    return new ArrayIterator(await this.executeQuads(query, basePath, accessScope));
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
    const graphNode = rdfDataFactory.namedNode(graph);
    const result = await this.rdfEngine.query(applyRdfAccessScope({
      patterns: [
        {
          graph: graphNode,
          subject: { variable: 's' },
          predicate: { variable: 'p' },
          object: { variable: 'o' },
        },
      ],
      select: [ 's', 'p', 'o' ],
    }, accessScope));
    return new ArrayIterator(rowsToQuads(result, graphNode));
  }

  public async listGraphs(basePath: string, accessScope?: RdfAccessScope): Promise<Set<string>> {
    const compiled = this.compile(
      'SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }',
      basePath,
    );
    const result = await this.rdfEngine.query(applyRdfAccessScope(compiled.query, accessScope));
    const graphs = new Set<string>();
    for (const binding of result.bindings) {
      const graph = binding.g;
      if (graph?.termType === 'NamedNode') {
        graphs.add(graph.value);
      }
    }
    return filterRdfAccessGraphs(graphs, accessScope);
  }

  public async close(): Promise<void> {
    await this.rdfEngine.close();
  }

  private compile(query: string, basePath: string): ReturnType<RdfSparqlAdapter['compile']> {
    try {
      return this.adapter.compile(query, basePath);
    } catch (error) {
      throw normalizeAdapterError(error);
    }
  }

  private async executeQuads(
    query: string,
    basePath: string,
    accessScope?: RdfAccessScope,
  ): Promise<Quad[]> {
    const compiled = this.compile(query, basePath);
    if (compiled.queryType === 'CONSTRUCT' && compiled.constructTemplate) {
      const result = await this.rdfEngine.query(applyRdfAccessScope(compiled.query, accessScope));
      return this.adapter.materializeConstruct(
        compiled.constructTemplate,
        result.bindings,
        rdfDataFactory.defaultGraph() as Term,
      );
    }
    if (compiled.queryType === 'DESCRIBE' && compiled.describeTargets) {
      return this.executeDescribe(compiled.query, compiled.describeTargets, basePath, accessScope);
    }
    throw new UnsupportedSparqlQueryError(`compiled ${compiled.queryType} cannot produce quads`);
  }

  private async executeDescribe(
    query: RdfQuery,
    targets: RdfQueryTermPattern[],
    basePath: string,
    accessScope?: RdfAccessScope,
  ): Promise<Quad[]> {
    const seed = await this.rdfEngine.query(applyRdfAccessScope(query, accessScope));
    const quads: Quad[] = [];
    const seen = new Set<string>();
    for (const target of targets) {
      for (const binding of seed.bindings) {
        const subject = resolveQueryTerm(target, binding);
        if (!subject || subject.termType !== 'NamedNode') {
          continue;
        }
        const described = await this.rdfEngine.query(applyRdfAccessScope({
          patterns: [
            {
              subject,
              predicate: { variable: 'p' },
              object: { variable: 'o' },
              graph: { $startsWith: basePath },
            },
          ],
          select: [ 'p', 'o' ],
        }, accessScope));
        for (const row of described.bindings) {
          const predicate = row.p;
          const object = row.o;
          if (predicate?.termType !== 'NamedNode' || !isQuadObjectTerm(object)) {
            continue;
          }
          const quad = rdfDataFactory.quad(
            subject,
            predicate,
            object,
            rdfDataFactory.defaultGraph() as DefaultGraph,
          ) as Quad;
          const key = [ quad.subject, quad.predicate, quad.object, quad.graph ]
            .map((term) => termToId(term as any))
            .join('\u001f');
          if (!seen.has(key)) {
            seen.add(key);
            quads.push(quad);
          }
        }
      }
    }
    return quads;
  }

  private bindingsStream(result: RdfQueryResult, variables: string[]): BindingsStream {
    const projectedVariables = variables.length > 0 ? variables : inferVariables(result.bindings);
    const rows = result.bindings.map((binding) => this.bindings(binding, projectedVariables));
    const iterator = new ArrayIterator(rows) as unknown as BindingsStream;
    iterator.metadata = async () => ({
      variables: projectedVariables.map((name) => rdfDataFactory.variable(name) as Variable),
    });
    return iterator;
  }

  private bindings(binding: RdfBindingRow, variables: string[]): RdfBindings {
    const entries: [Variable, Term][] = variables
      .map((name) => {
        const term = binding[name];
        return term ? [ rdfDataFactory.variable(name) as Variable, term ] : null;
      })
      .filter((entry): entry is [Variable, Term] => entry !== null);
    return new RdfBindings(entries);
  }
}

class RdfBindings extends Map<Variable, Term> {
  private readonly byName = new Map<string, Term>();

  public constructor(entries: [Variable, Term][]) {
    super(entries);
    for (const [ variable, term ] of entries) {
      this.byName.set(variable.value, term);
    }
  }

  public override get(key: string | Variable): Term | undefined {
    if (typeof key === 'string') {
      return this.byName.get(key);
    }
    return this.byName.get(key.value) ?? super.get(key);
  }

  public override has(key: string | Variable): boolean {
    if (typeof key === 'string') {
      return this.byName.has(key);
    }
    return this.byName.has(key.value) || super.has(key);
  }
}

function normalizeAdapterError(error: unknown): Error {
  if (error instanceof AdapterDisabledSparqlFeatureError) {
    return new DisabledSparqlFeatureError(error.message);
  }
  if (error instanceof AdapterUnsupportedSparqlQueryError) {
    return new UnsupportedSparqlQueryError(error.message, {
      code: error.code,
      capability: error.capability,
      hint: error.hint,
      correction: error.correction,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function inferVariables(bindings: RdfBindingRow[]): string[] {
  const names = new Set<string>();
  for (const binding of bindings) {
    for (const name of Object.keys(binding)) {
      names.add(name);
    }
  }
  return [ ...names ];
}

function resolveQueryTerm(term: RdfQueryTermPattern, binding: RdfBindingRow): Term | undefined {
  if (term && typeof term === 'object' && 'variable' in term) {
    return binding[term.variable];
  }
  return term as Term;
}

function isQuadObjectTerm(term: Term | undefined): term is Quad_Object {
  return Boolean(
    term
      && term.termType !== 'Variable'
      && term.termType !== 'DefaultGraph'
      && term.termType !== 'Quad',
  );
}

function rowsToQuads(result: RdfQueryResult, graph: Quad_Graph): Quad[] {
  const quads: Quad[] = [];
  for (const row of result.bindings) {
    const subject = row.s;
    const predicate = row.p;
    const object = row.o;
    if (subject?.termType === 'NamedNode' && predicate?.termType === 'NamedNode' && isQuadObjectTerm(object)) {
      quads.push(rdfDataFactory.quad(subject, predicate, object, graph) as Quad);
    }
  }
  return quads;
}
