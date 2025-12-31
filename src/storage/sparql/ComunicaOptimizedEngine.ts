/**
 * ComunicaOptimizedEngine - 基于 Comunica 的优化查询引擎
 * 
 * 通过自定义 Source 实现查询下推优化：
 * 1. 在查询执行前分析 SPARQL，提取 LIMIT/ORDER BY 等优化参数
 * 2. 将参数存储在 Engine 实例上
 * 3. 自定义 Source 在 match() 时读取这些参数并传给 quadstore
 */

import type { Quad, Term } from '@rdfjs/types';
import type { Bindings, ResultStream } from '@rdfjs/types';
import type * as RDF from '@rdfjs/types';
import { QueryEngine } from '@comunica/query-sparql-rdfjs';
import { Quadstore, type TermName, type GetOpts, type Pattern } from 'quadstore';
import { translate, type Algebra } from 'sparqlalgebrajs';
import { wrap, AsyncIterator } from 'asynciterator';

export interface ComunicaOptimizedEngineOptions {
  debug?: boolean;
}

export interface QueryContext {
  sources?: unknown[];
  baseIRI?: string;
  [key: string]: unknown;
}

interface OptimizeParams {
  limit?: number;
  offset?: number;
  order?: TermName[];
  reverse?: boolean;
}

/**
 * 自定义 RDF/JS Source，通过闭包访问优化参数
 */
class OptimizedSource implements RDF.Source {
  constructor(
    private readonly store: Quadstore,
    private readonly getParams: () => OptimizeParams | null,
    private readonly debug: boolean
  ) {}

  match(
    subject?: Term | null,
    predicate?: Term | null,
    object?: Term | null,
    graph?: Term | null
  ): RDF.Stream {
    // 构建 quadstore pattern
    const pattern: Pattern = {};
    if (subject && subject.termType !== 'Variable') {
      pattern.subject = subject as any;
    }
    if (predicate && predicate.termType !== 'Variable') {
      pattern.predicate = predicate as any;
    }
    if (object && object.termType !== 'Variable') {
      pattern.object = object as any;
    }
    if (graph && graph.termType !== 'Variable' && graph.termType !== 'DefaultGraph') {
      pattern.graph = graph as any;
    }

    // 获取优化参数
    const params = this.getParams();
    const opts: GetOpts = {};
    
    if (params) {
      if (params.limit !== undefined) {
        // 如果有 offset，需要多获取一些
        opts.limit = params.limit + (params.offset ?? 0);
      }
      if (params.order !== undefined) {
        opts.order = params.order;
      }
      if (params.reverse !== undefined) {
        opts.reverse = params.reverse;
      }
    }

    if (this.debug) {
      console.log(`[OptimizedSource] match() called`);
      console.log(`  pattern: ${JSON.stringify(pattern)}`);
      console.log(`  opts: ${JSON.stringify(opts)}`);
    }

    // 使用 wrap 函数将 Promise<Array> 转换为 AsyncIterator
    // wrap 会正确处理空数组的情况
    const promiseIterator = wrap(
      this.store.get(pattern, opts).then(result => result.items)
    );

    return promiseIterator as any;
  }
}

export class ComunicaOptimizedEngine {
  private readonly store: Quadstore;
  private readonly source: OptimizedSource;
  private readonly engine: QueryEngine;
  private readonly debug: boolean;
  
  // 当前查询的优化参数（通过闭包共享给 Source）
  private currentOptimizeParams: OptimizeParams | null = null;

  constructor(store: Quadstore, options?: ComunicaOptimizedEngineOptions) {
    this.store = store;
    this.debug = options?.debug ?? false;
    
    // 创建 Source，通过闭包访问 currentOptimizeParams
    this.source = new OptimizedSource(
      store,
      () => this.currentOptimizeParams,
      this.debug
    );
    
    this.engine = new QueryEngine();
  }

  /**
   * 执行 SELECT 查询
   */
  async queryBindings(query: string, context?: QueryContext): Promise<ResultStream<Bindings>> {
    // 分析查询，设置优化参数
    this.currentOptimizeParams = this.analyzeQuery(query);
    
    if (this.debug && this.currentOptimizeParams) {
      console.log(`[ComunicaOptimizedEngine] Optimization params:`, this.currentOptimizeParams);
    }

    try {
      return await this.engine.queryBindings(query, {
        sources: [this.source],
        ...context,
      } as any);
    } finally {
      // 查询完成后清除参数
      this.currentOptimizeParams = null;
    }
  }

  /**
   * 执行 ASK 查询
   */
  async queryBoolean(query: string, context?: QueryContext): Promise<boolean> {
    this.currentOptimizeParams = this.analyzeQuery(query);
    // 对于 ASK，设置 limit=1 优化
    if (!this.currentOptimizeParams) {
      this.currentOptimizeParams = { limit: 1 };
    } else if (this.currentOptimizeParams.limit === undefined) {
      this.currentOptimizeParams.limit = 1;
    }
    
    try {
      return await this.engine.queryBoolean(query, {
        sources: [this.source],
        ...context,
      } as any);
    } finally {
      this.currentOptimizeParams = null;
    }
  }

  /**
   * 执行 CONSTRUCT/DESCRIBE 查询
   */
  async queryQuads(query: string, context?: QueryContext): Promise<ResultStream<Quad>> {
    this.currentOptimizeParams = this.analyzeQuery(query);
    
    try {
      return await this.engine.queryQuads(query, {
        sources: [this.source],
        ...context,
      } as any);
    } finally {
      this.currentOptimizeParams = null;
    }
  }

  /**
   * 执行 UPDATE 查询
   */
  async queryVoid(query: string, context?: QueryContext): Promise<void> {
    // UPDATE 不需要优化
    return this.engine.queryVoid(query, {
      sources: [this.source],
      ...context,
    } as any);
  }

  /**
   * 分析查询，提取优化参数
   */
  private analyzeQuery(query: string): OptimizeParams | null {
    try {
      const algebra = translate(query, { quads: true });
      return this.extractOptimizeParams(algebra);
    } catch (error) {
      if (this.debug) {
        console.log(`[ComunicaOptimizedEngine] Failed to analyze query:`, error);
      }
      return null;
    }
  }

  /**
   * 从 Algebra 提取优化参数
   * 
   * 只提取可以安全下推的参数：
   * - LIMIT（对于单 BGP 查询可以直接下推）
   * - ORDER BY（简单变量排序）
   */
  private extractOptimizeParams(algebra: Algebra.Operation): OptimizeParams | null {
    let limit: number | undefined;
    let offset: number | undefined;
    let order: TermName[] | undefined;
    let reverse: boolean | undefined;
    let currentOp = algebra;
    let canPushLimit = true;  // 是否可以下推 LIMIT

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
            // 单个 triple pattern，可以完全下推
            return { limit, offset, order, reverse };
          }
          // 多个 patterns 需要 JOIN，只能下推到每个 pattern
          // 但 LIMIT 不能直接下推（会影响 JOIN 结果）
          canPushLimit = false;
          return canPushLimit ? { limit, offset, order, reverse } : null;
        }

        case 'join':
        case 'leftjoin':
        case 'union':
        case 'minus':
          // 复杂操作，不能直接下推 LIMIT
          canPushLimit = false;
          return null;

        case 'filter':
        case 'extend':
        case 'group':
          // 这些操作不支持优化
          return null;

        default:
          return null;
      }
    }

    return null;
  }

  /**
   * 将 SPARQL 变量名映射到 quadstore 的 TermName
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
