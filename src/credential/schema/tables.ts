/**
 * Credential Schema - Pod RDF 表定义
 */

import { podTable, string, int, datetime, uri } from 'drizzle-solid';

// 命名空间配置
const CRED_NAMESPACE = {
  prefix: 'cred',
  uri: 'https://vocab.xpod.dev/credential#',
};

/**
 * Credential 表 - 凭据存储
 *
 * 存储位置: /settings/credentials.ttl
 */
export const credentialTable = podTable(
  'credential',
  {
    id: string('id').primaryKey(),
    provider: uri('provider').reference('provider'), // 用表名引用，避免循环依赖
    service: string('service'),
    status: string('status'),
    apiKey: string('apiKey'),
    baseUrl: string('baseUrl'),
    label: string('label'),
    lastUsedAt: datetime('lastUsedAt'),
    failCount: int('failCount'),
    rateLimitResetAt: datetime('rateLimitResetAt'),
  },
  {
    base: '/settings/credentials.ttl',
    type: 'https://vocab.xpod.dev/credential#Credential',
    namespace: CRED_NAMESPACE,
    subjectTemplate: '#{id}',
  },
);
