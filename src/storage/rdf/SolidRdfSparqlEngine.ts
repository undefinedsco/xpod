import { ArrayIterator } from 'asynciterator';
import { createHash } from 'node:crypto';
import type { AsyncIterator } from 'asynciterator';
import type { DefaultGraph, Quad, Quad_Object, Term, Variable } from '@rdfjs/types';
import { DataFactory as RdfDataFactory } from 'rdf-data-factory';
import { termToId } from 'n3';
import type { SparqlEngine } from '../sparql/SubgraphQueryEngine';
import type { QuintPattern } from '../quint/types';
import { DisabledSparqlFeatureError, RdfSparqlAdapter, UnsupportedSparqlQueryError } from './RdfSparqlAdapter';
import type { ShadowRdfQuintStore } from './ShadowRdfQuintStore';
import type {
  RdfBindingRow,
  RdfEngineLike,
  RdfQuery,
  RdfQueryMaterializedResultOptions,
  RdfQueryPattern,
  RdfQueryResult,
  RdfQueryTermPattern,
} from './types';
import {
  applyRdfAccessScope,
  filterRdfAccessGraphs,
  isRestrictiveRdfAccessScope,
  rdfAccessGraphAllowed,
  type RdfAccessScope,
} from './RdfAccessScope';

export interface SolidRdfSparqlEngineOptions {
  rdfEngine: RdfEngineLike;
  fallback?: SparqlEngine;
  shadowStore?: ShadowRdfQuintStore;
  enablePrimary?: boolean;
  onFallback?: (reason: SolidRdfSparqlFallback) => void;
  autoMaterializeProductViews?: boolean;
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
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DCT_CREATED = 'http://purl.org/dc/terms/created';
const DCT_TITLE = 'http://purl.org/dc/terms/title';
const SIOC_HAS_CONTAINER = 'http://rdfs.org/sioc/ns#has_container';
const SIOC_HAS_MEMBER = 'http://rdfs.org/sioc/ns#has_member';
const SIOC_HAS_PARENT = 'http://rdfs.org/sioc/ns#has_parent';
const SIOC_THREAD = 'http://rdfs.org/sioc/ns#Thread';
const MEETING_MESSAGE = 'http://www.w3.org/ns/pim/meeting#Message';
const MEETING_LONG_CHAT = 'http://www.w3.org/ns/pim/meeting#LongChat';
const FOAF_AGENT = 'http://xmlns.com/foaf/0.1/Agent';
const VCARD_INDIVIDUAL = 'http://www.w3.org/2006/vcard/ns#Individual';
const SCHEMA_CREATIVE_WORK = 'http://schema.org/CreativeWork';
const SCHEMA_PROPERTY_VALUE = 'http://schema.org/PropertyValue';
const UDFS_TASK = 'https://undefineds.co/ns#Task';
const UDFS_RUN = 'https://undefineds.co/ns#Run';
const UDFS_RUN_STEP = 'https://undefineds.co/ns#RunStep';
const UDFS_SCHEDULE = 'https://undefineds.co/ns#Schedule';
const UDFS_SESSION = 'https://undefineds.co/ns#Session';
const UDFS_ISSUE = 'https://undefineds.co/ns#Issue';
const UDFS_LAST_MESSAGE = 'https://undefineds.co/ns#lastMessage';
const UDFS_STATUS = 'https://undefineds.co/ns#status';
const UDFS_MESSAGE_STATUS = 'https://undefineds.co/ns#messageStatus';
const UDFS_WORKSPACE = 'https://undefineds.co/ns#workspace';
const UDFS_RUN_RELATION = 'https://undefineds.co/ns#run';
const UDFS_TASK_RELATION = 'https://undefineds.co/ns#task';
const UDFS_IN_THREAD = 'https://undefineds.co/ns#inThread';
const UDFS_NEXT_RUN_AT = 'https://undefineds.co/ns#nextRunAt';
const UDFS_LEASE_OWNER = 'https://undefineds.co/ns#leaseOwner';
const UDFS_SESSION_STATUS = 'https://undefineds.co/ns#sessionStatus';
const UDFS_CONVERSATION = 'https://undefineds.co/ns#conversation';
const UDFS_TOKEN_USAGE = 'https://undefineds.co/ns#tokenUsage';
const XPOD_AI_PROVIDER = 'https://vocab.xpod.dev/ai#Provider';
const XPOD_AI_MODEL = 'https://vocab.xpod.dev/ai#Model';
const XPOD_AI_IS_PROVIDED_BY = 'https://vocab.xpod.dev/ai#isProvidedBy';
const XPOD_CREDENTIAL = 'https://vocab.xpod.dev/credential#Credential';
const XPOD_CREDENTIAL_PROVIDER = 'https://vocab.xpod.dev/credential#provider';
const PRODUCT_VIEW_MATERIALIZED_VERSION = 'v1';

const SETTINGS_RESOURCE_TYPE_VIEWS = new Map<string, string>([
  [XPOD_AI_PROVIDER, 'ai-providers'],
  [XPOD_AI_MODEL, 'ai-models'],
  [XPOD_CREDENTIAL, 'credentials'],
]);

const PRODUCT_RESOURCE_TYPE_VIEWS = new Map<string, string>([
  [MEETING_LONG_CHAT, 'chats'],
  [MEETING_MESSAGE, 'messages'],
  [SIOC_THREAD, 'threads'],
  [UDFS_TASK, 'tasks'],
  [UDFS_RUN, 'runs'],
  [UDFS_RUN_STEP, 'run-steps'],
  [UDFS_SCHEDULE, 'schedules'],
  [UDFS_SESSION, 'sessions'],
  [UDFS_ISSUE, 'issues'],
  [FOAF_AGENT, 'agents'],
  [VCARD_INDIVIDUAL, 'contacts'],
  [SCHEMA_CREATIVE_WORK, 'favorites'],
  [SCHEMA_PROPERTY_VALUE, 'settings'],
]);

const PRODUCT_RELATION_PREDICATE_VIEWS = new Map<string, string>([
  [DCT_CREATED, 'created-timeline'],
  [DCT_TITLE, 'title-hydration'],
  [SIOC_HAS_PARENT, 'threads-by-chat'],
  [UDFS_LAST_MESSAGE, 'chat-latest-message'],
  [UDFS_STATUS, 'status-index'],
  [UDFS_MESSAGE_STATUS, 'message-status-index'],
  [UDFS_WORKSPACE, 'runs-by-workspace'],
  [UDFS_RUN_RELATION, 'steps-by-run'],
  [UDFS_TASK_RELATION, 'runs-by-task'],
  [UDFS_IN_THREAD, 'runs-by-thread'],
  [UDFS_NEXT_RUN_AT, 'schedules-by-due-time'],
  [UDFS_LEASE_OWNER, 'runs-by-lease-owner'],
  [UDFS_SESSION_STATUS, 'sessions-by-status'],
]);

export class SolidRdfSparqlEngine implements SparqlEngine {
  private readonly adapter = new RdfSparqlAdapter();
  private readonly rdfEngine: RdfEngineLike;
  private readonly fallback?: SparqlEngine;
  private readonly shadowStore?: ShadowRdfQuintStore;
  private readonly enablePrimary: boolean;
  private readonly onFallback?: (reason: SolidRdfSparqlFallback) => void;
  private readonly autoMaterializeProductViews: boolean;
  private readonly operationCounts = new Map<SolidRdfSparqlOperation, MutableOperationCount>();
  private lastPrimary?: SolidRdfSparqlPrimaryMetric;
  private lastFallback?: SolidRdfSparqlFallbackMetric;

  public constructor(
    rdfEngine: RdfEngineLike,
    fallback?: SparqlEngine,
    shadowStore?: ShadowRdfQuintStore,
    enablePrimary = true,
    onFallback?: (reason: SolidRdfSparqlFallback) => void,
    autoMaterializeProductViews = true,
  ) {
    this.rdfEngine = rdfEngine;
    this.fallback = fallback;
    this.shadowStore = shadowStore;
    this.enablePrimary = enablePrimary;
    this.onFallback = onFallback;
    this.autoMaterializeProductViews = autoMaterializeProductViews;
  }

  public async queryBindings(query: string, basePath: string, accessScope?: RdfAccessScope): Promise<BindingsStream> {
    await this.ensureReady();
    if (!this.enablePrimary) {
      return this.fallbackWith('queryBindings', 'primary disabled', (fallback) => fallback.queryBindings(query, basePath, accessScope), accessScope);
    }

    const start = Date.now();
    try {
      const compiled = this.adapter.compile(query, basePath);
      if (compiled.queryType !== 'SELECT') {
        return this.fallbackWith('queryBindings', `compiled ${compiled.queryType} cannot produce bindings`, (fallback) => fallback.queryBindings(query, basePath, accessScope), accessScope);
      }
      const selectedQuery = this.applyMaterializedQuerySelector('queryBindings', compiled.query);
      const result = await this.rdfEngine.query(applyRdfAccessScope(selectedQuery, accessScope));
      this.recordPrimary('queryBindings', start, result);
      return this.bindingsStream(result, compiled.variables);
    } catch (error) {
      if (error instanceof DisabledSparqlFeatureError) {
        throw error;
      }
      return this.fallbackWith('queryBindings', fallbackReason(error), (fallback) => fallback.queryBindings(query, basePath, accessScope), accessScope);
    }
  }

  public async queryBoolean(query: string, basePath: string, accessScope?: RdfAccessScope): Promise<boolean> {
    await this.ensureReady();
    if (!this.enablePrimary) {
      return this.fallbackWith('queryBoolean', 'primary disabled', (fallback) => fallback.queryBoolean(query, basePath, accessScope), accessScope);
    }

    const start = Date.now();
    try {
      const compiled = this.adapter.compile(query, basePath);
      if (compiled.queryType !== 'ASK') {
        return this.fallbackWith('queryBoolean', `compiled ${compiled.queryType} cannot produce boolean`, (fallback) => fallback.queryBoolean(query, basePath, accessScope), accessScope);
      }
      const selectedQuery = this.applyMaterializedQuerySelector('queryBoolean', compiled.query);
      const result = await this.rdfEngine.query(applyRdfAccessScope(selectedQuery, accessScope));
      this.recordPrimary('queryBoolean', start, result);
      return result.bindings.length > 0;
    } catch (error) {
      if (error instanceof DisabledSparqlFeatureError) {
        throw error;
      }
      return this.fallbackWith('queryBoolean', fallbackReason(error), (fallback) => fallback.queryBoolean(query, basePath, accessScope), accessScope);
    }
  }

  public async queryQuads(query: string, basePath: string, accessScope?: RdfAccessScope): Promise<any> {
    await this.ensureReady();
    if (!this.enablePrimary) {
      return this.fallbackWith('queryQuads', 'primary disabled', (fallback) => fallback.queryQuads(query, basePath, accessScope), accessScope);
    }

    const start = Date.now();
    try {
      const quads = await this.executeQuadsPrimary(query, basePath, 'queryQuads', start, accessScope);
      return new ArrayIterator(quads);
    } catch (error) {
      if (error instanceof DisabledSparqlFeatureError) {
        throw error;
      }
      return this.fallbackWith('queryQuads', fallbackReason(error), (fallback) => fallback.queryQuads(query, basePath, accessScope), accessScope);
    }
  }

  public async queryVoid(query: string, basePath: string, accessScope?: RdfAccessScope): Promise<void> {
    await this.ensureReady();
    if (!this.enablePrimary) {
      return this.fallbackWith('queryVoid', 'primary disabled', (fallback) => fallback.queryVoid(query, basePath, accessScope), accessScope);
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
          const result = await this.rdfEngine.query(applyRdfAccessScope(operation.query, accessScope));
          const deletes = this.adapter.materializeDeleteWhere(operation.deletes, result.bindings);
          const inserts = this.adapter.materializeDeleteWhere(operation.inserts, result.bindings);
          computedDeletes += deletes.length;
          computedInserts += inserts.length;
          deletedRows += (await this.rdfEngine.applyDelta(deletes.map(quadToPattern), inserts)).deletedRows;
        } else if (operation.type === 'insertWhere') {
          const result = await this.rdfEngine.query(applyRdfAccessScope(operation.query, accessScope));
          const inserts = this.adapter.materializeDeleteWhere(operation.inserts, result.bindings);
          computedInserts += inserts.length;
          await this.rdfEngine.applyDelta([], inserts);
        } else {
          const result = await this.rdfEngine.query(applyRdfAccessScope(operation.query, accessScope));
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
      return this.fallbackWith('queryVoid', fallbackReason(error), (fallback) => fallback.queryVoid(query, basePath, accessScope), accessScope);
    }
  }

  public async constructGraph(graph: string, basePath: string, accessScope?: RdfAccessScope): Promise<AsyncIterator<Quad>> {
    await this.ensureReady();
    if (!this.enablePrimary) {
      return this.fallbackWith('constructGraph', 'primary disabled', (fallback) => fallback.constructGraph(graph, basePath, accessScope), accessScope);
    }
    if (!graph.startsWith(basePath) || (accessScope && !rdfAccessGraphAllowed(graph, accessScope))) {
      return new ArrayIterator([] as Quad[]);
    }

    const start = Date.now();
    try {
      const quads = await this.executeConstructPrimary(`
        CONSTRUCT { ?s ?p ?o }
        WHERE { GRAPH <${escapeIri(graph)}> { ?s ?p ?o } }
      `, basePath, 'constructGraph', start, accessScope);
      return new ArrayIterator(quads);
    } catch (error) {
      if (error instanceof DisabledSparqlFeatureError) {
        throw error;
      }
      return this.fallbackWith('constructGraph', fallbackReason(error), (fallback) => fallback.constructGraph(graph, basePath, accessScope), accessScope);
    }
  }

  public async listGraphs(basePath: string, accessScope?: RdfAccessScope): Promise<Set<string>> {
    await this.ensureReady();
    if (!this.enablePrimary) {
      return this.fallbackWith('listGraphs', 'primary disabled', (fallback) => fallback.listGraphs(basePath, accessScope), accessScope);
    }

    const start = Date.now();
    try {
      const result = await this.executeSelectPrimary(`
        SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }
      `, basePath, 'listGraphs', start, accessScope);
      const graphs = new Set<string>();
      for (const binding of result.bindings) {
        const graph = binding.g;
        if (graph?.termType === 'NamedNode') {
          graphs.add(graph.value);
        }
      }
      return filterRdfAccessGraphs(graphs, accessScope);
    } catch (error) {
      if (error instanceof DisabledSparqlFeatureError) {
        throw error;
      }
      return this.fallbackWith('listGraphs', fallbackReason(error), (fallback) => fallback.listGraphs(basePath, accessScope), accessScope);
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

  private bindingsStream(result: RdfQueryResult, variables: string[]): BindingsStream {
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

  private applyMaterializedQuerySelector(
    operation: 'queryBindings' | 'queryBoolean',
    query: RdfQuery,
  ): RdfQuery {
    if (query.cache?.materialized || !this.autoMaterializeProductViews) {
      return query;
    }
    const materialized = defaultMaterializedQuerySelector(
      operation,
      query,
    );
    if (!materialized) {
      return query;
    }
    return {
      ...query,
      cache: {
        ...query.cache,
        materialized,
      },
    };
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
    accessScope?: RdfAccessScope,
  ): Promise<T> {
    if (isRestrictiveRdfAccessScope(accessScope)) {
      throw new UnsupportedSparqlQueryError(`No ACL/ACR-safe SPARQL fallback configured for ${operation}: ${reason}`);
    }
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
    accessScope?: RdfAccessScope,
  ): Promise<RdfQueryResult> {
    const compiled = this.adapter.compile(query, basePath);
    if (compiled.queryType !== 'SELECT') {
      throw new UnsupportedSparqlQueryError(`compiled ${compiled.queryType} cannot produce bindings`);
    }
    const result = await this.rdfEngine.query(applyRdfAccessScope(compiled.query, accessScope));
    this.recordPrimary(operation, start, result);
    return result;
  }

  private async executeConstructPrimary(
    query: string,
    basePath: string,
    operation: SolidRdfSparqlOperation,
    start: number,
    accessScope?: RdfAccessScope,
  ): Promise<Quad[]> {
    const compiled = this.adapter.compile(query, basePath);
    if (compiled.queryType !== 'CONSTRUCT' || !compiled.constructTemplate) {
      throw new UnsupportedSparqlQueryError(`compiled ${compiled.queryType} cannot produce quads`);
    }
    const result = await this.rdfEngine.query(applyRdfAccessScope(compiled.query, accessScope));
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
    accessScope?: RdfAccessScope,
  ): Promise<Quad[]> {
    const compiled = this.adapter.compile(query, basePath);
    if (compiled.queryType === 'CONSTRUCT' && compiled.constructTemplate) {
      const result = await this.rdfEngine.query(applyRdfAccessScope(compiled.query, accessScope));
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
      return this.executeDescribePrimary(compiled.query, compiled.describeTargets, basePath, operation, start, accessScope);
    }
    throw new UnsupportedSparqlQueryError(`compiled ${compiled.queryType} cannot produce quads`);
  }

  private async executeDescribePrimary(
    query: import('./types').RdfQuery,
    targets: RdfQueryTermPattern[],
    basePath: string,
    operation: SolidRdfSparqlOperation,
    start: number,
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
        const describe = await this.rdfEngine.query(applyRdfAccessScope({
          patterns: [
            {
              subject,
              predicate: { variable: 'p' },
              object: { variable: 'o' },
              graph: { $startsWith: basePath },
            },
          ],
          select: ['p', 'o'],
        }, accessScope));
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
    result: RdfQueryResult,
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

function defaultMaterializedQuerySelector(
  operation: 'queryBindings' | 'queryBoolean',
  query: RdfQuery,
): RdfQueryMaterializedResultOptions | undefined {
  if (operation !== 'queryBindings') {
    return undefined;
  }
  if (hasSearchSources(query)) {
    return undefined;
  }
  return threadHistoryMaterializedResult(query)
    ?? settingsProductViewMaterializedResult(query)
    ?? agentContextMaterializedResult(query)
    ?? stableProductViewMaterializedResult(query);
}

function threadHistoryMaterializedResult(query: RdfQuery): RdfQueryMaterializedResultOptions | undefined {
  const threadIri = threadHistoryQueryThreadIri(query);
  if (!threadIri) {
    return undefined;
  }
  return {
    key: `chatkit/thread-history/${shortHash(threadIri)}/${shortHash(stableQueryFingerprint(query))}`,
    version: PRODUCT_VIEW_MATERIALIZED_VERSION,
  };
}

function threadHistoryQueryThreadIri(query: RdfQuery): string | undefined {
  for (const pattern of query.patterns) {
    const predicate = namedNodeValue(pattern.predicate);
    if (predicate !== SIOC_HAS_CONTAINER && predicate !== SIOC_HAS_MEMBER) {
      continue;
    }
    const object = namedNodeValue(pattern.object);
    if (object) {
      return object;
    }
  }
  return undefined;
}

function settingsProductViewMaterializedResult(query: RdfQuery): RdfQueryMaterializedResultOptions | undefined {
  const view = settingsProductView(query);
  if (!view) {
    return undefined;
  }
  return {
    key: `models/settings/${view}/${shortHash(stableQueryFingerprint(query))}`,
    version: PRODUCT_VIEW_MATERIALIZED_VERSION,
  };
}

function settingsProductView(query: RdfQuery): string | undefined {
  const typeViews = new Set<string>();
  let hasModelProviderLink = false;
  let hasCredentialProviderLink = false;

  for (const pattern of query.patterns) {
    const predicate = namedNodeValue(pattern.predicate);
    if (predicate === RDF_TYPE) {
      const typeView = SETTINGS_RESOURCE_TYPE_VIEWS.get(namedNodeValue(pattern.object) ?? '');
      if (typeView) {
        typeViews.add(typeView);
      }
      continue;
    }
    if (predicate === XPOD_AI_IS_PROVIDED_BY) {
      hasModelProviderLink = true;
      continue;
    }
    if (predicate === XPOD_CREDENTIAL_PROVIDER) {
      hasCredentialProviderLink = true;
    }
  }

  if (hasModelProviderLink && hasCredentialProviderLink) {
    return 'provider-model-credentials';
  }

  if (typeViews.size === 0) {
    return undefined;
  }

  return [...typeViews].sort().join('+');
}

function agentContextMaterializedResult(query: RdfQuery): RdfQueryMaterializedResultOptions | undefined {
  const view = agentContextProductView(query);
  if (!view) {
    return undefined;
  }
  return {
    key: `models/agent-context/${view}/${shortHash(stableQueryFingerprint(query))}`,
    version: PRODUCT_VIEW_MATERIALIZED_VERSION,
  };
}

function agentContextProductView(query: RdfQuery): string | undefined {
  if (!query.patterns.some(isProductGraphScoped)) {
    return undefined;
  }

  const types = new Set<string>();
  const predicates = new Set<string>();

  for (const pattern of query.patterns) {
    const predicate = namedNodeValue(pattern.predicate);
    if (!predicate) {
      continue;
    }
    predicates.add(predicate);
    if (predicate === RDF_TYPE) {
      const type = namedNodeValue(pattern.object);
      if (type) {
        types.add(type);
      }
    }
  }

  if (
    types.has(UDFS_SESSION)
    && types.has(MEETING_LONG_CHAT)
    && types.has(SIOC_THREAD)
    && predicates.has(UDFS_SESSION_STATUS)
    && predicates.has(UDFS_CONVERSATION)
    && predicates.has(UDFS_IN_THREAD)
  ) {
    return predicates.has(UDFS_TOKEN_USAGE)
      ? 'active-session-thread-usage'
      : 'active-session-thread-hydration';
  }

  return undefined;
}

function stableProductViewMaterializedResult(query: RdfQuery): RdfQueryMaterializedResultOptions | undefined {
  const view = stableProductView(query);
  if (!view) {
    return undefined;
  }
  return {
    key: `models/product-views/${view}/${shortHash(stableQueryFingerprint(query))}`,
    version: PRODUCT_VIEW_MATERIALIZED_VERSION,
  };
}

function stableProductView(query: RdfQuery): string | undefined {
  const views = new Set<string>();

  for (const pattern of query.patterns) {
    const predicate = namedNodeValue(pattern.predicate);
    if (predicate === RDF_TYPE) {
      const typeView = PRODUCT_RESOURCE_TYPE_VIEWS.get(namedNodeValue(pattern.object) ?? '');
      if (typeView) {
        views.add(typeView);
      }
      continue;
    }

    const predicateView = isProductGraphScoped(pattern)
      ? PRODUCT_RELATION_PREDICATE_VIEWS.get(predicate ?? '')
      : undefined;
    if (predicateView) {
      views.add(predicateView);
    }
  }

  if (views.size === 0) {
    return undefined;
  }

  return [...views].sort().join('+');
}

function hasSearchSources(query: RdfQuery): boolean {
  return (query.textSearch?.length ?? 0) > 0
    || (query.vectorSearch?.length ?? 0) > 0;
}

function isProductGraphScoped(pattern: RdfQueryPattern): boolean {
  const graph = namedNodeValue(pattern.graph) ?? graphPrefixValue(pattern.graph);
  return Boolean(graph && (
    graph.includes('/.data/chat/')
      || graph.includes('/.data/task/')
      || graph.includes('/.data/sessions/')
      || graph.includes('/.data/agents/')
      || graph.includes('/.data/approvals/')
      || graph.includes('/.data/audits/')
      || graph.includes('/.data/issues/')
      || graph.includes('/settings/')
  ));
}

function graphPrefixValue(term: RdfQueryTermPattern | undefined): string | undefined {
  if (!term || typeof term !== 'object' || 'variable' in term || 'termType' in term) {
    return undefined;
  }
  return '$startsWith' in term && typeof term.$startsWith === 'string'
    ? term.$startsWith
    : undefined;
}

function namedNodeValue(term: RdfQueryTermPattern | undefined): string | undefined {
  if (!term || typeof term !== 'object' || 'variable' in term || !('termType' in term)) {
    return undefined;
  }
  return term.termType === 'NamedNode' ? term.value : undefined;
}

function stableQueryFingerprint(query: RdfQuery): string {
  const { cache: _cache, ...rest } = query;
  return stableStringify(rest);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => typeof entry !== 'function' && entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
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
