import { ArrayIterator } from 'asynciterator';
import type { AsyncIterator } from 'asynciterator';
import type { DefaultGraph, Quad, Quad_Object, Term, Variable } from '@rdfjs/types';
import { DataFactory as RdfDataFactory } from 'rdf-data-factory';
import { termToId } from 'n3';
import type { SparqlEngine } from '../sparql/SubgraphQueryEngine';
import type { QuintPattern } from '../quint/types';
import { DisabledSparqlFeatureError, RdfSparqlAdapter, UnsupportedSparqlQueryError } from './RdfSparqlAdapter';
import type { ShadowRdfQuintStore } from './ShadowRdfQuintStore';
import type { RdfBindingRow, RdfEngineLike, RdfLocalQueryResult, RdfQueryTermPattern } from './types';

export interface SolidRdfSparqlEngineOptions {
  rdfEngine: RdfEngineLike;
  fallback?: SparqlEngine;
  shadowStore?: ShadowRdfQuintStore;
  enablePrimary?: boolean;
  onFallback?: (reason: SolidRdfSparqlFallback) => void;
}

export interface SolidRdfSparqlFallback {
  operation: 'queryBindings' | 'queryBoolean' | 'queryQuads' | 'queryVoid' | 'constructGraph' | 'listGraphs';
  reason: string;
}

export type SolidRdfSparqlOperation = SolidRdfSparqlFallback['operation'];

export interface SolidRdfSparqlOperationCount {
  operation: SolidRdfSparqlOperation;
  primaryCount: number;
  fallbackCount: number;
  totalCount: number;
  fallbackRate: number;
  primaryDurationMs: number;
  fallbackDurationMs: number;
}

export interface SolidRdfSparqlPrimaryMetric {
  operation: SolidRdfSparqlOperation;
  durationMs: number;
  scannedRows: number;
  returnedRows: number;
  plan: string[];
  indexChoices: string[];
}

export interface SolidRdfSparqlFallbackMetric extends SolidRdfSparqlFallback {
  durationMs: number;
}

export interface SolidRdfSparqlMetricsSnapshot {
  primaryCount: number;
  fallbackCount: number;
  totalCount: number;
  fallbackRate: number;
  operationCounts: SolidRdfSparqlOperationCount[];
  lastPrimary?: SolidRdfSparqlPrimaryMetric;
  lastFallback?: SolidRdfSparqlFallbackMetric;
}

export interface SolidRdfSparqlFallbackBudget {
  maxFallbackRate?: number;
  maxFallbackCount?: number;
  operations?: SolidRdfSparqlOperation[];
}

type BindingsStream = AsyncIterator<RdfBindings> & {
  metadata?: () => Promise<{ variables: import('@rdfjs/types').Variable[] }>;
};

interface MutableOperationCount {
  primaryCount: number;
  fallbackCount: number;
  primaryDurationMs: number;
  fallbackDurationMs: number;
}

const rdfDataFactory = new RdfDataFactory();

export class SolidRdfSparqlEngine implements SparqlEngine {
  private readonly adapter = new RdfSparqlAdapter();
  private readonly rdfEngine: RdfEngineLike;
  private readonly fallback?: SparqlEngine;
  private readonly shadowStore?: ShadowRdfQuintStore;
  private readonly enablePrimary: boolean;
  private readonly onFallback?: (reason: SolidRdfSparqlFallback) => void;
  private readonly operationCounts = new Map<SolidRdfSparqlOperation, MutableOperationCount>();
  private lastPrimary?: SolidRdfSparqlPrimaryMetric;
  private lastFallback?: SolidRdfSparqlFallbackMetric;

  public constructor(
    rdfEngine: RdfEngineLike,
    fallback?: SparqlEngine,
    shadowStore?: ShadowRdfQuintStore,
    enablePrimary = true,
    onFallback?: (reason: SolidRdfSparqlFallback) => void,
  ) {
    this.rdfEngine = rdfEngine;
    this.fallback = fallback;
    this.shadowStore = shadowStore;
    this.enablePrimary = enablePrimary;
    this.onFallback = onFallback;
  }

  public async queryBindings(query: string, basePath: string): Promise<BindingsStream> {
    await this.ensureReady();
    if (!this.enablePrimary) {
      return this.fallbackWith('queryBindings', 'primary disabled', (fallback) => fallback.queryBindings(query, basePath));
    }

    const start = Date.now();
    try {
      const compiled = this.adapter.compile(query, basePath);
      if (compiled.queryType !== 'SELECT') {
        return this.fallbackWith('queryBindings', `compiled ${compiled.queryType} cannot produce bindings`, (fallback) => fallback.queryBindings(query, basePath));
      }
      const result = await this.rdfEngine.query(compiled.query);
      this.recordPrimary('queryBindings', start, result);
      return this.bindingsStream(result, compiled.variables);
    } catch (error) {
      if (error instanceof DisabledSparqlFeatureError) {
        throw error;
      }
      return this.fallbackWith('queryBindings', fallbackReason(error), (fallback) => fallback.queryBindings(query, basePath));
    }
  }

  public async queryBoolean(query: string, basePath: string): Promise<boolean> {
    await this.ensureReady();
    if (!this.enablePrimary) {
      return this.fallbackWith('queryBoolean', 'primary disabled', (fallback) => fallback.queryBoolean(query, basePath));
    }

    const start = Date.now();
    try {
      const compiled = this.adapter.compile(query, basePath);
      if (compiled.queryType !== 'ASK') {
        return this.fallbackWith('queryBoolean', `compiled ${compiled.queryType} cannot produce boolean`, (fallback) => fallback.queryBoolean(query, basePath));
      }
      const result = await this.rdfEngine.query(compiled.query);
      this.recordPrimary('queryBoolean', start, result);
      return result.bindings.length > 0;
    } catch (error) {
      if (error instanceof DisabledSparqlFeatureError) {
        throw error;
      }
      return this.fallbackWith('queryBoolean', fallbackReason(error), (fallback) => fallback.queryBoolean(query, basePath));
    }
  }

  public async queryQuads(query: string, basePath: string): Promise<any> {
    await this.ensureReady();
    if (!this.enablePrimary) {
      return this.fallbackWith('queryQuads', 'primary disabled', (fallback) => fallback.queryQuads(query, basePath));
    }

    const start = Date.now();
    try {
      const quads = await this.executeQuadsPrimary(query, basePath, 'queryQuads', start);
      return new ArrayIterator(quads);
    } catch (error) {
      if (error instanceof DisabledSparqlFeatureError) {
        throw error;
      }
      return this.fallbackWith('queryQuads', fallbackReason(error), (fallback) => fallback.queryQuads(query, basePath));
    }
  }

  public async queryVoid(query: string, basePath: string): Promise<void> {
    await this.ensureReady();
    if (!this.enablePrimary) {
      return this.fallbackWith('queryVoid', 'primary disabled', (fallback) => fallback.queryVoid(query, basePath));
    }

    const start = Date.now();
    try {
      const delta = this.adapter.compileUpdateDelta(query, basePath, {
        defaultGraph: implicitUpdateDefaultGraph(basePath),
      });
      let deletedRows = 0;
      let computedDeletes = 0;
      let computedInserts = 0;
      for (const operation of delta.operations) {
        if (operation.type === 'delete') {
          deletedRows += (await this.rdfEngine.applyDelta(operation.quads.map(quadToPattern), [])).deletedRows;
        } else if (operation.type === 'insert') {
          await this.rdfEngine.applyDelta([], operation.quads);
        } else if (operation.type === 'insertDeleteWhere') {
          const result = await this.rdfEngine.query(operation.query);
          const deletes = this.adapter.materializeDeleteWhere(operation.deletes, result.bindings);
          const inserts = this.adapter.materializeDeleteWhere(operation.inserts, result.bindings);
          computedDeletes += deletes.length;
          computedInserts += inserts.length;
          deletedRows += (await this.rdfEngine.applyDelta(deletes.map(quadToPattern), inserts)).deletedRows;
        } else if (operation.type === 'insertWhere') {
          const result = await this.rdfEngine.query(operation.query);
          const inserts = this.adapter.materializeDeleteWhere(operation.inserts, result.bindings);
          computedInserts += inserts.length;
          await this.rdfEngine.applyDelta([], inserts);
        } else {
          const result = await this.rdfEngine.query(operation.query);
          const quads = this.adapter.materializeDeleteWhere(operation.template, result.bindings);
          computedDeletes += quads.length;
          deletedRows += (await this.rdfEngine.applyDelta(quads.map(quadToPattern), [])).deletedRows;
        }
      }
      this.recordPrimary('queryVoid', start, {
        bindings: [],
        metrics: {
          engine: 'solid-rdf',
          plan: ['UpdateDelta', `delete:${delta.deletes.length + computedDeletes}`, `deletedRows:${deletedRows}`, `insert:${delta.inserts.length + computedInserts}`],
          scannedRows: delta.deletes.length + computedDeletes + delta.inserts.length + computedInserts,
          joinedRows: 0,
          returnedRows: 0,
          durationMs: Date.now() - start,
          indexChoices: ['update-delta'],
          filtersApplied: 0,
          filtersPushedDown: 0,
        },
      });
      return undefined;
    } catch (error) {
      if (error instanceof DisabledSparqlFeatureError) {
        throw error;
      }
      return this.fallbackWith('queryVoid', fallbackReason(error), (fallback) => fallback.queryVoid(query, basePath));
    }
  }

  public async constructGraph(graph: string, basePath: string): Promise<AsyncIterator<Quad>> {
    await this.ensureReady();
    if (!this.enablePrimary) {
      return this.fallbackWith('constructGraph', 'primary disabled', (fallback) => fallback.constructGraph(graph, basePath));
    }
    if (!graph.startsWith(basePath)) {
      return new ArrayIterator([] as Quad[]);
    }

    const start = Date.now();
    try {
      const quads = await this.executeConstructPrimary(`
        CONSTRUCT { ?s ?p ?o }
        WHERE { GRAPH <${escapeIri(graph)}> { ?s ?p ?o } }
      `, basePath, 'constructGraph', start);
      return new ArrayIterator(quads);
    } catch (error) {
      if (error instanceof DisabledSparqlFeatureError) {
        throw error;
      }
      return this.fallbackWith('constructGraph', fallbackReason(error), (fallback) => fallback.constructGraph(graph, basePath));
    }
  }

  public async listGraphs(basePath: string): Promise<Set<string>> {
    await this.ensureReady();
    if (!this.enablePrimary) {
      return this.fallbackWith('listGraphs', 'primary disabled', (fallback) => fallback.listGraphs(basePath));
    }

    const start = Date.now();
    try {
      const result = await this.executeSelectPrimary(`
        SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }
      `, basePath, 'listGraphs', start);
      const graphs = new Set<string>();
      for (const binding of result.bindings) {
        const graph = binding.g;
        if (graph?.termType === 'NamedNode') {
          graphs.add(graph.value);
        }
      }
      return graphs;
    } catch (error) {
      if (error instanceof DisabledSparqlFeatureError) {
        throw error;
      }
      return this.fallbackWith('listGraphs', fallbackReason(error), (fallback) => fallback.listGraphs(basePath));
    }
  }

  public async close(): Promise<void> {
    await this.rdfEngine.close();
    await this.fallback?.close();
  }

  public getMetrics(): SolidRdfSparqlMetricsSnapshot {
    const operationCounts = [...this.operationCounts.entries()]
      .map(([ operation, counts ]) => operationCountSnapshot(operation, counts))
      .sort((left, right) => left.operation.localeCompare(right.operation));
    const primaryCount = operationCounts.reduce((sum, counts) => sum + counts.primaryCount, 0);
    const fallbackCount = operationCounts.reduce((sum, counts) => sum + counts.fallbackCount, 0);
    const totalCount = primaryCount + fallbackCount;
    return {
      primaryCount,
      fallbackCount,
      totalCount,
      fallbackRate: ratio(fallbackCount, totalCount),
      operationCounts,
      lastPrimary: this.lastPrimary,
      lastFallback: this.lastFallback,
    };
  }

  public assertFallbackBudget(budget: SolidRdfSparqlFallbackBudget = {}): void {
    const snapshot = this.getMetrics();
    const maxFallbackRate = budget.maxFallbackRate ?? 0;
    const maxFallbackCount = budget.maxFallbackCount ?? 0;
    const operationSet = budget.operations ? new Set(budget.operations) : undefined;
    const counts = operationSet
      ? snapshot.operationCounts.filter((count) => operationSet.has(count.operation))
      : snapshot.operationCounts;
    const primaryCount = counts.reduce((sum, count) => sum + count.primaryCount, 0);
    const fallbackCount = counts.reduce((sum, count) => sum + count.fallbackCount, 0);
    const totalCount = primaryCount + fallbackCount;
    const fallbackRate = ratio(fallbackCount, totalCount);
    if (fallbackCount <= maxFallbackCount && fallbackRate <= maxFallbackRate) {
      return;
    }
    const scope = operationSet ? ` for ${[...operationSet].join(',')}` : '';
    const reason = snapshot.lastFallback ? `; last fallback ${snapshot.lastFallback.operation}: ${snapshot.lastFallback.reason}` : '';
    throw new Error(`SolidRdfSparql fallback budget exceeded${scope}: ${fallbackCount}/${totalCount} (${fallbackRate}) > count ${maxFallbackCount}, rate ${maxFallbackRate}${reason}`);
  }

  public resetMetrics(): void {
    this.operationCounts.clear();
    this.lastPrimary = undefined;
    this.lastFallback = undefined;
  }

  private bindingsStream(result: RdfLocalQueryResult, variables: string[]): BindingsStream {
    const projectedVariables = variables.length > 0
      ? variables
      : inferVariables(result.bindings);
    const rows = result.bindings.map((binding) => this.bindings(binding, projectedVariables));
    const iterator = new ArrayIterator(rows) as BindingsStream;
    iterator.metadata = async () => ({
      variables: projectedVariables.map((variableName) => rdfDataFactory.variable(variableName) as import('@rdfjs/types').Variable),
    });
    return iterator;
  }

  private bindings(binding: RdfBindingRow, variables: string[]): RdfBindings {
    const entries: [Variable, Term][] = variables
      .map((variableName) => {
        const term = binding[variableName];
        return term ? [rdfDataFactory.variable(variableName) as Variable, term] : null;
      })
      .filter((entry): entry is [Variable, Term] => entry !== null);
    return new RdfBindings(entries);
  }

  private async fallbackWith<T>(
    operation: SolidRdfSparqlOperation,
    reason: string,
    run: (fallback: SparqlEngine) => Promise<T>,
  ): Promise<T> {
    if (!this.fallback) {
      throw new UnsupportedSparqlQueryError(`No compatibility SPARQL fallback configured for ${operation}: ${reason}`);
    }
    this.onFallback?.({ operation, reason });
    const start = Date.now();
    try {
      return await run(this.fallback);
    } finally {
      this.recordFallback(operation, reason, Date.now() - start);
    }
  }

  private async ensureReady(): Promise<void> {
    if (this.shadowStore) {
      await this.shadowStore.open();
    }
  }

  private async executeSelectPrimary(
    query: string,
    basePath: string,
    operation: SolidRdfSparqlOperation,
    start: number,
  ): Promise<RdfLocalQueryResult> {
    const compiled = this.adapter.compile(query, basePath);
    if (compiled.queryType !== 'SELECT') {
      throw new UnsupportedSparqlQueryError(`compiled ${compiled.queryType} cannot produce bindings`);
    }
    const result = await this.rdfEngine.query(compiled.query);
    this.recordPrimary(operation, start, result);
    return result;
  }

  private async executeConstructPrimary(
    query: string,
    basePath: string,
    operation: SolidRdfSparqlOperation,
    start: number,
  ): Promise<Quad[]> {
    const compiled = this.adapter.compile(query, basePath);
    if (compiled.queryType !== 'CONSTRUCT' || !compiled.constructTemplate) {
      throw new UnsupportedSparqlQueryError(`compiled ${compiled.queryType} cannot produce quads`);
    }
    const result = await this.rdfEngine.query(compiled.query);
    const quads = this.adapter.materializeConstruct(compiled.constructTemplate, result.bindings, rdfDataFactory.defaultGraph() as Term);
    this.recordPrimary(operation, start, {
      ...result,
      bindings: [],
      metrics: {
        ...result.metrics,
        returnedRows: quads.length,
        plan: [...result.metrics.plan, 'Construct'],
      },
    });
    return quads;
  }

  private async executeQuadsPrimary(
    query: string,
    basePath: string,
    operation: SolidRdfSparqlOperation,
    start: number,
  ): Promise<Quad[]> {
    const compiled = this.adapter.compile(query, basePath);
    if (compiled.queryType === 'CONSTRUCT' && compiled.constructTemplate) {
      const result = await this.rdfEngine.query(compiled.query);
      const quads = this.adapter.materializeConstruct(compiled.constructTemplate, result.bindings, rdfDataFactory.defaultGraph() as Term);
      this.recordPrimary(operation, start, {
        ...result,
        bindings: [],
        metrics: {
          ...result.metrics,
          returnedRows: quads.length,
          plan: [...result.metrics.plan, 'Construct'],
        },
      });
      return quads;
    }
    if (compiled.queryType === 'DESCRIBE' && compiled.describeTargets) {
      return this.executeDescribePrimary(compiled.query, compiled.describeTargets, basePath, operation, start);
    }
    throw new UnsupportedSparqlQueryError(`compiled ${compiled.queryType} cannot produce quads`);
  }

  private async executeDescribePrimary(
    query: import('./types').RdfLocalQuery,
    targets: RdfQueryTermPattern[],
    basePath: string,
    operation: SolidRdfSparqlOperation,
    start: number,
  ): Promise<Quad[]> {
    const seed = await this.rdfEngine.query(query);
    const quads: Quad[] = [];
    const seen = new Set<string>();

    for (const target of targets) {
      for (const binding of seed.bindings) {
        const subject = resolveQueryTerm(target, binding);
        if (!subject || subject.termType !== 'NamedNode') {
          continue;
        }
        const describe = await this.rdfEngine.query({
          patterns: [
            {
              subject,
              predicate: { variable: 'p' },
              object: { variable: 'o' },
              graph: { $startsWith: basePath },
            },
          ],
          select: ['p', 'o'],
        });
        for (const row of describe.bindings) {
          const predicate = row.p;
          const object = row.o;
          if (predicate?.termType !== 'NamedNode' || !isQuadObjectTerm(object)) {
            continue;
          }
          const quad = rdfDataFactory.quad(subject, predicate, object, rdfDataFactory.defaultGraph() as DefaultGraph) as Quad;
          const key = [quad.subject, quad.predicate, quad.object, quad.graph].map((term) => termToId(term as any)).join('\u001f');
          if (!seen.has(key)) {
            seen.add(key);
            quads.push(quad);
          }
        }
      }
    }

    this.recordPrimary(operation, start, {
      bindings: [],
      metrics: {
        ...seed.metrics,
        returnedRows: quads.length,
        plan: [...seed.metrics.plan, 'Describe'],
      },
    });
    return quads;
  }

  private recordPrimary(
    operation: SolidRdfSparqlOperation,
    start: number,
    result: RdfLocalQueryResult,
  ): void {
    const durationMs = Date.now() - start;
    const counts = this.countsFor(operation);
    counts.primaryCount += 1;
    counts.primaryDurationMs += durationMs;
    this.lastPrimary = {
      operation,
      durationMs,
      scannedRows: result.metrics.scannedRows,
      returnedRows: result.metrics.returnedRows,
      plan: result.metrics.plan,
      indexChoices: result.metrics.indexChoices,
    };
  }

  private recordFallback(operation: SolidRdfSparqlOperation, reason: string, durationMs: number): void {
    const counts = this.countsFor(operation);
    counts.fallbackCount += 1;
    counts.fallbackDurationMs += durationMs;
    this.lastFallback = {
      operation,
      reason,
      durationMs,
    };
  }

  private countsFor(operation: SolidRdfSparqlOperation): MutableOperationCount {
    const existing = this.operationCounts.get(operation);
    if (existing) {
      return existing;
    }
    const created = {
      primaryCount: 0,
      fallbackCount: 0,
      primaryDurationMs: 0,
      fallbackDurationMs: 0,
    };
    this.operationCounts.set(operation, created);
    return created;
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

function inferVariables(bindings: RdfBindingRow[]): string[] {
  const names = new Set<string>();
  for (const binding of bindings) {
    for (const name of Object.keys(binding)) {
      names.add(name);
    }
  }
  return [...names];
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

function fallbackReason(error: unknown): string {
  if (error instanceof UnsupportedSparqlQueryError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function operationCountSnapshot(
  operation: SolidRdfSparqlOperation,
  counts: MutableOperationCount,
): SolidRdfSparqlOperationCount {
  const totalCount = counts.primaryCount + counts.fallbackCount;
  return {
    operation,
    primaryCount: counts.primaryCount,
    fallbackCount: counts.fallbackCount,
    totalCount,
    fallbackRate: ratio(counts.fallbackCount, totalCount),
    primaryDurationMs: counts.primaryDurationMs,
    fallbackDurationMs: counts.fallbackDurationMs,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function implicitUpdateDefaultGraph(basePath: string): string | undefined {
  return basePath.endsWith('/') ? undefined : basePath;
}

function quadToPattern(quad: Quad): QuintPattern {
  return {
    graph: quad.graph,
    subject: quad.subject,
    predicate: quad.predicate,
    object: quad.object,
  };
}

function escapeIri(value: string): string {
  return value.replace(/[<>"{}|^`\\]/g, (char) => encodeURIComponent(char));
}
