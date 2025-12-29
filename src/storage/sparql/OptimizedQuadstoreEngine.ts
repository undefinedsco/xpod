/**
 * OptimizedQuadstoreEngine - 优化的 SPARQL 查询引擎
 *
 * 在 quadstore-comunica Engine 基础上增加查询优化：
 * - 对于简单查询（单 BGP），直接使用 quadstore API，支持 LIMIT/ORDER BY 下推
 * - 对于复杂查询（JOIN/OPTIONAL/UNION/FILTER），委托给 Comunica
 */

import type { Quad, Term, Variable } from '@rdfjs/types';
import type { ResultStream, Bindings } from '@rdfjs/types';
import { Engine as QuadstoreEngine } from 'quadstore-comunica';
import { Quadstore, type GetOpts, type TermName, type Pattern } from 'quadstore';
import type { Algebra } from 'sparqlalgebrajs';
import { translate } from 'sparqlalgebrajs';
import { ArrayIterator } from 'asynciterator';

/**
 * 简单的 Bindings 实现
 */
export class SimpleBindings extends Map<string, Term> {
  override get(key: string | Variable): Term | undefined {
    const varName = typeof key === 'string' ? key : key.value;
    return super.get(varName);
  }

  override has(key: string | Variable): boolean {
    const varName = typeof key === 'string' ? key : key.value;
    return super.has(varName);
  }
}

/**
 * 优化参数
 */
interface OptimizeParams {
  limit?: number;
  offset?: number;
  order?: TermName[];
  reverse?: boolean;
  pattern: {
    subject?: Term;
    predicate?: Term;
    object?: Term;
    graph?: Term;
    subjectVar?: string;
    predicateVar?: string;
    objectVar?: string;
    graphVar?: string;
  };
  variables: string[];
  distinct?: boolean;
}

/**
 * 优化的 Quadstore SPARQL 引擎
 */
export class OptimizedQuadstoreEngine {
  private readonly comunica: QuadstoreEngine;
  private readonly quadstore: Quadstore;
  private readonly debug: boolean;

  constructor(store: Quadstore, debug = false) {
    this.quadstore = store;
    this.comunica = new QuadstoreEngine(store);
    this.debug = debug;
  }

  private log(msg: string): void {
    if (this.debug) {
      console.log(`[OptimizedQuadstoreEngine] ${msg}`);
    }
  }

  /**
   * 获取底层 quadstore
   */
  getStore(): Quadstore {
    return this.quadstore;
  }

  /**
   * 执行 SELECT 查询
   */
  async queryBindings(query: string, context?: any): Promise<ResultStream<Bindings>> {
    const params = this.analyzeQuery(query);
    
    if (params) {
      this.log(`Using optimized path for SELECT`);
      return this.executeOptimizedSelect(params);
    }

    this.log(`Using Comunica for SELECT`);
    return this.comunica.queryBindings(query, context);
  }

  /**
   * 执行 ASK 查询
   */
  async queryBoolean(query: string, context?: any): Promise<boolean> {
    const params = this.analyzeQuery(query);
    
    if (params) {
      this.log(`Using optimized path for ASK`);
      params.limit = 1;
      const results = await this.executeOptimizedSelect(params);
      const arr = await this.streamToArray(results);
      return arr.length > 0;
    }

    this.log(`Using Comunica for ASK`);
    return this.comunica.queryBoolean(query, context);
  }

  /**
   * 执行 CONSTRUCT/DESCRIBE 查询
   */
  async queryQuads(query: string, context?: any): Promise<ResultStream<Quad>> {
    this.log(`Using Comunica for CONSTRUCT/DESCRIBE`);
    return this.comunica.queryQuads(query, context);
  }

  /**
   * 执行 UPDATE 查询
   */
  async queryVoid(query: string, context?: any): Promise<void> {
    return this.comunica.queryVoid(query, context);
  }

  /**
   * 分析查询，判断是否可以优化
   */
  private analyzeQuery(query: string): OptimizeParams | null {
    try {
      const algebra = translate(query);
      return this.analyzeAlgebra(algebra);
    } catch (error) {
      this.log(`Failed to analyze query: ${error}`);
      return null;
    }
  }

  /**
   * 分析 Algebra 树
   */
  private analyzeAlgebra(op: Algebra.Operation): OptimizeParams | null {
    const params: OptimizeParams = {
      pattern: {},
      variables: [],
    };

    let current: Algebra.Operation = op;
    let bgpFound = false;

    while (current) {
      switch (current.type) {
        case 'project': {
          const project = current as Algebra.Project;
          params.variables = project.variables.map(v => v.value);
          current = project.input;
          break;
        }

        case 'slice': {
          const slice = current as Algebra.Slice;
          if (slice.length !== undefined) {
            params.limit = slice.length;
          }
          if (slice.start !== undefined && slice.start > 0) {
            params.offset = slice.start;
          }
          current = slice.input;
          break;
        }

        case 'distinct':
          params.distinct = true;
          current = (current as Algebra.Distinct).input;
          break;

        case 'reduced':
          current = (current as Algebra.Reduced).input;
          break;

        case 'orderby': {
          const orderBy = current as Algebra.OrderBy;
          if (orderBy.expressions.length === 1) {
            const expr = orderBy.expressions[0] as any;
            if (expr.expression?.expressionType === 'term' && expr.expression.term.termType === 'Variable') {
              const varName = expr.expression.term.value;
              const termName = this.varNameToTermName(varName);
              if (termName) {
                params.order = [termName];
                params.reverse = expr.descending || false;
              }
            }
          }
          current = orderBy.input;
          break;
        }

        case 'filter':
          // FILTER 查询暂时不优化，让 Comunica 处理
          this.log(`Query has filter, not optimizing`);
          return null;

        case 'bgp': {
          const bgp = current as Algebra.Bgp;
          if (bgp.patterns.length !== 1) {
            this.log(`BGP has ${bgp.patterns.length} patterns, not optimizing`);
            return null;
          }
          
          const pattern = bgp.patterns[0];
          this.extractPattern(pattern, params);
          bgpFound = true;
          current = null as any;
          break;
        }

        case 'join':
        case 'leftjoin':
        case 'union':
        case 'minus':
          this.log(`Query has ${current.type}, not optimizing`);
          return null;

        case 'graph': {
          const graphOp = current as Algebra.Graph;
          if (graphOp.name.termType === 'Variable') {
            params.pattern.graphVar = graphOp.name.value;
          } else {
            params.pattern.graph = graphOp.name;
          }
          current = graphOp.input;
          break;
        }

        default:
          if ('input' in current) {
            current = (current as any).input;
          } else {
            current = null as any;
          }
      }
    }

    if (!bgpFound) {
      return null;
    }

    // 填充 variables（如果是 SELECT *）
    if (params.variables.length === 0) {
      if (params.pattern.subjectVar) params.variables.push(params.pattern.subjectVar);
      if (params.pattern.predicateVar) params.variables.push(params.pattern.predicateVar);
      if (params.pattern.objectVar) params.variables.push(params.pattern.objectVar);
      if (params.pattern.graphVar) params.variables.push(params.pattern.graphVar);
    }

    return params;
  }

  /**
   * 从 BGP pattern 提取匹配条件
   */
  private extractPattern(pattern: Algebra.Pattern, params: OptimizeParams): void {
    if (pattern.subject.termType === 'Variable') {
      params.pattern.subjectVar = pattern.subject.value;
    } else {
      params.pattern.subject = pattern.subject;
    }

    if (pattern.predicate.termType === 'Variable') {
      params.pattern.predicateVar = pattern.predicate.value;
    } else {
      params.pattern.predicate = pattern.predicate;
    }

    if (pattern.object.termType === 'Variable') {
      params.pattern.objectVar = pattern.object.value;
    } else {
      params.pattern.object = pattern.object;
    }

    if (pattern.graph.termType === 'Variable') {
      params.pattern.graphVar = pattern.graph.value;
    } else if (pattern.graph.termType === 'DefaultGraph') {
      // DefaultGraph - don't set graph filter
    } else {
      params.pattern.graph = pattern.graph;
    }
  }

  /**
   * 执行优化的 SELECT
   */
  private async executeOptimizedSelect(params: OptimizeParams): Promise<ResultStream<Bindings>> {
    const opts: GetOpts = {};

    if (params.limit !== undefined) {
      opts.limit = params.limit + (params.offset || 0);
    }

    if (params.order) {
      opts.order = params.order;
    }

    if (params.reverse) {
      opts.reverse = params.reverse;
    }

    const pattern: Pattern = {
      subject: params.pattern.subject as any,
      predicate: params.pattern.predicate as any,
      object: params.pattern.object as any,
      graph: params.pattern.graph as any,
    };

    this.log(`Querying quadstore with pattern: ${JSON.stringify(pattern)}, opts: ${JSON.stringify(opts)}`);

    const result = await this.quadstore.get(pattern, opts);
    let quads = result.items;

    if (params.offset) {
      quads = quads.slice(params.offset);
    }

    if (params.limit !== undefined) {
      quads = quads.slice(0, params.limit);
    }

    const bindings = quads.map(quad => {
      const binding = new SimpleBindings();
      
      if (params.pattern.subjectVar) {
        binding.set(params.pattern.subjectVar, quad.subject);
      }
      if (params.pattern.predicateVar) {
        binding.set(params.pattern.predicateVar, quad.predicate);
      }
      if (params.pattern.objectVar) {
        binding.set(params.pattern.objectVar, quad.object);
      }
      if (params.pattern.graphVar) {
        binding.set(params.pattern.graphVar, quad.graph);
      }

      return binding;
    });

    let finalBindings: SimpleBindings[] = bindings;
    if (params.distinct) {
      const seen = new Set<string>();
      finalBindings = bindings.filter(b => {
        const key = params.variables.map(v => `${v}=${b.get(v)?.value ?? ''}`).sort().join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    return new ArrayIterator(finalBindings) as unknown as ResultStream<Bindings>;
  }

  private varNameToTermName(varName: string): TermName | null {
    const mapping: Record<string, TermName> = {
      s: 'subject',
      subject: 'subject',
      p: 'predicate',
      predicate: 'predicate',
      o: 'object',
      object: 'object',
      g: 'graph',
      graph: 'graph',
    };
    return mapping[varName.toLowerCase()] || null;
  }

  private async streamToArray<T>(stream: any): Promise<T[]> {
    if (typeof stream.toArray === 'function') {
      return stream.toArray();
    }
    const results: T[] = [];
    return new Promise((resolve, reject) => {
      stream.on('data', (item: T) => results.push(item));
      stream.on('end', () => resolve(results));
      stream.on('error', reject);
    });
  }
}
