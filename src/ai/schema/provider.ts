/**
 * Provider Schema - AI 供应商配置
 *
 * 存储位置: /settings/ai/providers.ttl
 *
 * RDF 示例:
 * <#google> a udfs:Provider ;
 *     udfs:displayName "Google AI" ;
 *     udfs:baseUrl "https://generativelanguage.googleapis.com/v1beta/openai" ;
 *     udfs:hasModel </settings/ai/models.ttl#text-embedding-004> .
 */

import { podTable, string, uri } from 'drizzle-solid';
import { UDFS, UDFS_NAMESPACE } from '../../vocab';

export const Provider = podTable(
  'Provider',
  {
    id: string('id').primaryKey(),
    displayName: string('displayName'),
    baseUrl: string('baseUrl'),
    proxyUrl: string('proxyUrl'),
    hasModel: uri('hasModel'),
    hasCredential: uri('hasCredential'),
  },
  {
    base: '/settings/ai/providers.ttl',
    type: UDFS.Provider,
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '#{id}',
  },
);

export type ProviderRow = typeof Provider.$inferSelect;
export type ProviderInsert = typeof Provider.$inferInsert;
