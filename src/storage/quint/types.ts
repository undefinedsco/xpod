/**
 * QuintStore - 五元组存储类型定义
 * 
 * Quint = (G)raph, (S)ubject, (P)redicate, (O)bject, (V)ector
 * 
 * 核心能力：
 * - RDF 四元组存储与查询
 * - 通用操作符查询（$startsWith, $contains 等）
 * - 向量嵌入存储（搜索后续再做）
 */

import type { Term, Quad } from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';

/**
 * 五元组 - 扩展 RDF Quad，增加向量
 */
export interface Quint extends Quad {
  vector?: number[];
}

/**
 * Term 名称类型
 */
export type TermName = 'subject' | 'predicate' | 'object' | 'graph';

/**
 * Term 操作符 - 用于灵活查询
 */
export interface TermOperators {
  $eq?: string;
  $ne?: string;
  $gt?: string;
  $gte?: string;
  $lt?: string;
  $lte?: string;
  $in?: string[];
  $notIn?: string[];
  $startsWith?: string;
  $endsWith?: string;
  $contains?: string;
  $regex?: string;
  $isNull?: boolean;
}

/**
 * Term 匹配 - Term 精确匹配或操作符匹配
 */
export type TermMatch = Term | TermOperators;

/**
 * 判断是否为 Term（而非操作符）
 */
export function isTerm(value: TermMatch): value is Term {
  return value !== null && typeof value === 'object' && 'termType' in value;
}

/**
 * 查询模式
 */
export interface QuintPattern {
  subject?: TermMatch;
  predicate?: TermMatch;
  object?: TermMatch;
  graph?: TermMatch;
}

/**
 * 查询选项
 */
export interface QueryOptions {
  limit?: number;
  offset?: number;
  order?: TermName[];
  reverse?: boolean;
}

/**
 * 存储统计信息
 */
export interface StoreStats {
  totalCount: number;
  vectorCount: number;
  graphCount: number;
}

/**
 * QuintStore 配置选项
 */
export interface QuintStoreOptions {
  debug?: boolean;
}

/**
 * QuintStore - 五元组存储接口
 */
export interface QuintStore {
  // 查询
  get(pattern: QuintPattern, options?: QueryOptions): Promise<Quint[]>;
  match(subject?: Term | null, predicate?: Term | null, object?: Term | null, graph?: Term | null): AsyncIterator<Quint>;
  getByGraphPrefix(prefix: string, options?: QueryOptions): Promise<Quint[]>;
  count(pattern: QuintPattern): Promise<number>;

  // 写入
  put(quint: Quint): Promise<void>;
  multiPut(quints: Quint[]): Promise<void>;
  updateEmbedding(pattern: QuintPattern, embedding: number[]): Promise<number>;

  // 删除
  del(pattern: QuintPattern): Promise<number>;
  multiDel(quints: Quint[]): Promise<void>;

  // 生命周期
  open(): Promise<void>;
  close(): Promise<void>;
  stats(): Promise<StoreStats>;
  clear(): Promise<void>;
}
