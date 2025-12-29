/**
 * QuintQuerySource - IQuerySource implementation for QuintStore
 * 
 * This implements Comunica's IQuerySource interface to enable proper FILTER pushdown.
 * Unlike RDF.Store.match() which only receives 4 terms, IQuerySource.queryBindings()
 * receives the full SPARQL algebra including FILTER expressions.
 * 
 * Design:
 * - Delegates filter extraction to FilterPushdownExtractor
 * - Delegates pattern building to PatternBuilder
 * - Delegates in-memory evaluation to ExpressionEvaluator
 * - Coordinates these components to execute queries efficiently
 */

import type { Quad, Term, Variable, Bindings } from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import { ArrayIterator, BufferedIterator, wrap } from 'asynciterator';
import { Algebra, Util as AlgebraUtil } from 'sparqlalgebrajs';
import { DataFactory } from 'rdf-data-factory';

import type { QuintStore, QuintPattern, QueryOptions, TermName, TermOperators } from '../quint/types';
import type { SecurityFilters } from './ComunicaQuintEngine';
import { FilterPushdownExtractor, type PushdownFilters, type PushdownResult } from './FilterPushdownExtractor';
import { PatternBuilder } from './PatternBuilder';
import { ExpressionEvaluator } from './ExpressionEvaluator';
import { extractVariables } from './AlgebraUtils';

// Re-export types from Comunica - we define them here to avoid complex import paths
export interface IActionContext {
  get<V>(key: { name: string }): V | undefined;
  getSafe<V>(key: { name: string }): V;
  has(key: { name: string }): boolean;
}

export interface FragmentSelectorShape {
  type: 'operation' | 'conjunction' | 'disjunction' | 'negation' | 'arity';
  operation?: {
    operationType: 'type' | 'pattern' | 'wildcard';
    type?: string;
    pattern?: Algebra.Operation;
  };
  children?: FragmentSelectorShape[];
  child?: FragmentSelectorShape;
  variablesOptional?: Variable[];
  joinBindings?: true;
  filterBindings?: true;
  min?: number;
  max?: number;
}

export interface BindingsStream extends AsyncIterator<Bindings> {
  // AsyncIterator with metadata property
}

export interface IQueryBindingsOptions {
  joinBindings?: {
    bindings: BindingsStream;
    metadata: unknown;
  };
  filterBindings?: {
    bindings: BindingsStream;
    metadata: unknown;
  };
}

export interface MetadataValidationState {
  // Metadata validation state
}

/**
 * IQuerySource interface compatible with Comunica
 */
export interface IQuerySource {
  referenceValue: unknown;
  getSelectorShape(context: IActionContext): Promise<FragmentSelectorShape>;
  queryBindings(operation: Algebra.Operation, context: IActionContext, options?: IQueryBindingsOptions): BindingsStream;
  queryQuads(operation: Algebra.Operation, context: IActionContext): AsyncIterator<Quad>;
  queryBoolean(operation: Algebra.Ask, context: IActionContext): Promise<boolean>;
  queryVoid(operation: Algebra.Update, context: IActionContext): Promise<void>;
  toString(): string;
}

interface OptimizeParams {
  limit?: number;
  offset?: number;
  order?: TermName[];
  reverse?: boolean;
}

const dataFactory = new DataFactory();

/**
 * QuintQuerySource implements IQuerySource for QuintStore
 * 
 * Key features:
 * 1. Declares support for FILTER operations via getSelectorShape()
 * 2. Receives full SPARQL algebra in queryBindings() including FILTERs
 * 3. Extracts filter conditions and pushes them down to QuintStore
 * 4. Applies security filters (ACL) unconditionally
 * 5. Tree-based evaluation for remaining non-pushdownable expressions
 */
export class QuintQuerySource implements IQuerySource {
  public readonly referenceValue: unknown;
  
  private readonly store: QuintStore;
  private readonly debug: boolean;
  private readonly bindingsFactory: any; // BindingsFactory from Comunica
  
  // Closures to get current query context
  private readonly getSecurityFilters: () => SecurityFilters | undefined;
  private readonly getOptimizeParams: () => OptimizeParams | null;
  
  // Delegate components
  private readonly filterExtractor: FilterPushdownExtractor;
  private readonly patternBuilder: PatternBuilder;
  private readonly expressionEvaluator: ExpressionEvaluator;
  
  constructor(
    store: QuintStore,
    options: {
      debug?: boolean;
      bindingsFactory: any;
      getSecurityFilters: () => SecurityFilters | undefined;
      getOptimizeParams: () => OptimizeParams | null;
    }
  ) {
    this.store = store;
    this.referenceValue = store; // Reference for source identification
    this.debug = options.debug ?? false;
    this.bindingsFactory = options.bindingsFactory;
    this.getSecurityFilters = options.getSecurityFilters;
    this.getOptimizeParams = options.getOptimizeParams;
    
    // Initialize delegate components
    this.filterExtractor = new FilterPushdownExtractor();
    this.patternBuilder = new PatternBuilder(this.getSecurityFilters);
    this.expressionEvaluator = new ExpressionEvaluator(
      store,
      this.patternBuilder,
      this.extractPatternAndFilter.bind(this)
    );
  }

  /**
   * Declare the operations this source supports
   * We support both patterns and filter operations
   */
  async getSelectorShape(_context: IActionContext): Promise<FragmentSelectorShape> {
    return {
      type: 'disjunction',
      children: [
        // Support basic patterns
        {
          type: 'operation',
          operation: {
            operationType: 'pattern',
            pattern: {
              type: 'pattern',
              subject: dataFactory.variable('s'),
              predicate: dataFactory.variable('p'),
              object: dataFactory.variable('o'),
              graph: dataFactory.variable('g'),
            } as Algebra.Pattern,
          },
          variablesOptional: [
            dataFactory.variable('s'),
            dataFactory.variable('p'),
            dataFactory.variable('o'),
            dataFactory.variable('g'),
          ],
        },
        // Support FILTER operations
        {
          type: 'operation',
          operation: {
            operationType: 'type',
            type: Algebra.types.FILTER,
          },
        },
      ],
    };
  }

  /**
   * Query bindings - main entry point for SPARQL queries
   */
  queryBindings(operation: Algebra.Operation, _context: IActionContext, _options?: IQueryBindingsOptions): BindingsStream {
    if (this.debug) {
      console.log(`[QuintQuerySource] queryBindings() called with operation type: ${operation.type}`);
    }

    // Wrap async execution in an iterator using wrap()
    const variables = this.getVariablesFromOperation(operation);
    const resultIterator = wrap(this.executeQuery(operation).then(results => results));

    // Add metadata for Comunica
    // Variables must be in format { variable: Variable, canBeUndef: boolean }
    const variablesMetadata = variables.map(v => ({ variable: v, canBeUndef: false }));
    resultIterator.setProperty('metadata', {
      state: { invalidate: () => {}, invalid: false, addInvalidateListener: () => {} },
      cardinality: { type: 'estimate' as const, value: Number.POSITIVE_INFINITY },
      variables: variablesMetadata,
    });

    return resultIterator as BindingsStream;
  }

  /**
   * Execute query and return bindings
   */
  private async executeQuery(operation: Algebra.Operation): Promise<Bindings[]> {
    const { pattern, filter } = this.extractPatternAndFilter(operation);
    const variables = extractVariables(pattern);

    // Extract pushdownable filters
    let pushdownFilters: PushdownFilters = {};
    let remainder: Algebra.Expression | null = filter;
    let orBranches: PushdownFilters[] | undefined;
    let orNonPushdownBranches: Algebra.Expression[] | undefined;

    if (filter) {
      const result = this.filterExtractor.extractPushdownFilters(filter, pattern);
      pushdownFilters = result.filters;
      remainder = result.remainder;
      orBranches = result.orBranches;
      orNonPushdownBranches = result.orNonPushdownBranches;
    }

    if (this.debug) {
      console.log(`[QuintQuerySource] Pushdown filters:`, JSON.stringify(pushdownFilters, null, 2));
      console.log(`[QuintQuerySource] OR branches:`, orBranches?.length || 0);
      console.log(`[QuintQuerySource] OR non-pushdown branches:`, orNonPushdownBranches?.length || 0);
      console.log(`[QuintQuerySource] Has remainder:`, remainder !== null);
    }

    // Get query options
    // NOTE: Comunica handles OFFSET, we only pass limit to QuintStore
    // If there's an offset, we need to fetch limit + offset records
    // and let Comunica skip the first `offset` records
    const optimizeParams = this.getOptimizeParams();
    const queryOptions: QueryOptions = {};
    if (optimizeParams?.limit) {
      // Fetch enough records for Comunica to apply offset
      queryOptions.limit = optimizeParams.limit + (optimizeParams.offset || 0);
    }
    // Don't pass offset to QuintStore - Comunica handles it
    if (optimizeParams?.order) queryOptions.order = optimizeParams.order;
    if (optimizeParams?.reverse) queryOptions.reverse = optimizeParams.reverse;

    let results: Bindings[];

    // Handle OR branches (union semantics)
    if (orBranches && orBranches.length > 0) {
      results = await this.executeOrBranches(pattern, variables, orBranches, orNonPushdownBranches, queryOptions);
      if (this.debug) {
        console.log(`[QuintQuerySource] OR pushdown branches returned ${results.length} unique results`);
      }
    } else if (Object.keys(pushdownFilters).length > 0) {
      // Build pattern with pushdown filters
      const quintPattern = this.patternBuilder.buildQuintPattern(pattern, pushdownFilters);
      const quads = await this.store.get(quintPattern, queryOptions);
      results = this.quadsToBindings(quads, variables, pattern);
      if (this.debug) {
        console.log(`[QuintQuerySource] Pushdown query returned ${results.length} results`);
      }
    } else {
      // No pushdown, get all matching quads
      const quintPattern = this.patternBuilder.buildBasePattern(pattern);
      const quads = await this.store.get(quintPattern, queryOptions);
      results = this.quadsToBindings(quads, variables, pattern);
      if (this.debug) {
        console.log(`[QuintQuerySource] Base query returned ${results.length} results`);
      }
    }

    // Apply in-memory filter for remainder
    if (remainder) {
      results = await this.expressionEvaluator.evaluateFilterTree(remainder, results, pattern);
      if (this.debug) {
        console.log(`[QuintQuerySource] After in-memory filter: ${results.length} results`);
      }
    }

    return results;
  }

  /**
   * Execute OR branches with union semantics
   */
  private async executeOrBranches(
    pattern: Algebra.Pattern,
    variables: Variable[],
    orBranches: PushdownFilters[],
    orNonPushdownBranches: Algebra.Expression[] | undefined,
    queryOptions: QueryOptions
  ): Promise<Bindings[]> {
    const seen = new Set<string>();
    const results: Bindings[] = [];

    // Execute each pushdownable branch
    for (const branchFilters of orBranches) {
      const quintPattern = this.patternBuilder.buildQuintPattern(pattern, branchFilters);
      const quads = await this.store.get(quintPattern, queryOptions);
      const bindings = this.quadsToBindings(quads, variables, pattern);
      
      for (const binding of bindings) {
        const key = this.expressionEvaluator.getBindingKey(binding);
        if (!seen.has(key)) {
          seen.add(key);
          results.push(binding);
        }
      }
    }

    // Handle non-pushdownable OR branches
    if (orNonPushdownBranches && orNonPushdownBranches.length > 0) {
      // Get base results without filter for in-memory evaluation
      const quintPattern = this.patternBuilder.buildBasePattern(pattern);
      const quads = await this.store.get(quintPattern, queryOptions);
      const candidates = this.quadsToBindings(quads, variables, pattern);
      
      // Evaluate each non-pushdownable branch
      for (const branchExpr of orNonPushdownBranches) {
        const branchResults = await this.expressionEvaluator.evaluateFilterTree(branchExpr, candidates, pattern);
        for (const binding of branchResults) {
          const key = this.expressionEvaluator.getBindingKey(binding);
          if (!seen.has(key)) {
            seen.add(key);
            results.push(binding);
          }
        }
      }
    }

    return results;
  }

  /**
   * Convert quads to bindings based on pattern variables
   */
  private quadsToBindings(quads: Quad[], variables: Variable[], pattern: Algebra.Pattern): Bindings[] {
    if (this.debug) {
      console.log(`[QuintQuerySource] quadsToBindings: ${quads.length} quads, ${variables.length} variables`);
      console.log(`[QuintQuerySource] Variables:`, variables.map(v => v.value));
      console.log(`[QuintQuerySource] Pattern:`, {
        subject: pattern.subject?.termType === 'Variable' ? `?${pattern.subject.value}` : pattern.subject?.value,
        predicate: pattern.predicate?.termType === 'Variable' ? `?${pattern.predicate.value}` : pattern.predicate?.value,
        object: pattern.object?.termType === 'Variable' ? `?${pattern.object.value}` : pattern.object?.value,
        graph: pattern.graph?.termType === 'Variable' ? `?${pattern.graph.value}` : pattern.graph?.value || pattern.graph?.termType,
      });
    }
    return quads.map(quad => {
      const entries: [Variable, Term][] = [];
      for (const v of variables) {
        const term = this.getTermForVariable(v, quad, pattern);
        if (term) {
          entries.push([v, term]);
        }
      }
      if (this.debug && entries.length !== variables.length) {
        console.log(`[QuintQuerySource] Warning: only ${entries.length} of ${variables.length} variables bound`);
      }
      return this.bindingsFactory.bindings(entries);
    });
  }

  /**
   * Get the term from quad that matches the variable position in pattern
   */
  private getTermForVariable(variable: Variable, quad: Quad, pattern: Algebra.Pattern): Term | null {
    const varName = variable.value;
    
    // Check which position in the pattern this variable is in
    if (pattern.subject?.termType === 'Variable' && pattern.subject.value === varName) {
      return quad.subject;
    }
    if (pattern.predicate?.termType === 'Variable' && pattern.predicate.value === varName) {
      return quad.predicate;
    }
    if (pattern.object?.termType === 'Variable' && pattern.object.value === varName) {
      return quad.object;
    }
    if (pattern.graph?.termType === 'Variable' && pattern.graph.value === varName) {
      return quad.graph;
    }
    
    return null;
  }

  /**
   * Extract BGP pattern and filter from operation
   */
  extractPatternAndFilter(operation: Algebra.Operation): { pattern: Algebra.Pattern; filter: Algebra.Expression | null } {
    let pattern: Algebra.Pattern | null = null;
    let filter: Algebra.Expression | null = null;

    // Walk the algebra tree to find pattern and filter
    AlgebraUtil.recurseOperation(operation, {
      [Algebra.types.PATTERN]: (op: Algebra.Pattern) => {
        if (!pattern) pattern = op;
        return false;
      },
      [Algebra.types.FILTER]: (op: Algebra.Filter) => {
        filter = op.expression;
        return true; // Continue to find pattern inside filter
      },
    });

    if (!pattern) {
      // Create empty pattern if none found
      pattern = {
        type: 'pattern',
        subject: dataFactory.variable('s'),
        predicate: dataFactory.variable('p'),
        object: dataFactory.variable('o'),
        graph: dataFactory.defaultGraph(),
      } as Algebra.Pattern;
    }

    return { pattern, filter };
  }

  /**
   * Get variables from operation
   */
  private getVariablesFromOperation(operation: Algebra.Operation): Variable[] {
    const { pattern } = this.extractPatternAndFilter(operation);
    return extractVariables(pattern);
  }

  // ============================================================
  // Required IQuerySource Methods
  // ============================================================

  queryQuads(operation: Algebra.Operation, _context: IActionContext): AsyncIterator<Quad> {
    const { pattern } = this.extractPatternAndFilter(operation);
    const quintPattern = this.patternBuilder.buildBasePattern(pattern);
    const resultIterator = wrap(this.store.get(quintPattern));
    
    resultIterator.setProperty('metadata', {
      state: { invalidate: () => {}, invalid: false, addInvalidateListener: () => {} },
      cardinality: { type: 'estimate' as const, value: Number.POSITIVE_INFINITY },
    });

    return resultIterator;
  }

  async queryBoolean(operation: Algebra.Ask, _context: IActionContext): Promise<boolean> {
    const { pattern } = this.extractPatternAndFilter(operation.input);
    const quintPattern = this.patternBuilder.buildBasePattern(pattern);
    const results = await this.store.get(quintPattern, { limit: 1 });
    return results.length > 0;
  }

  queryVoid(_operation: Algebra.Update, _context: IActionContext): Promise<void> {
    throw new Error('queryVoid is not implemented');
  }

  toString(): string {
    return `QuintQuerySource(${this.store.constructor.name})`;
  }
}
