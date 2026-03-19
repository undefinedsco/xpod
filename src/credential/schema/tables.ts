/**
 * Credential Schema - Pod RDF 表定义
 *
 * 使用 solidSchema + extend 实现继承：
 * - Credential (基类) — 共享字段
 *   ├── ApiKeyCredential — API Key 凭据
 *   └── OAuthCredential — OAuth 凭据
 *
 * 存储位置: /settings/credentials.ttl
 *
 * 兼容性说明：
 * - 保留旧版 `Credential` 导出，继续指向 API Key 凭据表
 * - 保留 `baseUrl` / `proxyUrl` / `projectId` / `organizationId` 字段，
 *   兼容现有调用方直接从凭据读取这些配置
 */

import { solidSchema, string, int, datetime, uri } from '@undefineds.co/drizzle-solid';
import { UDFS, UDFS_NAMESPACE } from '../../vocab';

const credentialSchema = solidSchema({
  id: string('id').primaryKey(),
  provider: uri('provider').predicate(UDFS.provider),
  service: string('service').predicate(UDFS.service),
  status: string('status').predicate(UDFS.status),
  label: string('label').predicate(UDFS.label),
  lastUsedAt: datetime('lastUsedAt').predicate(UDFS.lastUsedAt),
  failCount: int('failCount').predicate(UDFS.failCount),
  rateLimitResetAt: datetime('rateLimitResetAt').predicate(UDFS.rateLimitResetAt),
  baseUrl: string('baseUrl').predicate(UDFS.baseUrl),
  proxyUrl: string('proxyUrl').predicate(UDFS.proxyUrl),
  projectId: string('projectId').predicate(UDFS.projectId),
  organizationId: string('organizationId').predicate(UDFS.organizationId),
}, {
  type: UDFS.Credential,
  namespace: UDFS_NAMESPACE,
});

const apiKeyCredentialSchema = credentialSchema.extend({
  apiKey: string('apiKey').predicate(UDFS.apiKey),
}, {
  type: UDFS.ApiKeyCredential,
});

export const ApiKeyCredential = apiKeyCredentialSchema.table(
  'ApiKeyCredential',
  {
    base: '/settings/credentials.ttl',
    subjectTemplate: '#{id}',
  },
);

const oauthCredentialSchema = credentialSchema.extend({
  oauthRefreshToken: string('oauthRefreshToken').predicate(UDFS.oauthRefreshToken),
  oauthAccessToken: string('oauthAccessToken').predicate(UDFS.oauthAccessToken),
  oauthExpiresAt: datetime('oauthExpiresAt').predicate(UDFS.oauthExpiresAt),
}, {
  type: UDFS.OAuthCredential,
});

export const OAuthCredential = oauthCredentialSchema.table(
  'OAuthCredential',
  {
    base: '/settings/credentials.ttl',
    subjectTemplate: '#{id}',
  },
);

export const Credential = ApiKeyCredential;
