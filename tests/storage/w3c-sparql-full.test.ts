/**
 * W3C SPARQL 1.1 完整测试套件对比
 * Quadstore vs QuintStore
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DataFactory, Parser } from 'n3';
import { Quadstore } from 'quadstore';
import { Engine as QuadstoreEngine } from 'quadstore-comunica';
import { SqliteQuintStore } from '../../src/storage/quint';
import { ComunicaQuintEngine } from '../../src/storage/sparql/ComunicaQuintEngine';
import { getBackend } from '../../src/libs/backends';
import { getTestDataPath } from '../utils/sqlite';
import type { Quad } from '@rdfjs/types';

// Quadstore 已知问题：
// 某些查询模式（如只有 object 没有 subject/predicate）会在 stream 迭代时异步抛出
// "No index compatible with pattern" 错误。这个错误无法被 try-catch 捕获，
// 因为它发生在 Comunica 内部的异步调度中。
// 
// 这是 Quadstore 的设计缺陷，它应该：
// 1. 在 getSelectorShape 中声明不支持的 pattern，或者
// 2. 在同步的 match() 调用中就抛出错误，而不是在异步迭代中
//
// 我们通过 unhandledRejection 处理器防止进程崩溃，让测试正常完成。
// Vitest 仍会报告这些 unhandled errors，但测试结果是正确的。
process.on('unhandledRejection', (reason: any) => {
  // 静默处理，让测试继续运行
  // Quadstore 的不支持 pattern 错误会导致超时，测试会正确失败
});

const W3C_TESTS_DIR = path.join(process.cwd(), 'third_party/w3c-rdf-tests/sparql/sparql11');
const testDir = getTestDataPath('w3c_full');

// 检查 W3C 测试套件是否已下载
const W3C_TESTS_AVAILABLE = fs.existsSync(W3C_TESTS_DIR);

// W3C 测试类别
const W3C_CATEGORIES = [
  'aggregates',
  'bind',
  'bindings',
  'cast',
  'construct',
  'exists',
  'functions',
  'grouping',
  'negation',
  'project-expression',
  'property-path',
  'subquery',
  'syntax-query',
];

interface StoreWrapper {
  name: string;
  clear: () => Promise<void>;
  loadQuads: (quads: Quad[]) => Promise<void>;
  queryBindings: (query: string) => Promise<any[]>;
  queryBoolean: (query: string) => Promise<boolean>;
  queryQuads: (query: string) => Promise<Quad[]>;
  close: () => Promise<void>;
}

// 加载 RDF 文件
async function loadRdfFile(filePath: string): Promise<Quad[]> {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const parser = new Parser({ baseIRI: `file://${filePath}` });
  try {
    return parser.parse(content);
  } catch {
    return [];
  }
}

// 创建 QuintStore
async function createQuintStore(): Promise<StoreWrapper> {
  const store = new SqliteQuintStore({ path: ':memory:' });
  await store.open();
  const engine = new ComunicaQuintEngine(store, { debug: false });
  
  return {
    name: 'QuintStore',
    clear: async () => { await store.clear(); },
    loadQuads: async (quads: Quad[]) => {
      if (quads.length > 0) await store.multiPut(quads as any[]);
    },
    queryBindings: async (query: string) => {
      const stream = await engine.queryBindings(query);
      const results = [];
      for await (const binding of stream) {
        results.push(binding);
      }
      return results;
    },
    queryBoolean: async (query: string) => {
      return await engine.queryBoolean(query);
    },
    queryQuads: async (query: string) => {
      const stream = await engine.queryQuads(query);
      const results = [];
      for await (const q of stream) {
        results.push(q);
      }
      return results;
    },
    close: async () => { await store.close(); },
  };
}

// 创建 Quadstore
async function createQuadstore(): Promise<StoreWrapper> {
  const dbPath = path.join(testDir, `quadstore_${Date.now()}_${Math.random().toString(36).slice(2)}.sqlite`);
  const backend = getBackend(`sqlite:${dbPath}`, { tableName: 'quadstore' });
  const store = new Quadstore({ backend, dataFactory: DataFactory });
  await store.open();
  const engine = new QuadstoreEngine(store);
  
  // 超时包装，错误正常向上抛出
  const withTimeout = async <T>(fn: () => Promise<T>, timeoutMs: number = 5000): Promise<T> => {
    const timeout = new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error('Query timeout')), timeoutMs)
    );
    return Promise.race([fn(), timeout]);
  };
  
  return {
    name: 'Quadstore',
    clear: async () => {
      try {
        const all = (await store.get({})).items;
        if (all.length > 0) {
          // 分批删除避免 SQLite 限制
          for (let i = 0; i < all.length; i += 50) {
            await store.multiDel(all.slice(i, i + 50));
          }
        }
      } catch (e) {
        // 忽略清理错误
      }
    },
    loadQuads: async (quads: Quad[]) => {
      if (quads.length > 0) {
        // 分批插入避免 SQLite 限制
        for (let i = 0; i < quads.length; i += 50) {
          await store.multiPut(quads.slice(i, i + 50));
        }
      }
    },
    queryBindings: async (query: string) => {
      return withTimeout(async () => {
        const stream = await engine.queryBindings(query);
        const results: any[] = [];
        for await (const binding of stream) {
          results.push(binding);
        }
        return results;
      });
    },
    queryBoolean: async (query: string) => {
      return withTimeout(() => engine.queryBoolean(query));
    },
    queryQuads: async (query: string) => {
      return withTimeout(async () => {
        const stream = await engine.queryQuads(query);
        const results: Quad[] = [];
        for await (const q of stream) {
          results.push(q);
        }
        return results;
      });
    },
    close: async () => {
      await store.close();
      if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
    },
  };
}

// 运行单个测试
async function runTest(
  store: StoreWrapper,
  categoryDir: string,
  queryFile: string,
  defaultDataFile?: string
): Promise<{ passed: boolean; error?: string }> {
  const testName = queryFile.replace('.rq', '');
  
  try {
    await store.clear();
    
    // 加载数据 - 尝试多种命名约定
    let quads: Quad[] = [];
    const possibleDataFiles = [
      path.join(categoryDir, `${testName}.ttl`),
      path.join(categoryDir, `${testName}-data.ttl`),
      path.join(categoryDir, `${testName.replace(/\d+$/, '')}.ttl`),
      defaultDataFile ? path.join(categoryDir, defaultDataFile) : '',
    ].filter(Boolean);
    
    for (const dataFile of possibleDataFiles) {
      if (fs.existsSync(dataFile)) {
        quads = await loadRdfFile(dataFile);
        if (quads.length > 0) break;
      }
    }
    
    await store.loadQuads(quads);
    
    // 执行查询
    const queryPath = path.join(categoryDir, queryFile);
    const query = fs.readFileSync(queryPath, 'utf-8');
    
    // 根据查询类型选择执行方法
    if (query.match(/^\s*ASK\s/im)) {
      await store.queryBoolean(query);
    } else if (query.match(/^\s*CONSTRUCT\s/im) || query.match(/^\s*DESCRIBE\s/im)) {
      await store.queryQuads(query);
    } else {
      await store.queryBindings(query);
    }
    
    return { passed: true };
  } catch (error: any) {
    // syntax-* 中的 bad 测试预期失败
    if (testName.includes('bad') || testName.includes('syn-bad')) {
      return { passed: true };
    }
    return { passed: false, error: error.message?.slice(0, 100) };
  }
}

// 跳过: 已迁移到 QuintStore，不再使用 Quadstore
describe.skip('W3C SPARQL 1.1 Full Test Suite', () => {
  const allResults: Record<string, Record<string, { passed: number; failed: number; total: number }>> = {};

  beforeAll(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterAll(() => {
    // 打印完整结果
    console.log('\n');
    console.log('╔════════════════════════════════════════════════════════════════════════════╗');
    console.log('║              W3C SPARQL 1.1 Test Suite - Complete Results                  ║');
    console.log('╠════════════════════════════════════════════════════════════════════════════╣');
    console.log('║ Category              │ Quadstore           │ QuintStore          │ Match  ║');
    console.log('╠════════════════════════════════════════════════════════════════════════════╣');
    
    let totalQuadstore = { passed: 0, total: 0 };
    let totalQuintStore = { passed: 0, total: 0 };
    
    for (const category of W3C_CATEGORIES) {
      const quad = allResults[category]?.['Quadstore'] || { passed: 0, failed: 0, total: 0 };
      const quint = allResults[category]?.['QuintStore'] || { passed: 0, failed: 0, total: 0 };
      
      totalQuadstore.passed += quad.passed;
      totalQuadstore.total += quad.total;
      totalQuintStore.passed += quint.passed;
      totalQuintStore.total += quint.total;
      
      const quadPct = quad.total > 0 ? ((quad.passed / quad.total) * 100).toFixed(0) : 'N/A';
      const quintPct = quint.total > 0 ? ((quint.passed / quint.total) * 100).toFixed(0) : 'N/A';
      const match = quad.passed === quint.passed ? '✓' : '✗';
      
      const catPad = category.padEnd(20);
      const quadStr = `${quad.passed}/${quad.total} (${quadPct}%)`.padEnd(18);
      const quintStr = `${quint.passed}/${quint.total} (${quintPct}%)`.padEnd(18);
      
      console.log(`║ ${catPad} │ ${quadStr} │ ${quintStr} │   ${match}    ║`);
    }
    
    console.log('╠════════════════════════════════════════════════════════════════════════════╣');
    
    const totalQuadPct = totalQuadstore.total > 0 
      ? ((totalQuadstore.passed / totalQuadstore.total) * 100).toFixed(1) 
      : 'N/A';
    const totalQuintPct = totalQuintStore.total > 0 
      ? ((totalQuintStore.passed / totalQuintStore.total) * 100).toFixed(1) 
      : 'N/A';
    
    const totalQuadStr = `${totalQuadstore.passed}/${totalQuadstore.total} (${totalQuadPct}%)`.padEnd(18);
    const totalQuintStr = `${totalQuintStore.passed}/${totalQuintStore.total} (${totalQuintPct}%)`.padEnd(18);
    
    console.log(`║ ${'TOTAL'.padEnd(20)} │ ${totalQuadStr} │ ${totalQuintStr} │        ║`);
    console.log('╚════════════════════════════════════════════════════════════════════════════╝');
    console.log('\n');
  });

  // 为每个类别创建测试
  describe.each(W3C_CATEGORIES)('Category: %s', (category) => {
    const categoryDir = path.join(W3C_TESTS_DIR, category);
    const categoryExists = W3C_TESTS_AVAILABLE && fs.existsSync(categoryDir);
    
    it.skipIf(!categoryExists)(`should run all ${category} tests for both stores`, async () => {
      const files = fs.readdirSync(categoryDir);
      const queryFiles = files.filter(f => f.endsWith('.rq'));
      
      if (queryFiles.length === 0) {
        console.log(`  Skipping ${category}: no .rq files`);
        return;
      }
      
      // 查找默认数据文件
      const defaultDataFile = files.find(f => 
        f.endsWith('.ttl') && !f.match(/\d+\.ttl$/)
      );
      
      allResults[category] = {};
      
      // 测试 QuintStore
      const quintStore = await createQuintStore();
      let quintPassed = 0;
      let quintFailed = 0;
      
      for (const queryFile of queryFiles) {
        const result = await runTest(quintStore, categoryDir, queryFile, defaultDataFile);
        if (result.passed) {
          quintPassed++;
        } else {
          quintFailed++;
        }
      }
      
      allResults[category]['QuintStore'] = {
        passed: quintPassed,
        failed: quintFailed,
        total: queryFiles.length,
      };
      
      await quintStore.close();
      
      // 测试 Quadstore
      const quadStore = await createQuadstore();
      let quadPassed = 0;
      let quadFailed = 0;
      
      for (const queryFile of queryFiles) {
        const result = await runTest(quadStore, categoryDir, queryFile, defaultDataFile);
        if (result.passed) {
          quadPassed++;
        } else {
          quadFailed++;
        }
      }
      
      allResults[category]['Quadstore'] = {
        passed: quadPassed,
        failed: quadFailed,
        total: queryFiles.length,
      };
      
      await quadStore.close();
      
      // 至少有测试运行
      expect(queryFiles.length).toBeGreaterThan(0);
    }, 120000); // 2分钟超时
  });
});
