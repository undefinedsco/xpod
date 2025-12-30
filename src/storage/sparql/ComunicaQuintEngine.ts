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

/**
 * OPTIONAL 优化分析结果
 * 
 * 用于检测可优化的 OPTIONAL 模式：
 * SELECT ?s ?prop1 ?prop2 ... WHERE {
 *   ?s ... (core conditions)
 *   OPTIONAL { ?s <pred1> ?prop1 }
 *   OPTIONAL { ?s <pred2> ?prop2 }
 * }
 * 
 * 如果 OPTIONAL 只是获取属性（不参与过滤），可以优化为：
 * 1. 先执行核心条件获取所有 subjects
 * 2. 批量获取这些 subjects 的所有属性
 */
interface OptionalOptimization {
  /** 是否可优化 */
  canOptimize: boolean;
  /** 核心查询（不含 OPTIONAL） */
  coreOperation?: Algebra.Operation;
  /** subject 变量名 */
  subjectVar?: string;
  /** 要获取的属性 predicates */
  optionalPredicates?: string[];
  /** 各 OPTIONAL 的变量名 */
  optionalVars?: Map<string, string>;  // predicate -> variable
  /** 不能优化的原因 */
  reason?: string;
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
  // Current query's FILTER expressions for pushdown
  private currentFilterExpressions: Map<string, Algebra.Expression> = new Map();

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
      getFilterExpression: (varName: string) => this.currentFilterExpressions.get(varName),
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
   * 
   * OPTIONAL 优化：
   * 如果查询包含多个 OPTIONAL 且只是获取属性（不参与过滤），
   * 则先执行核心条件获取 subjects，再批量获取属性
   */
  async queryBindings(query: string, context?: QueryContext): Promise<ResultStream<Bindings>> {
    const params = this.extractOptimizeParams(query);
    this.currentOptimizeParams = params;
    this.currentSecurityFilters = context?.filters;
    
    // Extract FILTER expressions from the query for pushdown
    // Note: We don't clear these in finally because the stream is lazy-evaluated
    // and sub-queries may need access to filters after this function returns
    this.extractAndStoreFilters(query);
    
    if (this.debug) {
      console.log(`[ComunicaQuintEngine] Query optimization:`, this.currentOptimizeParams);
      console.log(`[ComunicaQuintEngine] Security filters:`, this.currentSecurityFilters);
      console.log(`[ComunicaQuintEngine] Filter expressions for pushdown:`, this.currentFilterExpressions.size);
    }

    // 尝试 OPTIONAL 优化
    if (this.store.getAttributes) {
      try {
        const algebra = translate(query, { quads: true });
        const optionalOpt = this.analyzeOptionalOptimization(algebra);
        
        if (optionalOpt.canOptimize && this.debug) {
          console.log(`[ComunicaQuintEngine] OPTIONAL optimization available:`, {
            subjectVar: optionalOpt.subjectVar,
            predicates: optionalOpt.optionalPredicates?.length,
          });
        }
        
        if (optionalOpt.canOptimize) {
          const optimizedResult = await this.executeOptionalOptimized(
            algebra,
            optionalOpt,
            context
          );
          if (optimizedResult) {
            return optimizedResult;
          }
        }
      } catch (error) {
        if (this.debug) {
          console.log(`[ComunicaQuintEngine] OPTIONAL optimization failed, falling back:`, error);
        }
      }
    }

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
  }

  /**
   * 分析查询是否可以进行 OPTIONAL 优化
   * 
   * 可优化条件：
   * 1. 有核心条件（BGP 或带 FILTER 的 BGP）
   * 2. 有多个 OPTIONAL（>= 2 个才值得优化）
   * 3. 所有 OPTIONAL 都是简单的属性获取：?s <pred> ?var
   * 4. 所有 OPTIONAL 使用同一个 subject 变量
   * 5. OPTIONAL 内部没有额外的 FILTER
   */
  private analyzeOptionalOptimization(algebra: Algebra.Operation): OptionalOptimization {
    // 从 project -> slice -> ... 找到实际的查询结构
    let current = algebra;
    while (current.type === 'project' || current.type === 'slice' || 
           current.type === 'distinct' || current.type === 'reduced') {
      current = (current as any).input;
    }

    // 收集所有 leftjoin（OPTIONAL）和核心操作
    const leftJoins: Algebra.LeftJoin[] = [];
    let coreOp: Algebra.Operation | null = null;

    // 递归收集 leftjoin
    const collectLeftJoins = (op: Algebra.Operation): void => {
      if (op.type === 'leftjoin') {
        const lj = op as Algebra.LeftJoin;
        leftJoins.push(lj);
        // 继续检查左边是否还有 leftjoin
        collectLeftJoins(lj.input[0]);
      } else {
        // 找到核心操作
        coreOp = op;
      }
    };

    collectLeftJoins(current);

    if (leftJoins.length < 1) {
      return { 
        canOptimize: false, 
        reason: 'No OPTIONAL found' 
      };
    }

    if (!coreOp) {
      return { canOptimize: false, reason: 'No core operation found' };
    }

    // 分析核心操作获取 subject 变量
    const subjectVar = this.extractSubjectVariable(coreOp);
    if (!subjectVar) {
      return { canOptimize: false, reason: 'Cannot determine subject variable from core operation' };
    }

    // 分析所有 OPTIONAL，确保都是简单的属性获取
    const optionalPredicates: string[] = [];
    const optionalVars = new Map<string, string>();

    for (const lj of leftJoins) {
      // OPTIONAL 右边应该是一个简单的 pattern 或 BGP
      const right = lj.input[1];
      
      // 检查是否有额外的 filter（expression 字段）
      if ((lj as any).expression) {
        return { 
          canOptimize: false, 
          reason: 'OPTIONAL contains FILTER expression, cannot optimize' 
        };
      }

      const patternInfo = this.extractSimplePattern(right);
      if (!patternInfo) {
        return { 
          canOptimize: false, 
          reason: 'OPTIONAL is not a simple pattern' 
        };
      }

      // 检查 subject 是否匹配
      if (patternInfo.subjectVar !== subjectVar) {
        return { 
          canOptimize: false, 
          reason: `OPTIONAL subject ?${patternInfo.subjectVar} doesn't match core subject ?${subjectVar}` 
        };
      }

      // 检查 predicate 是否是常量
      if (!patternInfo.predicate) {
        return { 
          canOptimize: false, 
          reason: 'OPTIONAL predicate must be a constant' 
        };
      }

      optionalPredicates.push(patternInfo.predicate);
      if (patternInfo.objectVar) {
        optionalVars.set(patternInfo.predicate, patternInfo.objectVar);
      }
    }

    return {
      canOptimize: true,
      coreOperation: coreOp,
      subjectVar,
      optionalPredicates,
      optionalVars,
    };
  }

  /**
   * 从核心操作提取 subject 变量
   */
  private extractSubjectVariable(op: Algebra.Operation): string | null {
    if (op.type === 'pattern') {
      const pattern = op as Algebra.Pattern;
      if (pattern.subject?.termType === 'Variable') {
        return pattern.subject.value;
      }
    } else if (op.type === 'bgp') {
      const bgp = op as Algebra.Bgp;
      if (bgp.patterns.length > 0) {
        const firstPattern = bgp.patterns[0] as Algebra.Pattern;
        if (firstPattern.subject?.termType === 'Variable') {
          return firstPattern.subject.value;
        }
      }
    } else if (op.type === 'filter') {
      const filter = op as Algebra.Filter;
      return this.extractSubjectVariable(filter.input);
    } else if (op.type === 'join') {
      const join = op as Algebra.Join;
      if (join.input && join.input.length > 0) {
        return this.extractSubjectVariable(join.input[0]);
      }
    }
    return null;
  }

  /**
   * 从 OPTIONAL 的右操作数提取简单 pattern 信息
   */
  private extractSimplePattern(op: Algebra.Operation): {
    subjectVar: string;
    predicate: string | null;
    objectVar: string | null;
  } | null {
    if (op.type === 'pattern') {
      const pattern = op as Algebra.Pattern;
      if (pattern.subject?.termType !== 'Variable') {
        return null;
      }
      return {
        subjectVar: pattern.subject.value,
        predicate: pattern.predicate?.termType === 'NamedNode' ? pattern.predicate.value : null,
        objectVar: pattern.object?.termType === 'Variable' ? pattern.object.value : null,
      };
    } else if (op.type === 'bgp') {
      const bgp = op as Algebra.Bgp;
      if (bgp.patterns.length === 1) {
        return this.extractSimplePattern(bgp.patterns[0] as Algebra.Operation);
      }
    }
    return null;
  }

  /**
   * 执行 OPTIONAL 优化的查询
   * 
   * 1. 先执行核心查询获取所有 subjects
   * 2. 用 getAttributes 批量获取属性
   * 3. 组装结果
   */
  private async executeOptionalOptimized(
    _fullAlgebra: Algebra.Operation,
    opt: OptionalOptimization,
    context?: QueryContext
  ): Promise<ResultStream<Bindings> | null> {
    const { coreOperation, subjectVar, optionalPredicates, optionalVars } = opt;
    
    if (!coreOperation || !subjectVar || !optionalPredicates || !optionalVars) {
      return null;
    }

    if (this.debug) {
      console.log(`[ComunicaQuintEngine] Executing OPTIONAL optimized query`);
      console.log(`  Subject var: ?${subjectVar}`);
      console.log(`  Optional predicates: ${optionalPredicates.length}`);
    }

    // Step 1: 执行核心查询获取所有 subjects
    // 构造一个只包含核心条件的 SPARQL 查询
    const coreBindings = await this.executeCoreQuery(coreOperation, context);
    
    if (coreBindings.length === 0) {
      // 没有匹配结果，返回空
      const emptyArray: Bindings[] = [];
      const resultStream = wrap(Promise.resolve(emptyArray));
      return resultStream as ResultStream<Bindings>;
    }

    // 提取所有 subject 值
    const subjects: string[] = [];
    for (const binding of coreBindings) {
      const subjectTerm = binding.get(dataFactory.variable(subjectVar));
      if (subjectTerm && subjectTerm.termType === 'NamedNode') {
        subjects.push(subjectTerm.value);
      }
    }

    if (this.debug) {
      console.log(`  Core query returned ${coreBindings.length} bindings, ${subjects.length} unique subjects`);
    }

    // Step 2: 批量获取属性
    const attributeMap = await this.store.getAttributes!(
      subjects,
      optionalPredicates,
      undefined  // TODO: 支持 graph 过滤
    );

    if (this.debug) {
      console.log(`  getAttributes returned data for ${attributeMap.size} subjects`);
    }

    // Step 3: 组装结果
    const results: Bindings[] = [];
    
    for (const coreBinding of coreBindings) {
      const subjectTerm = coreBinding.get(dataFactory.variable(subjectVar));
      if (!subjectTerm || subjectTerm.termType !== 'NamedNode') {
        results.push(coreBinding);
        continue;
      }

      const subjectAttrs = attributeMap.get(subjectTerm.value);
      
      // 创建包含所有 OPTIONAL 变量的新 binding
      const entries: [any, Term][] = [];
      
      // 复制核心 binding 的所有变量
      for (const v of coreBinding.keys()) {
        const term = coreBinding.get(v);
        if (term) {
          entries.push([v, term]);
        }
      }

      // 添加 OPTIONAL 变量
      for (const [predicate, varName] of optionalVars) {
        const values = subjectAttrs?.get(predicate);
        if (values && values.length > 0) {
          // 只取第一个值（标准 OPTIONAL 语义）
          entries.push([dataFactory.variable(varName), values[0]]);
        }
        // 如果没有值，变量不绑定（OPTIONAL 语义）
      }

      results.push(this.bindingsFactory.bindings(entries));
    }

    if (this.debug) {
      console.log(`  Final result: ${results.length} bindings`);
    }

    // 转换为 ResultStream
    const resultStream = wrap(Promise.resolve(results));
    return resultStream as ResultStream<Bindings>;
  }

  /**
   * 执行核心查询（不含 OPTIONAL）
   */
  private async executeCoreQuery(
    coreOperation: Algebra.Operation,
    context?: QueryContext
  ): Promise<Bindings[]> {
    // 使用 QuintQuerySource 直接执行核心操作
    // 这避免了通过 Comunica 的完整查询处理
    const bindings: Bindings[] = [];
    
    const { sources: _ignored, filters: _filters, ...restContext } = context || {};
    const queryContext = {
      ...restContext,
      [CONTEXT_KEY_QUERY_SOURCES]: [{ source: this.querySource }],
    };

    // 创建一个模拟的 context
    const mockContext = {
      get: <V>() => undefined as V | undefined,
      getSafe: <V>() => { throw new Error('Not implemented'); },
      has: () => false,
    };

    const stream = this.querySource.queryBindings(coreOperation, mockContext as any, undefined);
    
    for await (const binding of stream) {
      bindings.push(binding);
    }

    return bindings;
  }
  
  /**
   * Extract FILTER expressions from query and store them for later pushdown
   * Maps variable names to their filter expressions
   */
  private extractAndStoreFilters(query: string): void {
    this.currentFilterExpressions.clear();
    
    try {
      const algebra = translate(query, { quads: true });
      this.collectFilterExpressions(algebra);
    } catch (error) {
      if (this.debug) {
        console.log(`[ComunicaQuintEngine] Failed to extract filters:`, error);
      }
    }
  }
  
  /**
   * Recursively collect FILTER expressions and their variable bindings
   */
  private collectFilterExpressions(op: Algebra.Operation): void {
    if (op.type === 'filter') {
      const filterOp = op as Algebra.Filter;
      const expression = filterOp.expression;
      
      // Extract variables from the expression
      const variables = this.getExpressionVariables(expression);
      
      // Store the expression for each variable
      for (const varName of variables) {
        // Merge with existing expressions for this variable
        const existing = this.currentFilterExpressions.get(varName);
        if (existing) {
          // Combine with AND
          this.currentFilterExpressions.set(varName, {
            type: 'expression',
            expressionType: 'operator',
            operator: '&&',
            args: [existing, expression],
          } as Algebra.OperatorExpression);
        } else {
          this.currentFilterExpressions.set(varName, expression);
        }
      }
      
      // Continue to nested operations
      this.collectFilterExpressions(filterOp.input);
    } else if ('input' in op && op.input) {
      if (Array.isArray(op.input)) {
        for (const child of op.input) {
          this.collectFilterExpressions(child as Algebra.Operation);
        }
      } else {
        this.collectFilterExpressions(op.input as Algebra.Operation);
      }
    }
    if ('left' in op && op.left) {
      this.collectFilterExpressions(op.left as Algebra.Operation);
    }
    if ('right' in op && op.right) {
      this.collectFilterExpressions(op.right as Algebra.Operation);
    }
  }
  
  /**
   * Get variable names from an expression
   */
  private getExpressionVariables(expr: Algebra.Expression): string[] {
    const variables: string[] = [];
    
    const collectVars = (e: Algebra.Expression): void => {
      if (e.expressionType === 'term') {
        const term = (e as Algebra.TermExpression).term;
        if (term.termType === 'Variable') {
          variables.push(term.value);
        }
      } else if (e.expressionType === 'operator') {
        const opExpr = e as Algebra.OperatorExpression;
        for (const arg of opExpr.args) {
          collectVars(arg);
        }
      }
    };
    
    collectVars(expr);
    return variables;
  }
  
  /**
   * Get the current filter expression for a variable (used by QuintQuerySource)
   */
  getFilterExpressionForVariable(varName: string): Algebra.Expression | undefined {
    return this.currentFilterExpressions.get(varName);
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
