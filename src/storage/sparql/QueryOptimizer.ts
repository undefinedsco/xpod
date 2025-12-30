/**
 * QueryOptimizer - 统一的查询优化层
 * 
 * 职责：
 * 1. 分析 SPARQL algebra，识别可优化的模式
 * 2. 选择最优执行策略
 * 3. 执行优化后的查询
 * 
 * 支持的优化：
 * - OPTIONAL 优化：批量获取属性，避免指数级 LEFT JOIN
 * - Compound Query：多 pattern SQL JOIN，避免 JS 层 hash join
 * - FILTER 下推：条件下推到 SQL 层
 * 
 * 设计原则：
 * - 所有优化逻辑集中在此类
 * - 对外暴露统一的接口
 * - 优化失败时优雅降级到 Comunica 默认行为
 */

import type { Bindings, Term, Variable } from '@rdfjs/types';
import type { Algebra } from 'sparqlalgebrajs';
import { DataFactory } from 'rdf-data-factory';

import type { QuintStore, AttributeMap } from '../quint/types';

const dataFactory = new DataFactory();

/**
 * OPTIONAL 优化分析结果
 */
export interface OptionalAnalysis {
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

/**
 * Compound Query 优化分析结果
 */
export interface CompoundAnalysis {
  /** 是否可优化 */
  canOptimize: boolean;
  /** 所有 patterns */
  patterns?: Algebra.Pattern[];
  /** JOIN 变量名 */
  joinVar?: string;
  /** JOIN 字段 */
  joinField?: 'subject' | 'predicate' | 'object' | 'graph';
  /** 不能优化的原因 */
  reason?: string;
}

/**
 * 查询优化结果
 */
export interface OptimizationResult {
  /** 优化类型 */
  type: 'optional' | 'compound' | 'none';
  /** 分析结果 */
  analysis: OptionalAnalysis | CompoundAnalysis | null;
}

export interface QueryOptimizerOptions {
  debug?: boolean;
  bindingsFactory: any;
}

/**
 * QueryOptimizer - 查询优化器
 */
export class QueryOptimizer {
  private readonly store: QuintStore;
  private readonly debug: boolean;
  private readonly bindingsFactory: any;

  constructor(store: QuintStore, options: QueryOptimizerOptions) {
    this.store = store;
    this.debug = options.debug ?? false;
    this.bindingsFactory = options.bindingsFactory;
  }

  // ============================================================
  // 公共接口
  // ============================================================

  /**
   * 分析查询，确定最佳优化策略
   */
  analyzeQuery(algebra: Algebra.Operation): OptimizationResult {
    // 先检查 OPTIONAL 优化（优先级最高）
    if (this.store.getAttributes) {
      const optionalAnalysis = this.analyzeOptional(algebra);
      if (optionalAnalysis.canOptimize) {
        return { type: 'optional', analysis: optionalAnalysis };
      }
    }

    // 检查 Compound Query 优化
    if (this.store.getCompound) {
      const compoundAnalysis = this.analyzeCompound(algebra);
      if (compoundAnalysis.canOptimize) {
        return { type: 'compound', analysis: compoundAnalysis };
      }
    }

    return { type: 'none', analysis: null };
  }

  /**
   * 执行 OPTIONAL 优化查询
   * 
   * @param analysis OPTIONAL 分析结果
   * @param coreBindings 核心查询的绑定结果
   * @param orderOptions 排序选项（可选）
   */
  async executeOptionalOptimized(
    analysis: OptionalAnalysis,
    coreBindings: Bindings[],
    orderOptions?: { varName: string; reverse?: boolean }
  ): Promise<Bindings[]> {
    const { subjectVar, optionalPredicates, optionalVars } = analysis;
    
    if (!subjectVar || !optionalPredicates || !optionalVars) {
      throw new Error('Invalid OptionalAnalysis');
    }

    if (coreBindings.length === 0) {
      return [];
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
      console.log(`[QueryOptimizer] OPTIONAL: ${coreBindings.length} bindings, ${subjects.length} subjects`);
    }

    // 批量获取属性
    const attributeMap = await this.store.getAttributes!(
      subjects,
      optionalPredicates,
      undefined  // TODO: 支持 graph 过滤
    );

    if (this.debug) {
      console.log(`[QueryOptimizer] getAttributes returned data for ${attributeMap.size} subjects`);
    }

    // 组装结果
    let results = this.assembleOptionalResults(coreBindings, attributeMap, subjectVar, optionalVars);

    // 应用排序
    if (orderOptions?.varName && results.length > 1) {
      results = this.sortBindings(results, orderOptions.varName, orderOptions.reverse ?? false);
      if (this.debug) {
        console.log(`[QueryOptimizer] Applied ORDER BY ?${orderOptions.varName} ${orderOptions.reverse ? 'DESC' : 'ASC'}`);
      }
    }

    return results;
  }

  /**
   * 对 Bindings 数组按指定变量排序
   */
  private sortBindings(bindings: Bindings[], varName: string, reverse: boolean): Bindings[] {
    const orderVar = dataFactory.variable(varName);
    
    return [...bindings].sort((a, b) => {
      const aVal = a.get(orderVar);
      const bVal = b.get(orderVar);
      
      // null/undefined 值排在最后
      if (!aVal && !bVal) return 0;
      if (!aVal) return 1;
      if (!bVal) return -1;
      
      // 比较值
      let cmp: number;
      if (aVal.termType === 'Literal' && bVal.termType === 'Literal') {
        // 对于字面量，先尝试数值比较
        const aNum = parseFloat(aVal.value);
        const bNum = parseFloat(bVal.value);
        if (!isNaN(aNum) && !isNaN(bNum)) {
          cmp = aNum - bNum;
        } else {
          // 字符串比较
          cmp = aVal.value.localeCompare(bVal.value);
        }
      } else {
        // 其他类型用字符串比较
        cmp = aVal.value.localeCompare(bVal.value);
      }
      
      return reverse ? -cmp : cmp;
    });
  }

  // ============================================================
  // OPTIONAL 优化
  // ============================================================

  /**
   * 分析查询是否可以进行 OPTIONAL 优化
   * 
   * 可优化条件：
   * 1. 有核心条件（BGP 或带 FILTER 的 BGP）
   * 2. 有 OPTIONAL（>= 1 个）
   * 3. 所有 OPTIONAL 都是简单的属性获取：?s <pred> ?var
   * 4. 所有 OPTIONAL 使用同一个 subject 变量
   * 5. OPTIONAL 内部没有额外的 FILTER
   */
  analyzeOptional(algebra: Algebra.Operation): OptionalAnalysis {
    // 从 project -> slice -> orderby -> ... 找到实际的查询结构
    let current = algebra;
    while (current.type === 'project' || current.type === 'slice' || 
           current.type === 'distinct' || current.type === 'reduced' ||
           current.type === 'orderby') {
      current = (current as any).input;
    }

    // 收集所有 leftjoin（OPTIONAL）和核心操作
    const leftJoins: Algebra.LeftJoin[] = [];
    let coreOp: Algebra.Operation | null = null;

    const collectLeftJoins = (op: Algebra.Operation): void => {
      if (op.type === 'leftjoin') {
        const lj = op as Algebra.LeftJoin;
        leftJoins.push(lj);
        collectLeftJoins(lj.input[0]);
      } else {
        coreOp = op;
      }
    };

    collectLeftJoins(current);

    if (leftJoins.length < 1) {
      return { canOptimize: false, reason: 'No OPTIONAL found' };
    }

    if (!coreOp) {
      return { canOptimize: false, reason: 'No core operation found' };
    }

    // 分析核心操作获取 subject 变量
    const subjectVar = this.extractSubjectVariable(coreOp);
    if (!subjectVar) {
      return { canOptimize: false, reason: 'Cannot determine subject variable from core operation' };
    }

    // 分析所有 OPTIONAL
    const optionalPredicates: string[] = [];
    const optionalVars = new Map<string, string>();

    for (const lj of leftJoins) {
      // 检查是否有额外的 filter
      if ((lj as any).expression) {
        return { canOptimize: false, reason: 'OPTIONAL contains FILTER expression' };
      }

      const patternInfo = this.extractSimplePattern(lj.input[1]);
      if (!patternInfo) {
        return { canOptimize: false, reason: 'OPTIONAL is not a simple pattern' };
      }

      if (patternInfo.subjectVar !== subjectVar) {
        return { 
          canOptimize: false, 
          reason: `OPTIONAL subject ?${patternInfo.subjectVar} doesn't match core subject ?${subjectVar}` 
        };
      }

      if (!patternInfo.predicate) {
        return { canOptimize: false, reason: 'OPTIONAL predicate must be a constant' };
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

  // ============================================================
  // Compound Query 优化
  // ============================================================

  /**
   * 分析查询是否可以进行 Compound Query 优化
   */
  analyzeCompound(algebra: Algebra.Operation): CompoundAnalysis {
    // 从 project -> slice -> ... 找到实际的查询结构
    let current = algebra;
    while (current.type === 'project' || current.type === 'slice' || 
           current.type === 'distinct' || current.type === 'reduced' ||
           current.type === 'filter') {
      current = (current as any).input;
    }

    // 检查是否是 BGP 或 JOIN
    let patterns: Algebra.Pattern[] = [];

    if (current.type === 'bgp') {
      const bgp = current as Algebra.Bgp;
      patterns = bgp.patterns as Algebra.Pattern[];
    } else if (current.type === 'join') {
      const join = current as Algebra.Join;
      patterns = this.extractPatternsFromJoin(join);
    }

    if (patterns.length < 2) {
      return { canOptimize: false, reason: 'Need at least 2 patterns for compound query' };
    }

    // 检查所有 pattern 是否共享同一个 subject 变量
    const subjectVars = patterns.map(p => 
      p.subject?.termType === 'Variable' ? p.subject.value : null
    );
    const uniqueSubjectVars = [...new Set(subjectVars.filter(v => v !== null))];

    if (uniqueSubjectVars.length !== 1) {
      return { canOptimize: false, reason: 'Patterns do not share the same subject variable' };
    }

    return {
      canOptimize: true,
      patterns,
      joinVar: uniqueSubjectVars[0]!,
      joinField: 'subject',
    };
  }

  // ============================================================
  // 辅助方法
  // ============================================================

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
      return this.extractSubjectVariable((op as Algebra.Filter).input);
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
   * 从 JOIN 操作提取所有 patterns
   */
  private extractPatternsFromJoin(join: Algebra.Join): Algebra.Pattern[] {
    const patterns: Algebra.Pattern[] = [];
    
    for (const input of join.input) {
      if (input.type === 'pattern') {
        patterns.push(input as Algebra.Pattern);
      } else if (input.type === 'bgp') {
        patterns.push(...(input as Algebra.Bgp).patterns as Algebra.Pattern[]);
      } else if (input.type === 'join') {
        patterns.push(...this.extractPatternsFromJoin(input as Algebra.Join));
      }
    }

    return patterns;
  }

  /**
   * 组装 OPTIONAL 优化结果
   */
  private assembleOptionalResults(
    coreBindings: Bindings[],
    attributeMap: AttributeMap,
    subjectVar: string,
    optionalVars: Map<string, string>
  ): Bindings[] {
    const results: Bindings[] = [];
    
    for (const coreBinding of coreBindings) {
      const subjectTerm = coreBinding.get(dataFactory.variable(subjectVar));
      if (!subjectTerm || subjectTerm.termType !== 'NamedNode') {
        results.push(coreBinding);
        continue;
      }

      const subjectAttrs = attributeMap.get(subjectTerm.value);
      
      // 创建包含所有 OPTIONAL 变量的新 binding
      const entries: [Variable, Term][] = [];
      
      // 复制核心 binding 的所有变量
      for (const v of coreBinding.keys()) {
        const term = coreBinding.get(v);
        if (term) {
          entries.push([v as Variable, term]);
        }
      }

      // 添加 OPTIONAL 变量
      for (const [predicate, varName] of optionalVars) {
        const values = subjectAttrs?.get(predicate);
        if (values && values.length > 0) {
          entries.push([dataFactory.variable(varName), values[0]]);
        }
      }

      results.push(this.bindingsFactory.bindings(entries));
    }

    return results;
  }
}
