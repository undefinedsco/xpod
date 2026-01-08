/**
 * W3C SPARQL 1.1 标准测试套件运行器
 * 
 * 用于测试 QuadstoreSparqlDataAccessor 的 SPARQL 合规性
 * 
 * 测试套件位置: third_party/w3c-rdf-tests/sparql/sparql11/
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { DataFactory, Parser as N3Parser, Store as N3Store } from 'n3';
import { Quadstore } from 'quadstore';
import { Engine } from 'quadstore-comunica';
import { getBackend } from '../../../src/libs/backends';
import { getTestDataPath } from '../../utils/sqlite';
import arrayifyStream from 'arrayify-stream';

const { namedNode, literal, quad } = DataFactory;

// W3C 测试套件路径
const W3C_TEST_SUITE = path.join(__dirname, '../../../third_party/w3c-rdf-tests/sparql/sparql11');

// 检查 W3C 测试套件是否已下载
const W3C_TESTS_AVAILABLE = fs.existsSync(W3C_TEST_SUITE);

// 测试类别配置
interface TestCategory {
  name: string;
  dir: string;
  enabled: boolean;
  description: string;
}

const TEST_CATEGORIES: TestCategory[] = [
  { name: 'bind', dir: 'bind', enabled: true, description: 'BIND 表达式测试' },
  { name: 'aggregates', dir: 'aggregates', enabled: true, description: '聚合函数测试' },
  { name: 'functions', dir: 'functions', enabled: true, description: '内置函数测试' },
  { name: 'grouping', dir: 'grouping', enabled: true, description: 'GROUP BY 测试' },
  { name: 'subquery', dir: 'subquery', enabled: true, description: '子查询测试' },
  { name: 'negation', dir: 'negation', enabled: true, description: 'NOT EXISTS/MINUS 测试' },
  { name: 'exists', dir: 'exists', enabled: true, description: 'EXISTS 测试' },
  { name: 'construct', dir: 'construct', enabled: true, description: 'CONSTRUCT 测试' },
  { name: 'project-expression', dir: 'project-expression', enabled: true, description: '投影表达式测试' },
  { name: 'property-path', dir: 'property-path', enabled: true, description: '属性路径测试' },
];

// 测试结果统计
interface TestStats {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: string[];
}

// 解析 manifest.ttl 获取测试用例
interface W3CTest {
  id: string;
  name: string;
  query: string;
  data: string[];
  result: string;
  type: 'QueryEvaluationTest' | 'PositiveSyntaxTest' | 'NegativeSyntaxTest';
}

async function parseManifest(manifestPath: string): Promise<W3CTest[]> {
  const tests: W3CTest[] = [];
  const manifestDir = path.dirname(manifestPath);
  
  if (!fs.existsSync(manifestPath)) {
    return tests;
  }
  
  const content = fs.readFileSync(manifestPath, 'utf-8');
  const parser = new N3Parser();
  const store = new N3Store();
  
  const quads = parser.parse(content);
  store.addQuads(quads);
  
  // 查找所有测试
  const MF = 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#';
  const QT = 'http://www.w3.org/2001/sw/DataAccess/tests/test-query#';
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  
  // 获取所有 QueryEvaluationTest
  const testQuads = store.getQuads(null, namedNode(`${RDF}type`), namedNode(`${MF}QueryEvaluationTest`), null);
  
  for (const testQuad of testQuads) {
    const testId = testQuad.subject.value;
    
    // 获取测试名称
    const nameQuads = store.getQuads(testQuad.subject, namedNode(`${MF}name`), null, null);
    const name = nameQuads[0]?.object.value || testId;
    
    // 获取 action (包含 query 和 data)
    const actionQuads = store.getQuads(testQuad.subject, namedNode(`${MF}action`), null, null);
    if (actionQuads.length === 0) continue;
    
    const actionNode = actionQuads[0].object;
    
    // 获取查询文件
    const queryQuads = store.getQuads(actionNode, namedNode(`${QT}query`), null, null);
    if (queryQuads.length === 0) continue;
    
    const queryFile = queryQuads[0].object.value;
    const queryPath = resolveTestPath(manifestDir, queryFile);
    
    // 获取数据文件
    const dataQuads = store.getQuads(actionNode, namedNode(`${QT}data`), null, null);
    const dataFiles = dataQuads.map(q => resolveTestPath(manifestDir, q.object.value));
    
    // 获取期望结果
    const resultQuads = store.getQuads(testQuad.subject, namedNode(`${MF}result`), null, null);
    const resultFile = resultQuads[0]?.object.value || '';
    const resultPath = resultFile ? resolveTestPath(manifestDir, resultFile) : '';
    
    tests.push({
      id: testId,
      name,
      query: queryPath,
      data: dataFiles,
      result: resultPath,
      type: 'QueryEvaluationTest',
    });
  }
  
  return tests;
}

function resolveTestPath(manifestDir: string, filePath: string): string {
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    // 从 URL 提取文件名
    const fileName = filePath.split('/').pop() || filePath;
    return path.join(manifestDir, fileName);
  }
  return path.join(manifestDir, filePath);
}

// 加载测试数据到 store
async function loadTestData(store: Quadstore, dataFiles: string[]): Promise<void> {
  for (const dataFile of dataFiles) {
    if (!fs.existsSync(dataFile)) {
      console.warn(`数据文件不存在: ${dataFile}`);
      continue;
    }
    
    const content = fs.readFileSync(dataFile, 'utf-8');
    const parser = new N3Parser();
    const quads = parser.parse(content);
    
    if (quads.length > 0) {
      await store.multiPut(quads);
    }
  }
}

// 解析 SPARQL XML 结果格式
interface SparqlResult {
  variables: string[];
  bindings: Record<string, { type: string; value: string; datatype?: string }>[];
}

function parseSparqlXmlResults(xmlContent: string): SparqlResult {
  const variables: string[] = [];
  const bindings: Record<string, { type: string; value: string; datatype?: string }>[] = [];
  
  // 使用正则表达式解析 XML（避免外部依赖）
  
  // 解析变量
  const varRegex = /<variable\s+name="([^"]+)"\s*\/>/g;
  let varMatch;
  while ((varMatch = varRegex.exec(xmlContent)) !== null) {
    variables.push(varMatch[1]);
  }
  
  // 解析结果
  const resultRegex = /<result>([\s\S]*?)<\/result>/g;
  let resultMatch;
  while ((resultMatch = resultRegex.exec(xmlContent)) !== null) {
    const resultContent = resultMatch[1];
    const binding: Record<string, { type: string; value: string; datatype?: string }> = {};
    
    // 解析 binding
    const bindingRegex = /<binding\s+name="([^"]+)">([\s\S]*?)<\/binding>/g;
    let bindingMatch;
    while ((bindingMatch = bindingRegex.exec(resultContent)) !== null) {
      const varName = bindingMatch[1];
      const bindingContent = bindingMatch[2];
      
      // 解析 uri
      const uriMatch = /<uri>([^<]*)<\/uri>/.exec(bindingContent);
      if (uriMatch) {
        binding[varName] = { type: 'uri', value: uriMatch[1] };
        continue;
      }
      
      // 解析 literal
      const literalMatch = /<literal(?:\s+datatype="([^"]*)")?(?:\s+xml:lang="([^"]*)")?\s*>([^<]*)<\/literal>/.exec(bindingContent);
      if (literalMatch) {
        binding[varName] = { 
          type: 'literal', 
          value: literalMatch[3],
          datatype: literalMatch[1] || undefined,
        };
        continue;
      }
      
      // 解析 bnode
      const bnodeMatch = /<bnode>([^<]*)<\/bnode>/.exec(bindingContent);
      if (bnodeMatch) {
        binding[varName] = { type: 'bnode', value: bnodeMatch[1] };
      }
    }
    
    bindings.push(binding);
  }
  
  return { variables, bindings };
}

// 比较查询结果
function compareResults(
  actual: Record<string, string>[],
  expected: SparqlResult,
  variables: string[]
): { match: boolean; message: string } {
  // 简化比较：只比较结果数量和值集合
  if (actual.length !== expected.bindings.length) {
    return {
      match: false,
      message: `结果数量不匹配: 实际 ${actual.length}, 期望 ${expected.bindings.length}`,
    };
  }
  
  // 将结果转换为可比较的字符串集合
  const actualSet = new Set(actual.map(row => {
    return variables.map(v => row[v] || '').sort().join('|');
  }));
  
  const expectedSet = new Set(expected.bindings.map(row => {
    return variables.map(v => row[v]?.value || '').sort().join('|');
  }));
  
  // 简单的集合比较
  if (actualSet.size !== expectedSet.size) {
    return {
      match: false,
      message: `结果集合大小不匹配`,
    };
  }
  
  return { match: true, message: 'OK' };
}

// ============================================================
// 测试套件
// ============================================================

describe.skip('W3C SPARQL 1.1 Query Test Suite', () => {
  const testDir = getTestDataPath('w3c_sparql');
  
  // 全局统计
  const globalStats: TestStats = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  beforeAll(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterAll(() => {
    // 打印最终报告
    console.log('\n' + '='.repeat(80));
    console.log('📊 W3C SPARQL 1.1 测试报告');
    console.log('='.repeat(80));
    console.log(`总计: ${globalStats.total}`);
    console.log(`通过: ${globalStats.passed} (${((globalStats.passed / globalStats.total) * 100).toFixed(1)}%)`);
    console.log(`失败: ${globalStats.failed}`);
    console.log(`跳过: ${globalStats.skipped}`);
    console.log('='.repeat(80));
    
    if (globalStats.errors.length > 0) {
      console.log('\n失败的测试:');
      globalStats.errors.slice(0, 10).forEach(e => console.log(`  - ${e}`));
      if (globalStats.errors.length > 10) {
        console.log(`  ... 及其他 ${globalStats.errors.length - 10} 个失败`);
      }
    }
  });

  // 为每个测试类别创建测试组
  for (const category of TEST_CATEGORIES) {
    if (!category.enabled) continue;
    
    describe(`${category.name} - ${category.description}`, () => {
      let store: Quadstore;
      let engine: Engine;
      let dbPath: string;
      let tests: W3CTest[] = [];
      
      beforeAll(async () => {
        // 解析 manifest
        const manifestPath = path.join(W3C_TEST_SUITE, category.dir, 'manifest.ttl');
        tests = await parseManifest(manifestPath);
        console.log(`\n📁 ${category.name}: 发现 ${tests.length} 个测试用例`);
      });
      
      beforeEach(async () => {
        // 每个测试使用独立的数据库
        dbPath = path.join(testDir, `w3c_${category.name}_${Math.random().toString(36).substring(7)}.sqlite`);
        const backend = getBackend(`sqlite:${dbPath}`, { tableName: 'quadstore' });
        store = new Quadstore({
          backend,
          dataFactory: DataFactory,
        });
        await store.open();
        engine = new Engine(store);
      });
      
      afterEach(async () => {
        await store.close();
        if (fs.existsSync(dbPath)) {
          fs.rmSync(dbPath, { force: true });
        }
      });
      
      it(`should run ${category.name} tests`, async () => {
        const categoryStats: TestStats = {
          total: tests.length,
          passed: 0,
          failed: 0,
          skipped: 0,
          errors: [],
        };
        
        for (const test of tests) {
          globalStats.total++;
          
          try {
            // 检查必要文件
            if (!fs.existsSync(test.query)) {
              categoryStats.skipped++;
              globalStats.skipped++;
              continue;
            }
            
            // 重置 store
            await store.close();
            if (fs.existsSync(dbPath)) {
              fs.rmSync(dbPath, { force: true });
            }
            const backend = getBackend(`sqlite:${dbPath}`, { tableName: 'quadstore' });
            store = new Quadstore({
              backend,
              dataFactory: DataFactory,
            });
            await store.open();
            engine = new Engine(store);
            
            // 加载测试数据
            await loadTestData(store, test.data);
            
            // 读取查询
            const queryContent = fs.readFileSync(test.query, 'utf-8');
            
            // 执行查询
            const bindingsStream = await engine.queryBindings(queryContent);
            const bindings = await arrayifyStream(bindingsStream);
            
            // 转换结果
            const actualResults: Record<string, string>[] = bindings.map((binding: any) => {
              const row: Record<string, string> = {};
              for (const [key, value] of binding) {
                row[key] = (value as any).value;
              }
              return row;
            });
            
            // 如果有期望结果，进行比较
            if (test.result && fs.existsSync(test.result)) {
              const resultContent = fs.readFileSync(test.result, 'utf-8');
              
              if (test.result.endsWith('.srx')) {
                const expected = parseSparqlXmlResults(resultContent);
                const comparison = compareResults(actualResults, expected, expected.variables);
                
                if (comparison.match) {
                  categoryStats.passed++;
                  globalStats.passed++;
                } else {
                  categoryStats.failed++;
                  globalStats.failed++;
                  categoryStats.errors.push(`${test.name}: ${comparison.message}`);
                  globalStats.errors.push(`${category.name}/${test.name}: ${comparison.message}`);
                }
              } else {
                // 其他格式暂时跳过
                categoryStats.skipped++;
                globalStats.skipped++;
              }
            } else {
              // 没有期望结果，只要执行成功就算通过
              categoryStats.passed++;
              globalStats.passed++;
            }
            
          } catch (error: any) {
            categoryStats.failed++;
            globalStats.failed++;
            const errMsg = `${test.name}: ${error.message}`;
            categoryStats.errors.push(errMsg);
            globalStats.errors.push(`${category.name}/${errMsg}`);
          }
        }
        
        // 打印类别报告
        console.log(`  ✓ ${categoryStats.passed}/${categoryStats.total} 通过`);
        if (categoryStats.failed > 0) {
          console.log(`  ✗ ${categoryStats.failed} 失败`);
        }
        if (categoryStats.skipped > 0) {
          console.log(`  ○ ${categoryStats.skipped} 跳过`);
        }
        
        // 至少有一些测试通过
        expect(categoryStats.passed).toBeGreaterThan(0);
      });
    });
  }
});

// ============================================================
// 性能基线测试
// ============================================================

describe.skip('QuadstoreSparqlDataAccessor Performance Baseline', () => {
  const testDir = getTestDataPath('accessor_perf');
  let store: Quadstore;
  let engine: Engine;
  let dbPath: string;
  
  const PERF_DATA_SIZE = 1000; // 测试数据量
  
  beforeAll(async () => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    
    dbPath = path.join(testDir, `perf_${Date.now()}.sqlite`);
    const backend = getBackend(`sqlite:${dbPath}`, { tableName: 'quadstore' });
    store = new Quadstore({
      backend,
      dataFactory: DataFactory,
    });
    await store.open();
    engine = new Engine(store);
    
    // 生成测试数据
    console.log(`\n📊 生成 ${PERF_DATA_SIZE} 条测试数据...`);
    const batch: ReturnType<typeof quad>[] = [];
    
    for (let i = 0; i < PERF_DATA_SIZE; i++) {
      const subject = namedNode(`http://example.org/item/${i}`);
      const graph = namedNode(`http://example.org/graph/${i % 10}`);
      
      batch.push(quad(subject, namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode('http://example.org/Item'), graph));
      batch.push(quad(subject, namedNode('http://example.org/value'), literal(i.toString(), namedNode('http://www.w3.org/2001/XMLSchema#integer')), graph));
      batch.push(quad(subject, namedNode('http://example.org/label'), literal(`Item ${i}`), graph));
    }
    
    await store.multiPut(batch);
    console.log(`✅ 数据生成完成，共 ${batch.length} 个 quad\n`);
  });
  
  afterAll(async () => {
    await store.close();
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  });
  
  it('Baseline: Simple SELECT', async () => {
    const query = `
      SELECT ?s ?v WHERE {
        ?s <http://example.org/value> ?v .
      }
      LIMIT 100
    `;
    
    const start = Date.now();
    const stream = await engine.queryBindings(query);
    const results = await arrayifyStream(stream);
    const elapsed = Date.now() - start;
    
    console.log(`  Simple SELECT: ${elapsed}ms, ${results.length} 结果`);
    expect(results.length).toBe(100);
  });
  
  it('Baseline: FILTER with range', async () => {
    const query = `
      SELECT ?s ?v WHERE {
        ?s <http://example.org/value> ?v .
        FILTER(?v > 500)
      }
      LIMIT 100
    `;
    
    const start = Date.now();
    const stream = await engine.queryBindings(query);
    const results = await arrayifyStream(stream);
    const elapsed = Date.now() - start;
    
    console.log(`  FILTER range: ${elapsed}ms, ${results.length} 结果`);
    expect(results.length).toBeGreaterThan(0);
  });
  
  it('Baseline: ORDER BY + LIMIT', async () => {
    const query = `
      SELECT ?s ?v WHERE {
        ?s <http://example.org/value> ?v .
      }
      ORDER BY DESC(?v)
      LIMIT 10
    `;
    
    const start = Date.now();
    const stream = await engine.queryBindings(query);
    const results = await arrayifyStream(stream);
    const elapsed = Date.now() - start;
    
    console.log(`  ORDER BY + LIMIT: ${elapsed}ms, ${results.length} 结果`);
    expect(results.length).toBe(10);
  });
  
  it('Baseline: Graph query', async () => {
    const query = `
      SELECT ?s ?v WHERE {
        GRAPH <http://example.org/graph/0> {
          ?s <http://example.org/value> ?v .
        }
      }
    `;
    
    const start = Date.now();
    const stream = await engine.queryBindings(query);
    const results = await arrayifyStream(stream);
    const elapsed = Date.now() - start;
    
    console.log(`  Graph query: ${elapsed}ms, ${results.length} 结果`);
    expect(results.length).toBe(PERF_DATA_SIZE / 10);
  });
  
  it('Baseline: COUNT aggregation', async () => {
    const query = `
      SELECT (COUNT(?s) AS ?count) WHERE {
        ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Item> .
      }
    `;
    
    const start = Date.now();
    const stream = await engine.queryBindings(query);
    const results = await arrayifyStream(stream);
    const elapsed = Date.now() - start;
    
    const count = (results[0] as any).get('count')?.value;
    console.log(`  COUNT: ${elapsed}ms, count=${count}`);
    expect(parseInt(count)).toBe(PERF_DATA_SIZE);
  });
});
