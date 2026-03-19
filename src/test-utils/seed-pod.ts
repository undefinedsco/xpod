/**
 * Seed 测试 Pod 数据 - 在 SPARQL 数据库插入容器元数据
 */
import { promises as fs } from 'fs';
import path from 'path';
import { createSqliteDatabase } from '../storage/SqliteCompat';

export interface SeedPodOptions {
  rootFilePath: string;
  podName?: string;
}

export async function seedPod(options: SeedPodOptions): Promise<void> {
  const { rootFilePath, podName = 'test' } = options;

  // 确保目录存在
  await fs.mkdir(rootFilePath, { recursive: true });

  const sparqlDbPath = path.join(rootFilePath, 'sparql.db');
  const db = createSqliteDatabase(sparqlDbPath);

  // 创建 quints 表（如果不存在）
  db.exec(`
    CREATE TABLE IF NOT EXISTS quints (
      graph TEXT NOT NULL,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      vector TEXT,
      PRIMARY KEY (graph, subject, predicate, object)
    );
  `);

  const baseUrl = 'http://localhost:5741';
  const now = new Date().toISOString();
  const yyyy = new Date().getFullYear();
  const MM = String(new Date().getMonth() + 1).padStart(2, '0');
  const dd = String(new Date().getDate()).padStart(2, '0');

  // 插入容器元数据到 quints 表
  const containers = [
    `${baseUrl}/${podName}/`,
    `${baseUrl}/${podName}/.data/`,
    `${baseUrl}/${podName}/.data/chat/`,
    `${baseUrl}/${podName}/.data/chat/cli-default/`,
    `${baseUrl}/${podName}/.data/chat/cli-default/${yyyy}/`,
    `${baseUrl}/${podName}/.data/chat/cli-default/${yyyy}/${MM}/`,
    `${baseUrl}/${podName}/.data/chat/cli-default/${yyyy}/${MM}/${dd}/`,
  ];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO quints (graph, subject, predicate, object, vector)
    VALUES (?, ?, ?, ?, NULL)
  `);

  for (const container of containers) {
    const metaGraph = `meta:${container}`;

    // 类型
    insert.run(metaGraph, container, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://www.w3.org/ns/ldp#Container');
    insert.run(metaGraph, container, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://www.w3.org/ns/ldp#BasicContainer');
    insert.run(metaGraph, container, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://www.w3.org/ns/ldp#Resource');

    // 修改时间
    insert.run(metaGraph, container, 'http://purl.org/dc/terms/modified', `"${now}"^^http://www.w3.org/2001/XMLSchema#dateTime`);
  }

  db.close();
  console.log(`✓ SPARQL 容器元数据插入完成 (${containers.length} 个容器)`);
}
