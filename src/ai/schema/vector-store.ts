/**
 * VectorStore Schema - Container 级别的知识库配置
 *
 * 存储位置: /settings/ai/vector-stores.ttl
 */

import { podTable, string, int, datetime, uri } from 'drizzle-solid';
import { UDFS, UDFS_NAMESPACE } from '../../vocab';

/**
 * VectorStore - Container 级别的知识库配置
 *
 * RDF 示例:
 * <#vs_abc123> a udfs:VectorStore ;
 *     udfs:name "My Notes" ;
 *     udfs:container </notes/> ;
 *     udfs:chunkingStrategy "auto" ;
 *     udfs:status "completed" ;
 *     udfs:createdAt "2024-01-15T10:30:00Z"^^xsd:dateTime .
 */
export const VectorStore = podTable(
  'VectorStore',
  {
    id: string('id').primaryKey(),
    name: string('name'),
    container: uri('container'),
    chunkingStrategy: string('chunkingStrategy'),
    status: string('status'),
    createdAt: datetime('createdAt'),
    lastActiveAt: datetime('lastActiveAt'),
  },
  {
    base: '/settings/ai/vector-stores.ttl',
    type: UDFS.VectorStore,
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '#{id}',
  },
);

export type VectorStoreRow = typeof VectorStore.$inferSelect;
export type VectorStoreInsert = typeof VectorStore.$inferInsert;

/**
 * IndexedFile - 全局文件索引状态管理
 *
 * 存储位置: /settings/ai/indexed-files.ttl
 *
 * RDF 示例:
 * <#idx_abc123> a udfs:IndexedFile ;
 *     udfs:fileUrl </notes/hello.md> ;
 *     udfs:vectorId "123456789"^^xsd:integer ;
 *     udfs:chunkingStrategy "auto" ;
 *     udfs:status "completed" ;
 *     udfs:usageBytes "1024"^^xsd:integer ;
 *     udfs:indexedAt "2024-01-15T10:30:00Z"^^xsd:dateTime .
 */
export const IndexedFile = podTable(
  'IndexedFile',
  {
    id: string('id').primaryKey(),
    fileUrl: uri('fileUrl'),
    vectorId: int('vectorId'),
    chunkingStrategy: string('chunkingStrategy'),
    status: string('status'),
    usageBytes: int('usageBytes'),
    lastError: string('lastError'),
    indexedAt: datetime('indexedAt'),
  },
  {
    base: '/settings/ai/indexed-files.ttl',
    type: UDFS.IndexedFile,
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '#{id}',
  },
);

export type IndexedFileRow = typeof IndexedFile.$inferSelect;
export type IndexedFileInsert = typeof IndexedFile.$inferInsert;
