#!/usr/bin/env npx ts-node
/**
 * SPARQL 存储引擎性能基准测试
 * 
 * 测试目标：
 * - Quadstore 直接 API 性能（get/getStream）
 * - Quadstore + Comunica SPARQL 查询性能
 * - 对比不同查询模式的性能差异
 * 
 * 测试场景：
 * 1. 全量扫描 vs 条件过滤
 * 2. LIMIT/OFFSET 分页
 * 3. ORDER BY 排序
 * 4. GRAPH 隔离查询
 * 5. FILTER 日期范围
 * 6. 多 Triple JOIN
 * 7. 聚合函数 (COUNT/DISTINCT)
 * 
 * 运行方式：
 *   npx ts-node scripts/sparql-benchmark.ts
 *   npx ts-node scripts/sparql-benchmark.ts --messages=500 --users=20
 * 
 * 依赖：
 *   - quadstore + quadstore-comunica
 *   - SQLite backend (通过 src/libs/backends)
 */

import fs from 'fs';
import path from 'path';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import { Quadstore } from 'quadstore';
import { Engine } from 'quadstore-comunica';
import { getBackend } from '../src/libs/backends';
import arrayifyStream from 'arrayify-stream';

const { namedNode, quad, literal } = DataFactory;

// ============================================================
// 命名空间定义
// ============================================================

const XSD = {
  integer: namedNode('http://www.w3.org/2001/XMLSchema#integer'),
  dateTime: namedNode('http://www.w3.org/2001/XMLSchema#dateTime'),
};

const SCHEMA = {
  Message: namedNode('http://schema.org/Message'),
  dateCreated: namedNode('http://schema.org/dateCreated'),
  author: namedNode('http://schema.org/author'),
  text: namedNode('http://schema.org/text'),
  Person: namedNode('http://schema.org/Person'),
  name: namedNode('http://schema.org/name'),
};

const RDF = {
  type: namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
};

// ============================================================
// 配置
// ============================================================

interface BenchmarkConfig {
  numUsers: number;
  numMessagesPerUser: number;
  dbPath: string;
}

function parseArgs(): BenchmarkConfig {
  const args = process.argv.slice(2);
  let numUsers = 10;
  let numMessagesPerUser = 100;

  for (const arg of args) {
    if (arg.startsWith('--users=')) {
      numUsers = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--messages=')) {
      numMessagesPerUser = parseInt(arg.split('=')[1], 10);
    }
  }

  const testDir = path.join(process.cwd(), '.test-data', 'benchmark');
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  return {
    numUsers,
    numMessagesPerUser,
    dbPath: path.join(testDir, `benchmark_${Date.now()}.sqlite`),
  };
}

// ============================================================
// 数据生成
// ============================================================

async function generateTestData(store: Quadstore, config: BenchmarkConfig): Promise<number> {
  const { numUsers, numMessagesPerUser } = config;
  // Quadstore SQLite 有批量插入限制，每个 quad 生成 6 个索引条目
  // SQLite UNION ALL 限制约 500 个，所以 batch size 需要小于 500/6 ≈ 83
  const batchSize = 50;
  let batch: Quad[] = [];
  let totalQuads = 0;

  for (let u = 0; u < numUsers; u++) {
    const userId = `http://example.org/users/user_${u}`;
    const userGraph = namedNode(`${userId}/`);
    const userNode = namedNode(userId);

    // 用户信息 (2 quads per user)
    batch.push(quad(userNode, RDF.type, SCHEMA.Person, userGraph));
    batch.push(quad(userNode, SCHEMA.name, literal(`User ${u}`), userGraph));

    // 用户的消息 (4 quads per message)
    for (let m = 0; m < numMessagesPerUser; m++) {
      const msgId = namedNode(`${userId}/messages/msg_${m}`);
      const timestamp = new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000);

      batch.push(quad(msgId, RDF.type, SCHEMA.Message, userGraph));
      batch.push(quad(msgId, SCHEMA.dateCreated, literal(timestamp.toISOString(), XSD.dateTime), userGraph));
      batch.push(quad(msgId, SCHEMA.author, userNode, userGraph));
      batch.push(quad(msgId, SCHEMA.text, literal(`Message ${m} from user ${u}`), userGraph));

      if (batch.length >= batchSize) {
        await store.multiPut(batch);
        totalQuads += batch.length;
        batch = [];
      }
    }
  }

  if (batch.length > 0) {
    await store.multiPut(batch);
    totalQuads += batch.length;
  }

  return totalQuads;
}

// ============================================================
// 基准测试
// ============================================================

interface BenchmarkResult {
  category: string;
  name: string;
  timeMs: number;
  resultCount: number;
}

const results: BenchmarkResult[] = [];

async function benchmark(
  category: string,
  name: string,
  fn: () => Promise<number>
): Promise<BenchmarkResult> {
  // 预热
  await fn();
  
  // 正式测试
  const start = Date.now();
  const resultCount = await fn();
  const timeMs = Date.now() - start;

  const result = { category, name, timeMs, resultCount };
  results.push(result);
  
  console.log(`  ${name.padEnd(45)} ${timeMs.toString().padStart(6)}ms  ${resultCount.toString().padStart(8)} results`);
  return result;
}

async function runDirectApiBenchmarks(store: Quadstore): Promise<void> {
  console.log('\n📊 Direct API Benchmarks (store.get / store.getStream)');
  console.log('─'.repeat(75));

  await benchmark('Direct API', '全量扫描 get({})', async () => {
    const { items } = await store.get({});
    return items.length;
  });

  await benchmark('Direct API', '按 predicate 过滤 get({predicate})', async () => {
    const { items } = await store.get({ predicate: RDF.type });
    return items.length;
  });

  await benchmark('Direct API', '按 graph 过滤 get({graph})', async () => {
    const { items } = await store.get({ graph: namedNode('http://example.org/users/user_0/') });
    return items.length;
  });

  await benchmark('Direct API', 'getStream + limit:10', async () => {
    const { iterator } = await store.getStream({ predicate: RDF.type }, { limit: 10 });
    const items: Quad[] = [];
    for await (const item of iterator) {
      items.push(item);
    }
    return items.length;
  });

  await benchmark('Direct API', 'getStream + order:object + limit:10', async () => {
    const { iterator } = await store.getStream(
      { predicate: SCHEMA.dateCreated },
      { limit: 10, order: ['object'], reverse: true }
    );
    const items: Quad[] = [];
    for await (const item of iterator) {
      items.push(item);
    }
    return items.length;
  });
}

async function runSparqlBenchmarks(engine: Engine): Promise<void> {
  console.log('\n📊 SPARQL Query Benchmarks (quadstore-comunica)');
  console.log('─'.repeat(75));

  // 简单 BGP
  await benchmark('SPARQL', '简单 BGP - 所有 Message', async () => {
    const stream = await engine.queryBindings(`
      SELECT ?s WHERE {
        ?s <${RDF.type.value}> <${SCHEMA.Message.value}> .
      }
    `);
    const results = await arrayifyStream(stream);
    return results.length;
  });

  // LIMIT
  await benchmark('SPARQL', 'BGP + LIMIT 10', async () => {
    const stream = await engine.queryBindings(`
      SELECT ?s WHERE {
        ?s <${RDF.type.value}> <${SCHEMA.Message.value}> .
      }
      LIMIT 10
    `);
    const results = await arrayifyStream(stream);
    return results.length;
  });

  // ORDER BY + LIMIT
  await benchmark('SPARQL', 'ORDER BY DESC + LIMIT 10', async () => {
    const stream = await engine.queryBindings(`
      SELECT ?s ?date WHERE {
        ?s <${RDF.type.value}> <${SCHEMA.Message.value}> .
        ?s <${SCHEMA.dateCreated.value}> ?date .
      }
      ORDER BY DESC(?date)
      LIMIT 10
    `);
    const results = await arrayifyStream(stream);
    return results.length;
  });

  // GRAPH 查询
  await benchmark('SPARQL', 'GRAPH 隔离查询', async () => {
    const stream = await engine.queryBindings(`
      SELECT ?s ?date WHERE {
        GRAPH <http://example.org/users/user_0/> {
          ?s <${RDF.type.value}> <${SCHEMA.Message.value}> .
          ?s <${SCHEMA.dateCreated.value}> ?date .
        }
      }
    `);
    const results = await arrayifyStream(stream);
    return results.length;
  });

  // FILTER 日期范围
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await benchmark('SPARQL', 'FILTER 日期范围 (7天内)', async () => {
    const stream = await engine.queryBindings(`
      SELECT ?s ?date WHERE {
        ?s <${RDF.type.value}> <${SCHEMA.Message.value}> .
        ?s <${SCHEMA.dateCreated.value}> ?date .
        FILTER(?date > "${oneWeekAgo}"^^<${XSD.dateTime.value}>)
      }
    `);
    const results = await arrayifyStream(stream);
    return results.length;
  });

  // 多 Triple JOIN
  await benchmark('SPARQL', '多 Triple JOIN + LIMIT 100', async () => {
    const stream = await engine.queryBindings(`
      SELECT ?msg ?authorName ?date WHERE {
        ?msg <${RDF.type.value}> <${SCHEMA.Message.value}> .
        ?msg <${SCHEMA.dateCreated.value}> ?date .
        ?msg <${SCHEMA.author.value}> ?author .
        ?author <${SCHEMA.name.value}> ?authorName .
      }
      LIMIT 100
    `);
    const results = await arrayifyStream(stream);
    return results.length;
  });

  // 综合查询
  await benchmark('SPARQL', '综合 (FILTER + ORDER + LIMIT)', async () => {
    const stream = await engine.queryBindings(`
      SELECT ?msg ?date ?text WHERE {
        ?msg <${RDF.type.value}> <${SCHEMA.Message.value}> .
        ?msg <${SCHEMA.dateCreated.value}> ?date .
        ?msg <${SCHEMA.text.value}> ?text .
        FILTER(?date > "${oneWeekAgo}"^^<${XSD.dateTime.value}>)
      }
      ORDER BY DESC(?date)
      LIMIT 10
    `);
    const results = await arrayifyStream(stream);
    return results.length;
  });

  // COUNT 聚合
  await benchmark('SPARQL', 'COUNT 聚合', async () => {
    const stream = await engine.queryBindings(`
      SELECT (COUNT(?s) AS ?count) WHERE {
        ?s <${RDF.type.value}> <${SCHEMA.Message.value}> .
      }
    `);
    const results = await arrayifyStream(stream);
    return results.length;
  });

  // DISTINCT
  await benchmark('SPARQL', 'DISTINCT 作者', async () => {
    const stream = await engine.queryBindings(`
      SELECT DISTINCT ?author WHERE {
        ?msg <${SCHEMA.author.value}> ?author .
      }
    `);
    const results = await arrayifyStream(stream);
    return results.length;
  });
}

// ============================================================
// 报告输出
// ============================================================

function printReport(config: BenchmarkConfig, totalQuads: number): void {
  console.log('\n');
  console.log('╔════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                      SPARQL Benchmark Report                               ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║ 数据规模: ${config.numUsers} 用户 × ${config.numMessagesPerUser} 消息/用户 = ${config.numUsers * config.numMessagesPerUser} 消息`.padEnd(77) + '║');
  console.log(`║ 总 Quads: ${totalQuads}`.padEnd(77) + '║');
  console.log('╠════════════════════════════════════════════════════════════════════════════╣');
  console.log('║ Category     │ Test Case                                  │ Time   │ Count ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════╣');

  for (const r of results) {
    const cat = r.category.padEnd(12);
    const name = r.name.substring(0, 40).padEnd(40);
    const time = (r.timeMs + 'ms').padStart(6);
    const count = r.resultCount.toString().padStart(6);
    console.log(`║ ${cat} │ ${name} │ ${time} │ ${count} ║`);
  }

  console.log('╚════════════════════════════════════════════════════════════════════════════╝');
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  const config = parseArgs();
  const totalMessages = config.numUsers * config.numMessagesPerUser;

  console.log('\n🚀 SPARQL 存储引擎性能基准测试');
  console.log('═'.repeat(75));
  console.log(`配置: ${config.numUsers} 用户 × ${config.numMessagesPerUser} 消息/用户 = ${totalMessages} 消息`);
  console.log(`数据库: ${config.dbPath}`);
  console.log('═'.repeat(75));

  // 初始化 Quadstore
  console.log('\n⏳ 初始化 Quadstore (SQLite backend)...');
  const backend = getBackend(`sqlite:${config.dbPath}`, { tableName: 'quadstore' });
  // @ts-expect-error - Quadstore 类型定义与 abstract-level 版本有冲突，但运行时正常
  const store = new Quadstore({ backend, dataFactory: DataFactory });
  await store.open();
  console.log('✅ Quadstore 初始化完成');

  // 生成测试数据
  console.log('\n⏳ 生成测试数据...');
  const genStart = Date.now();
  const totalQuads = await generateTestData(store, config);
  console.log(`✅ 数据生成完成: ${totalQuads} quads, 耗时 ${Date.now() - genStart}ms`);

  // 运行 Direct API 基准测试
  await runDirectApiBenchmarks(store);

  // 初始化 SPARQL 引擎
  console.log('\n⏳ 初始化 SPARQL 引擎 (quadstore-comunica)...');
  const engineStart = Date.now();
  const engine = new Engine(store);
  console.log(`✅ 引擎初始化完成: ${Date.now() - engineStart}ms`);

  // 运行 SPARQL 基准测试
  await runSparqlBenchmarks(engine);

  // 输出报告
  printReport(config, totalQuads);

  // 清理
  await store.close();
  fs.rmSync(config.dbPath, { force: true });
  console.log('\n✅ 测试完成，临时数据库已清理\n');
}

main().catch((err) => {
  console.error('❌ 基准测试失败:', err);
  process.exit(1);
});
