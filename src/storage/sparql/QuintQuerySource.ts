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

import type { QuintStore, QuintPattern, QueryOptions, TermName, TermOperators, CompoundPattern, CompoundResult } from '../quint/types';
import type { SecurityFilters } from './ComunicaQuintEngine';
import { FilterPushdownExtractor, type PushdownFilters, type PushdownResult } from './FilterPushdownExtractor';
import { PatternBuilder } from './PatternBuilder';
import { ExpressionEvaluator } from './ExpressionEvaluator';
import { extractVariables } from './AlgebraUtils';
import { deserializeObject } from '../quint/serialization';

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
  /** 原始 ORDER BY 变量名，用于分析绑定位置 */
  orderVarName?: string;
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
  private readonly getFilterExpression: ((varName: string) => Algebra.Expression | undefined) | undefined;
  
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
      getFilterExpression?: (varName: string) => Algebra.Expression | undefined;
    }
  ) {
    this.store = store;
    this.referenceValue = store; // Reference for source identification
    this.debug = options.debug ?? false;
    this.bindingsFactory = options.bindingsFactory;
    this.getSecurityFilters = options.getSecurityFilters;
    this.getOptimizeParams = options.getOptimizeParams;
    this.getFilterExpression = options.getFilterExpression;
    
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
   * 
   * We support:
   * - Basic quad patterns (for simple queries)
   * - FILTER operations (for filter pushdown)
   * - BGP operations (for multi-pattern queries)
   * - joinBindings: allows Comunica to push JOIN operations down to us
   * 
   * The joinBindings support enables ActorRdfJoinMultiBindSource to push
   * multiple patterns to us efficiently, using SQL JOINs instead of
   * Comunica's nested loop approach.
   */
  async getSelectorShape(_context: IActionContext): Promise<FragmentSelectorShape> {
    // Check if store supports compound queries
    const supportsCompound = !!this.store.getCompound;
    
    return {
      type: 'disjunction',
      children: [
        // Support basic patterns with joinBindings
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
          // Allow Comunica to push join bindings to us
          ...(supportsCompound ? { joinBindings: true } : {}),
        },
        // Support BGP operations (multi-pattern queries)
        {
          type: 'operation',
          operation: {
            operationType: 'type',
            type: Algebra.types.BGP,
          },
          ...(supportsCompound ? { joinBindings: true } : {}),
        },
        // Support FILTER operations
        {
          type: 'operation',
          operation: {
            operationType: 'type',
            type: Algebra.types.FILTER,
          },
          ...(supportsCompound ? { joinBindings: true } : {}),
        },
        // Support JOIN operations (for receiving compound queries from Comunica)
        {
          type: 'operation',
          operation: {
            operationType: 'type',
            type: Algebra.types.JOIN,
          },
          ...(supportsCompound ? { joinBindings: true } : {}),
        },
      ],
    };
  }

  /**
   * Query bindings - main entry point for SPARQL queries
   * 
   * When Comunica's ActorRdfJoinMultiBindSource selects us for a join operation,
   * it passes options.joinBindings containing bindings from the first pattern.
   * We need to use these bindings to filter our query results efficiently.
   */
  queryBindings(operation: Algebra.Operation, _context: IActionContext, options?: IQueryBindingsOptions): BindingsStream {
    if (this.debug) {
      console.log(`[QuintQuerySource] queryBindings() called with operation type: ${operation.type}`);
      console.log(`[QuintQuerySource] Has joinBindings: ${!!options?.joinBindings}`);
      console.log(`[QuintQuerySource] Has filterBindings: ${!!options?.filterBindings}`);
      // Log operation structure
      if (operation.type === 'join' && (operation as any).input) {
        console.log(`[QuintQuerySource] JOIN inputs: ${(operation as any).input?.length || 0}`);
      }
    }

    // Wrap async execution in an iterator using wrap()
    const variables = this.getVariablesFromOperation(operation);
    const resultIterator = wrap(this.executeQuery(operation, options).then(results => results));

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
   * 
   * If options.joinBindings is provided, we need to:
   * 1. Collect bindings from the stream (these are from the first pattern in the JOIN)
   * 2. Extract variable values that overlap with our patterns
   * 3. Use those values as IN conditions in our query
   * 4. JOIN the results with the incoming bindings
   */
  private async executeQuery(operation: Algebra.Operation, options?: IQueryBindingsOptions): Promise<Bindings[]> {
    // Handle joinBindings from Comunica (bind join)
    if (options?.joinBindings && this.store.getCompound) {
      return this.executeBindJoin(operation, options.joinBindings);
    }

    const { pattern, patterns, filter } = this.extractPatternAndFilter(operation);
    
    // Check if we can use compound query (multiple patterns with same subject variable)
    if (patterns && patterns.length > 1 && this.store.getCompound) {
      const compoundResult = await this.tryCompoundQuery(patterns, filter, operation);
      if (compoundResult) {
        return compoundResult;
      }
      // Fall back to single pattern execution if compound query not applicable
    }

    const variables = extractVariables(pattern);

    // Try to get pre-extracted filter expressions for variables in this pattern
    let combinedFilter = filter;
    if (this.getFilterExpression && !filter) {
      // Check if any variable in the pattern has a pre-extracted filter
      for (const variable of variables) {
        const preExtractedFilter = this.getFilterExpression(variable.value);
        if (preExtractedFilter) {
          if (this.debug) {
            console.log(`[QuintQuerySource] Found pre-extracted filter for ?${variable.value}`);
          }
          if (combinedFilter) {
            // Combine with AND
            combinedFilter = {
              type: 'expression',
              expressionType: 'operator',
              operator: '&&',
              args: [combinedFilter, preExtractedFilter],
            } as Algebra.OperatorExpression;
          } else {
            combinedFilter = preExtractedFilter;
          }
        }
      }
    }

    // Extract pushdownable filters
    let pushdownFilters: PushdownFilters = {};
    let remainder: Algebra.Expression | null = combinedFilter;
    let orBranches: PushdownFilters[] | undefined;
    let orNonPushdownBranches: Algebra.Expression[] | undefined;

    if (combinedFilter) {
      const result = this.filterExtractor.extractPushdownFilters(combinedFilter, pattern);
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
    
    // 处理 ORDER BY 下推
    if (optimizeParams?.order) {
      // 直接使用已映射的 order
      queryOptions.order = optimizeParams.order;
    } else if (optimizeParams?.orderVarName) {
      // 通过 pattern 分析变量绑定位置
      const orderField = this.findVariableBinding(optimizeParams.orderVarName, pattern);
      if (orderField) {
        queryOptions.order = [orderField];
        if (this.debug) {
          console.log(`[QuintQuerySource] ORDER BY ?${optimizeParams.orderVarName} -> ${orderField} (via pattern analysis)`);
        }
      }
    }
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

    // NOTE: We don't apply in-memory filter for pre-extracted filters
    // because Comunica will handle the final filtering after JOIN
    // Only apply remainder if it's from the original operation's filter
    if (remainder && filter) {
      results = await this.expressionEvaluator.evaluateFilterTree(remainder, results, pattern);
      if (this.debug) {
        console.log(`[QuintQuerySource] After in-memory filter: ${results.length} results`);
      }
    }

    return results;
  }

  /**
   * Execute a bind join: use incoming bindings to filter our query
   * 
   * This is called when Comunica's ActorRdfJoinMultiBindSource pushes bindings to us.
   * We use SQL IN clause to efficiently query only the rows matching the incoming bindings.
   */
  private async executeBindJoin(
    operation: Algebra.Operation,
    joinBindings: NonNullable<IQueryBindingsOptions['joinBindings']>
  ): Promise<Bindings[]> {
    // Collect all incoming bindings
    const incomingBindings: Bindings[] = [];
    for await (const binding of joinBindings.bindings) {
      incomingBindings.push(binding);
    }

    if (this.debug) {
      console.log(`[QuintQuerySource] executeBindJoin: received ${incomingBindings.length} bindings`);
    }

    if (incomingBindings.length === 0) {
      return [];
    }

    // Extract patterns from the operation
    const { pattern, patterns, filter } = this.extractPatternAndFilter(operation);
    const allPatterns = patterns || [pattern];

    // Find overlapping variables between incoming bindings and our patterns
    // These are the JOIN keys
    const incomingVars = new Set<string>();
    const firstBinding = incomingBindings[0];
    for (const key of firstBinding.keys()) {
      incomingVars.add(key.value);
    }

    // Find which pattern variables overlap with incoming bindings
    // Typically this would be the subject variable
    const patternVars = new Map<string, { patternIdx: number; field: TermName }>();
    for (let i = 0; i < allPatterns.length; i++) {
      const p = allPatterns[i];
      if (p.subject?.termType === 'Variable' && incomingVars.has(p.subject.value)) {
        patternVars.set(p.subject.value, { patternIdx: i, field: 'subject' });
      }
      if (p.predicate?.termType === 'Variable' && incomingVars.has(p.predicate.value)) {
        patternVars.set(p.predicate.value, { patternIdx: i, field: 'predicate' });
      }
      if (p.object?.termType === 'Variable' && incomingVars.has(p.object.value)) {
        patternVars.set(p.object.value, { patternIdx: i, field: 'object' });
      }
      if (p.graph?.termType === 'Variable' && incomingVars.has(p.graph.value)) {
        patternVars.set(p.graph.value, { patternIdx: i, field: 'graph' });
      }
    }

    if (this.debug) {
      console.log(`[QuintQuerySource] Overlapping variables:`, [...patternVars.keys()]);
    }

    if (patternVars.size === 0) {
      // No overlapping variables - just execute normally and return cartesian product
      // This shouldn't happen in typical use cases
      const results = await this.executeQuery(operation);
      return this.cartesianJoin(incomingBindings, results);
    }

    // Use the first overlapping variable as the join key
    const [joinVarName, joinInfo] = [...patternVars.entries()][0];
    
    // Collect unique values for the join variable from incoming bindings
    const joinValues = new Set<string>();
    for (const binding of incomingBindings) {
      const term = binding.get(dataFactory.variable(joinVarName));
      if (term) {
        joinValues.add(term.value);
      }
    }

    if (this.debug) {
      console.log(`[QuintQuerySource] Join variable: ?${joinVarName}, ${joinValues.size} unique values`);
    }

    // Build compound query with IN filter on join variable
    if (allPatterns.length > 1) {
      // Multiple patterns - use compound query
      return this.executeBindJoinCompound(
        allPatterns, filter, joinVarName, joinInfo.field, 
        [...joinValues], incomingBindings
      );
    } else {
      // Single pattern - use simple query with IN filter
      return this.executeBindJoinSimple(
        pattern, filter, joinVarName, joinInfo.field,
        [...joinValues], incomingBindings
      );
    }
  }

  /**
   * Execute bind join for a single pattern using IN filter
   */
  private async executeBindJoinSimple(
    pattern: Algebra.Pattern,
    filter: Algebra.Expression | null,
    joinVarName: string,
    joinField: TermName,
    joinValues: string[],
    incomingBindings: Bindings[]
  ): Promise<Bindings[]> {
    const variables = extractVariables(pattern);

    // Build pattern with IN filter for join values
    let pushdownFilters: PushdownFilters = {};
    
    if (filter) {
      const result = this.filterExtractor.extractPushdownFilters(filter, pattern);
      pushdownFilters = result.filters;
    }

    // Add IN filter for join values
    pushdownFilters[joinField] = {
      ...pushdownFilters[joinField],
      $in: joinValues,
    };

    const quintPattern = this.patternBuilder.buildQuintPattern(pattern, pushdownFilters);
    const quads = await this.store.get(quintPattern);
    const queryResults = this.quadsToBindings(quads, variables, pattern);

    if (this.debug) {
      console.log(`[QuintQuerySource] Bind join simple: ${queryResults.length} results from DB`);
    }

    // Join with incoming bindings
    return this.hashJoin(incomingBindings, queryResults, joinVarName);
  }

  /**
   * Execute bind join for multiple patterns using compound query
   */
  private async executeBindJoinCompound(
    patterns: Algebra.Pattern[],
    filter: Algebra.Expression | null,
    joinVarName: string,
    joinField: TermName,
    joinValues: string[],
    incomingBindings: Bindings[]
  ): Promise<Bindings[]> {
    // Build QuintPattern for each pattern
    const quintPatterns: QuintPattern[] = [];
    const filtersByPattern = this.distributeFiltersToPatterns(filter, patterns);

    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i];
      const patternFilters = filtersByPattern.get(i) || {};
      
      // Add IN filter for join values on the first pattern
      if (i === 0) {
        patternFilters[joinField] = {
          ...patternFilters[joinField],
          $in: joinValues,
        };
      }
      
      const quintPattern = this.patternBuilder.buildQuintPattern(pattern, patternFilters);
      quintPatterns.push(quintPattern);
    }

    // Build compound pattern
    const compound: CompoundPattern = {
      patterns: quintPatterns,
      joinOn: joinField,
      select: this.buildSelectForPatterns(patterns),
    };

    const results = await this.store.getCompound!(compound);
    const queryResults = this.compoundResultsToBindings(results, patterns);

    if (this.debug) {
      console.log(`[QuintQuerySource] Bind join compound: ${queryResults.length} results from DB`);
    }

    // Join with incoming bindings
    return this.hashJoin(incomingBindings, queryResults, joinVarName);
  }

  /**
   * Hash join two binding sets on a common variable
   */
  private hashJoin(
    left: Bindings[],
    right: Bindings[],
    joinVarName: string
  ): Bindings[] {
    // Build hash table on right side
    const rightIndex = new Map<string, Bindings[]>();
    const joinVar = dataFactory.variable(joinVarName);
    
    for (const binding of right) {
      const term = binding.get(joinVar);
      if (term) {
        const key = term.value;
        if (!rightIndex.has(key)) {
          rightIndex.set(key, []);
        }
        rightIndex.get(key)!.push(binding);
      }
    }

    // Probe with left side
    const results: Bindings[] = [];
    for (const leftBinding of left) {
      const term = leftBinding.get(joinVar);
      if (term) {
        const key = term.value;
        const matches = rightIndex.get(key);
        if (matches) {
          for (const rightBinding of matches) {
            // Merge bindings
            const merged = this.mergeBindings(leftBinding, rightBinding);
            if (merged) {
              results.push(merged);
            }
          }
        }
      }
    }

    return results;
  }

  /**
   * Merge two bindings, returning null if they conflict
   */
  private mergeBindings(left: Bindings, right: Bindings): Bindings | null {
    const entries: [Variable, Term][] = [];
    
    // Add all from left
    for (const key of left.keys()) {
      const term = left.get(key);
      if (term) {
        entries.push([key, term]);
      }
    }
    
    // Add from right, checking for conflicts
    for (const key of right.keys()) {
      const rightTerm = right.get(key);
      const leftTerm = left.get(key);
      
      if (rightTerm) {
        if (leftTerm) {
          // Both have this variable - must match
          if (leftTerm.value !== rightTerm.value || leftTerm.termType !== rightTerm.termType) {
            return null; // Conflict
          }
          // Same value, already in entries
        } else {
          // Only right has it
          entries.push([key, rightTerm]);
        }
      }
    }
    
    return this.bindingsFactory.bindings(entries);
  }

  /**
   * Cartesian product of two binding sets
   */
  private cartesianJoin(left: Bindings[], right: Bindings[]): Bindings[] {
    const results: Bindings[] = [];
    for (const l of left) {
      for (const r of right) {
        const merged = this.mergeBindings(l, r);
        if (merged) {
          results.push(merged);
        }
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
   * Try to execute a compound query for multiple patterns joined by same subject
   * Returns null if compound query is not applicable
   */
  private async tryCompoundQuery(
    patterns: Algebra.Pattern[],
    filter: Algebra.Expression | null,
    _operation: Algebra.Operation
  ): Promise<Bindings[] | null> {
    // Check if all patterns share the same subject variable
    const subjectVars = patterns.map(p => 
      p.subject?.termType === 'Variable' ? p.subject.value : null
    );
    const uniqueSubjectVars = [...new Set(subjectVars.filter(v => v !== null))];
    
    if (uniqueSubjectVars.length !== 1) {
      // Not all patterns share the same subject variable
      if (this.debug) {
        console.log(`[QuintQuerySource] Cannot use compound query: different subject variables`, subjectVars);
      }
      return null;
    }

    const joinVar = uniqueSubjectVars[0];
    if (this.debug) {
      console.log(`[QuintQuerySource] Using compound query with ${patterns.length} patterns, joined on ?${joinVar}`);
    }

    // Build QuintPattern for each pattern, including filter conditions
    const quintPatterns: QuintPattern[] = [];
    const filtersByPattern = this.distributeFiltersToPatterns(filter, patterns);

    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i];
      const patternFilters = filtersByPattern.get(i) || {};
      
      const quintPattern = this.patternBuilder.buildQuintPattern(pattern, patternFilters);
      quintPatterns.push(quintPattern);
    }

    // Build compound pattern
    const compound: CompoundPattern = {
      patterns: quintPatterns,
      joinOn: 'subject',
      select: this.buildSelectForPatterns(patterns),
    };

    // Execute compound query
    const optimizeParams = this.getOptimizeParams();
    const queryOptions: QueryOptions = {};
    if (optimizeParams?.limit) {
      queryOptions.limit = optimizeParams.limit + (optimizeParams.offset || 0);
    }

    const results = await this.store.getCompound!(compound, queryOptions);

    // Convert CompoundResult to Bindings
    return this.compoundResultsToBindings(results, patterns);
  }

  /**
   * Distribute filter conditions to their respective patterns
   * Returns a map of pattern index -> PushdownFilters
   */
  private distributeFiltersToPatterns(
    filter: Algebra.Expression | null,
    patterns: Algebra.Pattern[]
  ): Map<number, PushdownFilters> {
    const result = new Map<number, PushdownFilters>();
    
    if (!filter) return result;

    // Build a map of variable name to pattern index
    const varToPatternIdx = new Map<string, number>();
    for (let i = 0; i < patterns.length; i++) {
      const p = patterns[i];
      if (p.object?.termType === 'Variable') {
        varToPatternIdx.set(p.object.value, i);
      }
    }

    // Extract filters and distribute them
    for (let i = 0; i < patterns.length; i++) {
      const patternResult = this.filterExtractor.extractPushdownFilters(filter, patterns[i]);
      if (Object.keys(patternResult.filters).length > 0) {
        result.set(i, patternResult.filters);
      }
    }

    return result;
  }

  /**
   * Build SELECT clause config for patterns
   */
  private buildSelectForPatterns(patterns: Algebra.Pattern[]): CompoundPattern['select'] {
    const select: NonNullable<CompoundPattern['select']> = [];
    
    for (let i = 0; i < patterns.length; i++) {
      const p = patterns[i];
      
      // Select object if it's a variable
      if (p.object?.termType === 'Variable') {
        select.push({
          pattern: i,
          field: 'object',
          alias: `p${i}_${p.object.value}`,
        });
      }
      
      // Select predicate if it's a variable
      if (p.predicate?.termType === 'Variable') {
        select.push({
          pattern: i,
          field: 'predicate',
          alias: `p${i}_${p.predicate.value}`,
        });
      }

      // Select graph if it's a variable
      if (p.graph?.termType === 'Variable') {
        select.push({
          pattern: i,
          field: 'graph',
          alias: `p${i}_${p.graph.value}`,
        });
      }
    }

    return select;
  }

  /**
   * Convert CompoundResult array to Bindings array
   */
  private compoundResultsToBindings(
    results: CompoundResult[],
    patterns: Algebra.Pattern[]
  ): Bindings[] {
    // Collect all variables from all patterns
    const variables: Variable[] = [];
    const varNames = new Set<string>();
    
    for (const p of patterns) {
      if (p.subject?.termType === 'Variable' && !varNames.has(p.subject.value)) {
        variables.push(p.subject as Variable);
        varNames.add(p.subject.value);
      }
      if (p.predicate?.termType === 'Variable' && !varNames.has(p.predicate.value)) {
        variables.push(p.predicate as Variable);
        varNames.add(p.predicate.value);
      }
      if (p.object?.termType === 'Variable' && !varNames.has(p.object.value)) {
        variables.push(p.object as Variable);
        varNames.add(p.object.value);
      }
      if (p.graph?.termType === 'Variable' && !varNames.has(p.graph.value)) {
        variables.push(p.graph as Variable);
        varNames.add(p.graph.value);
      }
    }

    return results.map(result => {
      const entries: [Variable, Term][] = [];
      
      for (const v of variables) {
        const varName = v.value;
        
        // Check if this is the join variable (subject)
        if (patterns[0].subject?.termType === 'Variable' && 
            patterns[0].subject.value === varName) {
          // Use joinValue for subject
          const term = dataFactory.namedNode(result.joinValue);
          entries.push([v, term]);
          continue;
        }
        
        // Look for the variable in bindings
        for (let i = 0; i < patterns.length; i++) {
          const p = patterns[i];
          
          if (p.object?.termType === 'Variable' && p.object.value === varName) {
            const alias = `p${i}_${varName}`;
            const value = result.bindings[alias];
            if (value !== undefined) {
              // Deserialize the value
              const term = this.deserializeValue(value);
              entries.push([v, term]);
              break;
            }
          }
          
          if (p.predicate?.termType === 'Variable' && p.predicate.value === varName) {
            const alias = `p${i}_${varName}`;
            const value = result.bindings[alias];
            if (value !== undefined) {
              const term = dataFactory.namedNode(value);
              entries.push([v, term]);
              break;
            }
          }

          if (p.graph?.termType === 'Variable' && p.graph.value === varName) {
            const alias = `p${i}_${varName}`;
            const value = result.bindings[alias];
            if (value !== undefined) {
              const term = dataFactory.namedNode(value);
              entries.push([v, term]);
              break;
            }
          }
        }
      }
      
      return this.bindingsFactory.bindings(entries);
    });
  }

  /**
   * Deserialize a value from storage format to RDF Term
   * Uses the same deserialization logic as QuintStore
   */
  private deserializeValue(value: string): Term {
    return deserializeObject(value);
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
   * Returns either a single pattern or multiple patterns (from BGP or JOIN)
   */
  extractPatternAndFilter(operation: Algebra.Operation): { 
    pattern: Algebra.Pattern; 
    patterns?: Algebra.Pattern[];  // Multiple patterns from BGP or JOIN
    filter: Algebra.Expression | null;
  } {
    let pattern: Algebra.Pattern | null = null;
    let patterns: Algebra.Pattern[] | undefined;
    let filter: Algebra.Expression | null = null;

    // Walk the algebra tree to find pattern(s) and filter
    AlgebraUtil.recurseOperation(operation, {
      [Algebra.types.JOIN]: (op: Algebra.Join) => {
        // JOIN contains multiple patterns - extract them all
        if (op.input && op.input.length > 0) {
          const extractedPatterns: Algebra.Pattern[] = [];
          for (const input of op.input) {
            if (input.type === Algebra.types.PATTERN) {
              extractedPatterns.push(input as Algebra.Pattern);
            } else {
              // Recurse into nested operation to find patterns
              const nested = this.extractPatternAndFilter(input);
              if (nested.patterns) {
                extractedPatterns.push(...nested.patterns);
              } else if (nested.pattern) {
                extractedPatterns.push(nested.pattern);
              }
              // Also collect filter from nested operations
              if (nested.filter && !filter) {
                filter = nested.filter;
              }
            }
          }
          if (extractedPatterns.length > 0) {
            patterns = extractedPatterns;
            if (!pattern) {
              pattern = patterns[0];
            }
          }
        }
        return false; // Don't recurse further
      },
      [Algebra.types.BGP]: (op: Algebra.Bgp) => {
        // BGP contains multiple patterns - this is what we want for compound queries
        if (op.patterns && op.patterns.length > 0) {
          patterns = op.patterns as Algebra.Pattern[];
          if (!pattern) {
            pattern = patterns[0];
          }
        }
        return false; // Don't recurse into individual patterns
      },
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

    return { pattern, patterns, filter };
  }

  /**
   * Get variables from operation
   */
  private getVariablesFromOperation(operation: Algebra.Operation): Variable[] {
    const { pattern, patterns } = this.extractPatternAndFilter(operation);
    
    if (patterns && patterns.length > 1) {
      // Collect variables from all patterns
      const allVars: Variable[] = [];
      const seen = new Set<string>();
      for (const p of patterns) {
        for (const v of extractVariables(p)) {
          if (!seen.has(v.value)) {
            seen.add(v.value);
            allVars.push(v);
          }
        }
      }
      return allVars;
    }
    
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

  /**
   * 在 pattern 中查找变量绑定到哪个位置
   * 
   * 例如：{ ?s <http://schema.org/name> ?name }
   * - ?s 绑定到 subject
   * - ?name 绑定到 object
   */
  private findVariableBinding(varName: string, pattern: Algebra.Pattern): TermName | null {
    if (pattern.subject?.termType === 'Variable' && pattern.subject.value === varName) {
      return 'subject';
    }
    if (pattern.predicate?.termType === 'Variable' && pattern.predicate.value === varName) {
      return 'predicate';
    }
    if (pattern.object?.termType === 'Variable' && pattern.object.value === varName) {
      return 'object';
    }
    if (pattern.graph?.termType === 'Variable' && pattern.graph.value === varName) {
      return 'graph';
    }
    return null;
  }

  toString(): string {
    return `QuintQuerySource(${this.store.constructor.name})`;
  }
}
