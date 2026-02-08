/**
 * SimpleSparqlExecutor - 绕过 Comunica 执行简单 SPARQL UPDATE
 * 
 * 针对 Pod 创建场景优化：
 * - 直接解析 INSERT DATA / DELETE DATA
 * - 不经过 Comunica 的复杂查询计划
 * - 批量执行，减少事务开销
 */

import type { Quad } from '@rdfjs/types';
import type { QuintStore } from '../quint/types';

interface InsertDataPattern {
  type: 'insert';
  quads: Quad[];
}

interface DeleteDataPattern {
  type: 'delete';
  quads: Quad[];
}

type SparqlPattern = InsertDataPattern | DeleteDataPattern | null;

/**
 * 简单的 SPARQL UPDATE 解析器
 * 只处理 INSERT DATA / DELETE DATA 的简单形式
 */
export class SimpleSparqlExecutor {
  constructor(private readonly store: QuintStore) {}

  /**
   * 尝试执行简单的 SPARQL UPDATE
   * @returns true 如果成功执行，false 如果不支持该查询格式
   */
  async tryExecute(query: string): Promise<boolean> {
    const pattern = this.parseSimpleUpdate(query);
    if (!pattern) {
      return false; // 不支持，让调用方使用 Comunica
    }

    if (pattern.type === 'insert') {
      await this.store.multiPut(pattern.quads);
    } else {
      // 逐条删除（因为 QuintStore 没有 multiDel 方法）
      for (const q of pattern.quads) {
        await this.store.del({
          graph: q.graph,
          subject: q.subject,
          predicate: q.predicate,
          object: q.object,
        });
      }
    }
    return true;
  }

  /**
   * 解析简单的 SPARQL UPDATE
   * 支持的格式：
   * - INSERT DATA { GRAPH <uri> { ... } }
   * - DELETE DATA { GRAPH <uri> { ... } }
   * - INSERT DATA { ... }
   * - DELETE DATA { ... }
   */
  private parseSimpleUpdate(query: string): SparqlPattern {
    const trimmed = query.trim();
    
    // 检查是否是 INSERT DATA
    const insertMatch = trimmed.match(/^INSERT\s+DATA\s*\{/i);
    if (insertMatch) {
      const quads = this.parseQuadsFromBlock(trimmed, 'INSERT DATA');
      if (quads) {
        return { type: 'insert', quads };
      }
    }
    
    // 检查是否是 DELETE DATA
    const deleteMatch = trimmed.match(/^DELETE\s+DATA\s*\{/i);
    if (deleteMatch) {
      const quads = this.parseQuadsFromBlock(trimmed, 'DELETE DATA');
      if (quads) {
        return { type: 'delete', quads };
      }
    }
    
    return null; // 不支持
  }

  /**
   * 从代码块解析三元组
   * 简单实现，只处理基本格式
   */
  private parseQuadsFromBlock(query: string, prefix: string): Quad[] | null {
    // 提取大括号内的内容
    const blockStart = query.indexOf('{');
    const blockEnd = query.lastIndexOf('}');
    if (blockStart === -1 || blockEnd === -1 || blockEnd <= blockStart) {
      return null;
    }
    
    let content = query.slice(blockStart + 1, blockEnd).trim();
    
    // 检查是否有 GRAPH 块
    const graphMatch = content.match(/GRAPH\s*<([^>]+)>\s*\{/);
    if (graphMatch) {
      const graphUri = graphMatch[1];
      const graphBlockStart = content.indexOf('{', content.indexOf('GRAPH'));
      const graphBlockEnd = content.indexOf('}', graphBlockStart);
      if (graphBlockStart === -1 || graphBlockEnd === -1) {
        return null;
      }
      content = content.slice(graphBlockStart + 1, graphBlockEnd).trim();
      
      // 解析三元组并添加 graph
      const triples = this.parseTriples(content);
      if (!triples) return null;
      
      const { DataFactory } = require('n3');
      const { namedNode } = DataFactory;
      return triples.map(t => ({
        ...t,
        graph: namedNode(graphUri),
      }));
    }
    
    // 没有 GRAPH，使用默认图
    return this.parseTriples(content);
  }

  /**
   * 解析 Turtle 格式的三元组（简化版）
   */
  private parseTriples(content: string): Quad[] | null {
    // 简化实现：使用 N3 Parser
    try {
      const { Parser, DataFactory } = require('n3');
      const { defaultGraph } = DataFactory;
      
      const parser = new Parser();
      const quads = parser.parse(content);
      
      // 为没有 graph 的 quad 添加默认图
      return quads.map((q: Quad) => ({
        ...q,
        graph: q.graph || defaultGraph(),
      }));
    } catch (error) {
      return null;
    }
  }
}
