/**
 * OptimizedQuadstoreSource - 实现 Comunica IQuadSource 接口的优化 quadstore 源
 * 
 * 这个实现允许在 match() 调用时从 context 读取优化参数（LIMIT、ORDER BY），
 * 并直接传递给 quadstore.get() API，实现查询下推优化。
 */

import type { Quad, Term, Quad_Subject, Quad_Predicate, Quad_Object, Quad_Graph } from '@rdfjs/types';
import type { IActionContext, IActionContextKey } from '@comunica/types';
import { ActionContextKey } from '@comunica/core';
import { ArrayIterator } from 'asynciterator';
import type { AsyncIterator } from 'asynciterator';
import { Quadstore, type GetOpts, type TermName, type Pattern } from 'quadstore';
import { MetadataValidationState } from '@comunica/utils-metadata';

// Context key for optimization parameters
export const KEY_OPTIMIZE_PARAMS: IActionContextKey<OptimizeParams> = 
  new ActionContextKey('@xpod/optimizeParams');

export interface OptimizeParams {
  limit?: number;
  order?: TermName[];
  reverse?: boolean;
}

/**
 * 从 context 中提取优化参数
 */
export function getOptimizeParams(context?: IActionContext): OptimizeParams | undefined {
  if (!context) return undefined;
  return context.get(KEY_OPTIMIZE_PARAMS);
}

/**
 * 将优化参数设置到 context 中
 */
export function setOptimizeParams(context: IActionContext, params: OptimizeParams): IActionContext {
  return context.set(KEY_OPTIMIZE_PARAMS, params);
}

/**
 * 实现 Comunica IQuadSource 接口的优化 quadstore 源
 */
export class OptimizedQuadstoreSource {
  private readonly store: Quadstore;
  private readonly debug: boolean;

  constructor(store: Quadstore, options?: { debug?: boolean }) {
    this.store = store;
    this.debug = options?.debug ?? false;
  }

  /**
   * 实现 IQuadSource.match() - 带 context 支持的查询
   */
  match(
    subject: Term,
    predicate: Term,
    object: Term,
    graph: Term,
    context?: IActionContext
  ): AsyncIterator<Quad> {
    // 构建 quadstore pattern
    const pattern: Pattern = {};
    if (subject && subject.termType !== 'Variable') {
      pattern.subject = subject as Quad_Subject;
    }
    if (predicate && predicate.termType !== 'Variable') {
      pattern.predicate = predicate as Quad_Predicate;
    }
    if (object && object.termType !== 'Variable') {
      pattern.object = object as Quad_Object;
    }
    if (graph && graph.termType !== 'Variable') {
      pattern.graph = graph as Quad_Graph;
    }

    // 从 context 读取优化参数
    const optimizeParams = getOptimizeParams(context);
    const opts: GetOpts = {};
    
    if (optimizeParams) {
      if (optimizeParams.limit !== undefined) {
        opts.limit = optimizeParams.limit;
      }
      if (optimizeParams.order !== undefined) {
        opts.order = optimizeParams.order;
      }
      if (optimizeParams.reverse !== undefined) {
        opts.reverse = optimizeParams.reverse;
      }
    }

    if (this.debug) {
      console.log(`[OptimizedQuadstoreSource] match() called`);
      console.log(`  pattern: ${JSON.stringify(pattern)}`);
      console.log(`  opts: ${JSON.stringify(opts)}`);
    }

    // 调用 quadstore.get() 并返回 AsyncIterator
    return this.createIterator(pattern, opts);
  }

  /**
   * 创建带 metadata 的 AsyncIterator
   */
  private createIterator(pattern: Pattern, opts: GetOpts): AsyncIterator<Quad> {
    // 创建一个空的 ArrayIterator，然后异步填充
    const iterator = new ArrayIterator<Quad>([], { autoStart: false });
    
    // 异步加载数据
    this.loadData(iterator, pattern, opts);
    
    return iterator;
  }

  /**
   * 异步加载数据到 iterator
   */
  private async loadData(
    iterator: ArrayIterator<Quad>,
    pattern: Pattern,
    opts: GetOpts
  ): Promise<void> {
    try {
      // 获取数据
      const result = await this.store.get(pattern, opts);
      
      // 设置 metadata
      iterator.setProperty('metadata', {
        state: new MetadataValidationState(),
        cardinality: { type: 'exact', value: result.items.length },
        canContainUndefs: false,
      });
      
      // 填充数据 - 使用 append 方法
      if (result.items.length > 0) {
        // ArrayIterator 在创建后可以追加数据
        for (const item of result.items) {
          (iterator as any)._push(item);
        }
      }
      
      // 关闭 iterator
      iterator.close();
    } catch (error) {
      iterator.destroy(error as Error);
    }
  }
}
