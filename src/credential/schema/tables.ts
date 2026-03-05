/**
 * Credential Schema - Pod RDF 表定义
 */

import { podTable, string, int, datetime, uri } from '@undefineds.co/drizzle-solid';
import { UDFS, UDFS_NAMESPACE } from '../../vocab';

/**
 * Credential - 凭据存储
 *
 * 存储位置: /settings/credentials.ttl
 *
 * RDF 示例:
 * <#cred-001> a udfs:Credential ;
 *     udfs:provider </settings/ai/providers.ttl#google> ;
 *     udfs:service "ai" ;
 *     udfs:status "active" ;
 *     udfs:apiKey "sk-xxx" ;
 *     udfs:label "Google AI" .
 */
export const Credential = podTable(
  'Credential',
  {
    id: string('id').primaryKey(),
    provider: uri('provider'),
    service: string('service'),
    status: string('status'),
    apiKey: string('apiKey'),
    baseUrl: string('baseUrl'),
    proxyUrl: string('proxyUrl'),
    projectId: string('projectId'),
    organizationId: string('organizationId'),
    label: string('label'),
    lastUsedAt: datetime('lastUsedAt'),
    failCount: int('failCount'),
    rateLimitResetAt: datetime('rateLimitResetAt'),
  },
  {
    base: '/settings/credentials.ttl',
    type: UDFS.Credential,
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '#{id}',
  },
);

