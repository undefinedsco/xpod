/**
 * ComunicaQuintEngine - Comunica SPARQL engine backed by QuintStore
 * 
 * Features:
 * 1. Query pushdown optimization (LIMIT/ORDER BY)
 * 2. FILTER pushdown via IQuerySource interface
 * 3. External filters for security boundaries (ACL)
 * 
 * Architecture:
 * - Uses QuintQuerySource (IQuerySource) for proper FILTER pushdown
 * - Comunica pushes FILTER operations down to sources that declare support
 * - QuintQuerySource extracts filters from algebra and applies them to QuintStore
 */

import { EventEmitter } from 'events';
import type { Quad, Term, Bindings, ResultStream } from '@rdfjs/types';
import type * as RDF from '@rdfjs/types';
import { QueryEngine } from '@comunica/query-sparql-rdfjs';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { translate, type Algebra } from 'sparqlalgebrajs';
import { wrap } from 'asynciterator';
import { DataFactory } from 'rdf-data-factory';

import type { QuintStore, QuintPattern, QueryOptions, TermName, TermOperators } from '../quint/types';
import { QuintQuerySource } from './QuintQuerySource';

export interface ComunicaQuintEngineOptions {
  debug?: boolean;
}

/**
 * Security/ACL filters passed from upstream
 * These are applied unconditionally to restrict query scope
 */
export interface SecurityFilters {
  subject?: TermOperators;
  predicate?: TermOperators;
  object?: TermOperators;
  graph?: TermOperators;
}

export interface QueryContext {
  sources?: unknown[];
  baseIRI?: string;
  /** Security filters for access control */
  filters?: SecurityFilters;
  [key: string]: unknown;
}

/**
 * Query analysis result (stateless)
 */
export interface QueryAnalysis {
  hasFilter: boolean;
  filterTypes: string[];
  pushdownable: string[];
  nonPushdownable: string[];
  estimatedPushdownRate: number;
}

interface OptimizeParams {
  limit?: number;
  offset?: number;
  order?: TermName[];
  reverse?: boolean;
}

// Context key names - must match Comunica's internal keys
const CONTEXT_KEY_QUERY_SOURCES = '@comunica/bus-query-operation:querySources';

const dataFactory = new DataFactory();

/**
 * Custom RDF/JS Store backed by QuintStore
 * Used for UPDATE operations (INSERT/DELETE) which don't need FILTER pushdown
 */
class QuintRdfStore implements RDF.Store {
  constructor(
    private readonly store: QuintStore,
    private readonly getSecurityFilters: () => SecurityFilters | undefined,
    private readonly debug: boolean
  ) {}

  match(
    subject?: Term | null,
    predicate?: Term | null,
    object?: Term | null,
    graph?: Term | null
  ): RDF.Stream {
    // Build QuintPattern
    const pattern: QuintPattern = {};
    
    if (subject && subject.termType !== 'Variable') {
      pattern.subject = subject;
    }
    if (predicate && predicate.termType !== 'Variable') {
      pattern.predicate = predicate;
    }
    if (object && object.termType !== 'Variable') {
      pattern.object = object;
    }
    if (graph && graph.termType !== 'Variable' && graph.termType !== 'DefaultGraph') {
      pattern.graph = graph;
    }

    // Apply security filters (from upstream, e.g., ACL)
    const securityFilters = this.getSecurityFilters();
    if (securityFilters) {
      if (securityFilters.subject && !pattern.subject) {
        pattern.subject = securityFilters.subject;
      }
      if (securityFilters.predicate && !pattern.predicate) {
        pattern.predicate = securityFilters.predicate;
      }
      if (securityFilters.object && !pattern.object) {
        pattern.object = securityFilters.object;
      }
      if (securityFilters.graph && !pattern.graph) {
        pattern.graph = securityFilters.graph;
      }
    }

    if (this.debug) {
      console.log(`[QuintRdfStore] match() called`);
      console.log(`  pattern:`, pattern);
    }

    // Use wrap to convert Promise<Array> to AsyncIterator
    const promiseIterator = wrap(this.store.get(pattern));
    return promiseIterator as any;
  }

  /**
   * Import quads from a stream (Sink interface)
   */
  import(stream: RDF.Stream<Quad>): EventEmitter {
    const emitter = new EventEmitter();
    
    const quads: Quad[] = [];
    
    stream.on('data', (quad: Quad) => {
      quads.push(quad);
    });
    
    stream.on('end', () => {
      if (quads.length > 0) {
        this.store.multiPut(quads as any[])
          .then(() => emitter.emit('end'))
          .catch((err) => emitter.emit('error', err));
      } else {
        emitter.emit('end');
      }
    });
    
    stream.on('error', (err) => {
      emitter.emit('error', err);
    });
    
    return emitter;
  }

  /**
   * Remove quads from a stream (Store interface)
   */
  remove(stream: RDF.Stream<Quad>): EventEmitter {
    const emitter = new EventEmitter();
    
    const deletePromises: Promise<number>[] = [];
    
    stream.on('data', (quad: Quad) => {
      const pattern: QuintPattern = {
        subject: quad.subject,
        predicate: quad.predicate,
        object: quad.object,
      };
      if (quad.graph && quad.graph.termType !== 'DefaultGraph') {
        pattern.graph = quad.graph;
      }
      deletePromises.push(this.store.del(pattern));
    });
    
    stream.on('end', () => {
      Promise.all(deletePromises)
        .then(() => emitter.emit('end'))
        .catch((err) => emitter.emit('error', err));
    });
    
    stream.on('error', (err) => {
      emitter.emit('error', err);
    });
    
    return emitter;
  }

  /**
   * Remove all matching quads (Store interface)
   */
  removeMatches(
    subject?: Term | null,
    predicate?: Term | null,
    object?: Term | null,
    graph?: Term | null
  ): EventEmitter {
    const emitter = new EventEmitter();
    
    if (this.debug) {
      console.log(`[QuintRdfStore] removeMatches()`, { subject, predicate, object, graph });
    }
    
    const pattern: QuintPattern = {};
    if (subject && subject.termType !== 'Variable') {
      pattern.subject = subject;
    }
    if (predicate && predicate.termType !== 'Variable') {
      pattern.predicate = predicate;
    }
    if (object && object.termType !== 'Variable') {
      pattern.object = object;
    }
    if (graph && graph.termType !== 'Variable' && graph.termType !== 'DefaultGraph') {
      pattern.graph = graph;
    }
    
    this.store.del(pattern)
      .then(() => emitter.emit('end'))
      .catch((err) => emitter.emit('error', err));
    
    return emitter;
  }

  /**
   * Delete a named graph (Store interface)
   */
  deleteGraph(graph: Term | string): EventEmitter {
    const emitter = new EventEmitter();
    
    const graphTerm = typeof graph === 'string' 
      ? { termType: 'NamedNode' as const, value: graph }
      : graph;
    
    const pattern: QuintPattern = { graph: graphTerm as Term };
    
    this.store.del(pattern)
      .then(() => emitter.emit('end'))
      .catch((err) => emitter.emit('error', err));
    
    return emitter;
  }
}

export class ComunicaQuintEngine {
  private readonly store: QuintStore;
  private readonly rdfStore: QuintRdfStore;
  private readonly querySource: QuintQuerySource;
  private readonly engine: QueryEngine;
  private readonly debug: boolean;
  private bindingsFactory: any;
  
  // Current query optimization params
  private currentOptimizeParams: OptimizeParams | null = null;
  // Current security filters (from upstream)
  private currentSecurityFilters: SecurityFilters | undefined;

  constructor(store: QuintStore, options?: ComunicaQuintEngineOptions) {
    this.store = store;
    this.debug = options?.debug ?? false;
    
    // Create RdfStore for UPDATE operations
    this.rdfStore = new QuintRdfStore(
      store,
      () => this.currentSecurityFilters,
      this.debug
    );
    
    // Create BindingsFactory
    this.bindingsFactory = new (BindingsFactory as any)(dataFactory);
    
    // Create QuintQuerySource with IQuerySource interface for proper FILTER pushdown
    this.querySource = new QuintQuerySource(store, {
      debug: this.debug,
      bindingsFactory: this.bindingsFactory,
      getSecurityFilters: () => this.currentSecurityFilters,
      getOptimizeParams: () => this.currentOptimizeParams,
    });
    
    this.engine = new QueryEngine();
  }

  /**
   * Analyze a query's pushdown potential (stateless)
   * Returns analysis of what can/cannot be pushed down without executing the query
   */
  analyzeQuery(query: string): QueryAnalysis {
    const algebra = translate(query);
    return this.analyzeAlgebra(algebra);
  }

  /**
   * Analyze algebra tree for pushdown potential
   */
  private analyzeAlgebra(op: Algebra.Operation): QueryAnalysis {
    const result: QueryAnalysis = {
      hasFilter: false,
      filterTypes: [],
      pushdownable: [],
      nonPushdownable: [],
      estimatedPushdownRate: 1.0,
    };

    this.walkAlgebra(op, result);

    // Calculate pushdown rate
    const total = result.pushdownable.length + result.nonPushdownable.length;
    if (total > 0) {
      result.estimatedPushdownRate = result.pushdownable.length / total;
    }

    return result;
  }

  /**
   * Walk algebra tree and collect filter info
   */
  private walkAlgebra(op: Algebra.Operation, result: QueryAnalysis): void {
    if (op.type === 'filter') {
      result.hasFilter = true;
      const filterOp = op as Algebra.Filter;
      this.analyzeExpression(filterOp.expression, result);
      this.walkAlgebra(filterOp.input, result);
    } else if ('input' in op && op.input) {
      this.walkAlgebra(op.input as Algebra.Operation, result);
    }
    if ('left' in op && op.left) {
      this.walkAlgebra(op.left as Algebra.Operation, result);
    }
    if ('right' in op && op.right) {
      this.walkAlgebra(op.right as Algebra.Operation, result);
    }
  }

  /**
   * Analyze a filter expression
   */
  private analyzeExpression(expr: Algebra.Expression, result: QueryAnalysis): void {
    if (expr.expressionType === 'operator') {
      const opExpr = expr as Algebra.OperatorExpression;
      const op = opExpr.operator.toLowerCase();

      // Classify the operator
      if (['=', '!='].includes(op)) {
        result.filterTypes.push('equality');
        result.pushdownable.push(op);
      } else if (['<', '>', '<=', '>='].includes(op)) {
        result.filterTypes.push('range');
        result.pushdownable.push(op);
      } else if (['in', 'notin'].includes(op)) {
        result.filterTypes.push('equality');
        result.pushdownable.push(op);
      } else if (['strstarts', 'strends', 'contains', 'regex'].includes(op)) {
        result.filterTypes.push('string');
        result.pushdownable.push(op);
      } else if (op === 'bound') {
        result.filterTypes.push('bound');
        result.pushdownable.push(op);
      } else if (['isiri', 'isuri', 'isblank', 'isliteral', 'isnumeric'].includes(op)) {
        // Type checking functions - can be pushed down
        result.filterTypes.push('typecheck');
        result.pushdownable.push(op);
      } else if (op === 'langmatches') {
        // LANGMATCHES can be pushed down using $endsWith on serialized format
        result.filterTypes.push('language');
        result.pushdownable.push(op);
      } else if (['&&', '||', '!'].includes(op)) {
        result.filterTypes.push('logical');
        // Recurse into logical operators
        for (const arg of opExpr.args) {
          this.analyzeExpression(arg, result);
        }
      } else {
        // Non-pushdownable functions
        result.filterTypes.push('function');
        result.nonPushdownable.push(op);
      }
    } else if (expr.expressionType === 'existence') {
      result.filterTypes.push('exists');
      result.pushdownable.push('exists');
    }
  }

  /**
   * Execute SELECT query
   * Uses IQuerySource for proper FILTER pushdown
   */
  async queryBindings(query: string, context?: QueryContext): Promise<ResultStream<Bindings>> {
    const params = this.extractOptimizeParams(query);
    this.currentOptimizeParams = params;
    this.currentSecurityFilters = context?.filters;
    
    if (this.debug) {
      console.log(`[ComunicaQuintEngine] Query optimization:`, this.currentOptimizeParams);
      console.log(`[ComunicaQuintEngine] Security filters:`, this.currentSecurityFilters);
    }

    try {
      // Create context with pre-identified source to bypass source identification
      // This allows us to use our IQuerySource directly
      // IMPORTANT: Use plain object instead of ActionContext to avoid version mismatch
      // between the root @comunica/core and the one bundled with @comunica/query-sparql-rdfjs
      // The engine will convert it to ActionContext using its internal @comunica/core
      const { sources: _ignored, filters: _filters, ...restContext } = context || {};
      const queryContext = {
        ...restContext,
        // Set the identified sources directly - this skips ActorContextPreprocessQuerySourceIdentify
        [CONTEXT_KEY_QUERY_SOURCES]: [{ source: this.querySource }],
      };

      return await this.engine.queryBindings(query, queryContext as any);
    } finally {
      this.currentOptimizeParams = null;
      this.currentSecurityFilters = undefined;
    }
  }

  /**
   * Execute ASK query
   */
  async queryBoolean(query: string, context?: QueryContext): Promise<boolean> {
    const params = this.extractOptimizeParams(query);
    this.currentOptimizeParams = params;
    this.currentSecurityFilters = context?.filters;
    
    // Optimize ASK with limit=1
    if (!this.currentOptimizeParams) {
      this.currentOptimizeParams = { limit: 1 };
    } else if (this.currentOptimizeParams.limit === undefined) {
      this.currentOptimizeParams.limit = 1;
    }
    
    try {
      const { sources: _ignored, filters: _filters, ...restContext } = context || {};
      const queryContext = {
        ...restContext,
        [CONTEXT_KEY_QUERY_SOURCES]: [{ source: this.querySource }],
      };

      return await this.engine.queryBoolean(query, queryContext as any);
    } finally {
      this.currentOptimizeParams = null;
      this.currentSecurityFilters = undefined;
    }
  }

  /**
   * Execute CONSTRUCT/DESCRIBE query
   */
  async queryQuads(query: string, context?: QueryContext): Promise<ResultStream<Quad>> {
    const params = this.extractOptimizeParams(query);
    this.currentOptimizeParams = params;
    this.currentSecurityFilters = context?.filters;
    
    try {
      const { sources: _ignored, filters: _filters, ...restContext } = context || {};
      const queryContext = {
        ...restContext,
        [CONTEXT_KEY_QUERY_SOURCES]: [{ source: this.querySource }],
      };

      return await this.engine.queryQuads(query, queryContext as any);
    } finally {
      this.currentOptimizeParams = null;
      this.currentSecurityFilters = undefined;
    }
  }

  /**
   * Execute UPDATE query (INSERT/DELETE)
   * Uses RDF.Store interface since UPDATE doesn't need FILTER pushdown
   */
  async queryVoid(query: string, context?: QueryContext): Promise<void> {
    this.currentSecurityFilters = context?.filters;
    
    try {
      return await this.engine.queryVoid(query, {
        sources: [this.rdfStore],
        ...context,
      } as any);
    } finally {
      this.currentSecurityFilters = undefined;
    }
  }

  /**
   * Extract optimization params from SPARQL query
   */
  private extractOptimizeParams(query: string): OptimizeParams | null {
    try {
      const algebra = translate(query, { quads: true });
      return this.extractOptimizeParamsFromAlgebra(algebra);
    } catch (error) {
      if (this.debug) {
        console.log(`[ComunicaQuintEngine] Failed to analyze query:`, error);
      }
      return null;
    }
  }

  /**
   * Extract optimization params from SPARQL algebra
   */
  private extractOptimizeParamsFromAlgebra(algebra: Algebra.Operation): OptimizeParams | null {
    let limit: number | undefined;
    let offset: number | undefined;
    let order: TermName[] | undefined;
    let reverse: boolean | undefined;
    let currentOp = algebra;
    let canPushLimit = true;

    while (currentOp) {
      switch (currentOp.type) {
        case 'slice': {
          const slice = currentOp as Algebra.Slice;
          if (slice.length !== undefined) {
            limit = slice.length;
          }
          if (slice.start !== undefined) {
            offset = slice.start;
          }
          currentOp = slice.input;
          break;
        }
        
        case 'orderby': {
          const orderBy = currentOp as Algebra.OrderBy;
          if (orderBy.expressions.length === 1) {
            const expr = orderBy.expressions[0];
            if (expr.expression.expressionType === 'term' && 
                expr.expression.term.termType === 'Variable') {
              const varName = expr.expression.term.value;
              const termName = this.variableToTermName(varName);
              if (termName) {
                order = [termName];
                reverse = !expr.ascending;
              }
            }
          }
          currentOp = orderBy.input;
          break;
        }

        case 'project':
        case 'distinct':
        case 'reduced': {
          currentOp = (currentOp as any).input;
          break;
        }

        case 'bgp': {
          const bgp = currentOp as Algebra.Bgp;
          if (bgp.patterns.length === 1) {
            return { limit, offset, order, reverse };
          }
          canPushLimit = false;
          return canPushLimit ? { limit, offset, order, reverse } : null;
        }

        case 'join':
        case 'leftjoin':
        case 'union':
        case 'minus':
          canPushLimit = false;
          return null;

        case 'filter':
        case 'extend':
        case 'group':
          return null;

        default:
          return null;
      }
    }

    return null;
  }

  /**
   * Map SPARQL variable name to TermName
   */
  private variableToTermName(varName: string): TermName | null {
    const mapping: Record<string, TermName> = {
      's': 'subject',
      'subject': 'subject',
      'p': 'predicate',
      'predicate': 'predicate',
      'o': 'object',
      'object': 'object',
      'g': 'graph',
      'graph': 'graph',
    };
    return mapping[varName.toLowerCase()] ?? null;
  }
}
