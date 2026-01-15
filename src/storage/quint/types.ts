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
 * 操作符值类型 - 可以是 Term、string 或 number
 * 存储层会自动处理序列化
 */
export type OperatorValue = Term | string | number;

/**
 * Term 操作符 - 用于灵活查询
 * 值可以是 Term、string 或 number，存储层自动处理序列化
 */
export interface TermOperators {
  $eq?: OperatorValue;
  $ne?: OperatorValue;
  $gt?: OperatorValue;
  $gte?: OperatorValue;
  $lt?: OperatorValue;
  $lte?: OperatorValue;
  $in?: OperatorValue[];
  $notIn?: OperatorValue[];
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
 * 复合查询模式 - 多个 pattern 通过 subject 关联
 * 用于多 pattern + FILTER 查询，由数据库内部做 JOIN
 */
export interface CompoundPattern {
  /** 多个 pattern，每个 pattern 对应一个三元组匹配 */
  patterns: QuintPattern[];
  /** JOIN 的字段，通常是 subject */
  joinOn: TermName;
  /** 返回哪些字段的值 */
  select?: {
    pattern: number;  // pattern 索引
    field: TermName;  // 要返回的字段
    alias: string;    // 别名
  }[];
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
 * 复合查询结果 - 包含多个 pattern 的绑定值
 */
export interface CompoundResult {
  /** JOIN 字段的值 */
  joinValue: string;
  /** 各 pattern 的匹配结果，key 是 alias */
  bindings: Record<string, string>;
  /** 原始 quad 数据（可选，用于获取完整信息） */
  quads?: Quint[];
}

/**
 * 批量属性查询结果
 * Map<subject, Map<predicate, object[]>>
 */
export type AttributeMap = Map<string, Map<string, Term[]>>;

/**
 * QuintStore - 五元组存储抽象基类
 */
export abstract class QuintStore {
  // 查询
  abstract get(pattern: QuintPattern, options?: QueryOptions): Promise<Quint[]>;
  abstract match(subject?: Term | null, predicate?: Term | null, object?: Term | null, graph?: Term | null): AsyncIterator<Quint>;
  abstract getByGraphPrefix(prefix: string, options?: QueryOptions): Promise<Quint[]>;
  abstract count(pattern: QuintPattern): Promise<number>;
  
  // 复合查询 - 多 pattern JOIN，由数据库内部执行
  getCompound?(compound: CompoundPattern, options?: QueryOptions): Promise<CompoundResult[]>;
  
  /**
   * 批量获取多个 subject 的多个属性
   * 
   * 用于优化 OPTIONAL 查询：先用 WHERE 条件获取 subjects，
   * 然后一次性获取所有属性，避免每个 OPTIONAL 变成一次 LEFT JOIN
   * 
   * SQL: SELECT subject, predicate, object FROM quints 
   *      WHERE subject IN (...) AND predicate IN (...)
   * 
   * @param subjects - 要查询的 subject IRIs
   * @param predicates - 要获取的属性 predicate IRIs
   * @param graph - 可选，限定图
   * @returns Map<subject, Map<predicate, object[]>>
   */
  getAttributes?(
    subjects: string[],
    predicates: string[],
    graph?: Term
  ): Promise<AttributeMap>;

  // 写入
  abstract put(quint: Quint): Promise<void>;
  abstract multiPut(quints: Quint[]): Promise<void>;
  abstract updateEmbedding(pattern: QuintPattern, embedding: number[]): Promise<number>;

  // 删除
  abstract del(pattern: QuintPattern): Promise<number>;
  abstract multiDel(quints: Quint[]): Promise<void>;

  // 生命周期
  abstract open(): Promise<void>;
  abstract close(): Promise<void>;
  abstract stats(): Promise<StoreStats>;
  abstract clear(): Promise<void>;
}
