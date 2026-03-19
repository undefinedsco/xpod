/**
 * Credential Schema - Pod RDF 表定义
 *
 * 使用 solidSchema + extend 实现继承：
 * - Credential (基类) — 共享字段
 *   ├── ApiKeyCredential — API Key 凭据
 *   └── OAuthCredential  — OAuth 凭据
 *
 * 存储位置: /settings/credentials.ttl
 *
 * RDF 示例:
 * <#cred-001> a udfs:ApiKeyCredential ;
 *     udfs:provider </settings/ai/providers.ttl#google> ;
 *     udfs:service "ai" ;
 *     udfs:status "active" ;
 *     udfs:apiKey "sk-xxx" ;
 *     udfs:label "Google AI" .
 *
 * <#cred-002> a udfs:OAuthCredential ;
 *     udfs:provider </settings/ai/providers.ttl#codebuddy> ;
 *     udfs:service "ai" ;
 *     udfs:status "active" ;
 *     udfs:oauthAccessToken "tok-xxx" ;
 *     udfs:oauthRefreshToken "ref-xxx" ;
 *     udfs:oauthExpiresAt "2026-03-03T00:00:00Z" .
 */

import { solidSchema, string, int, datetime, uri } from '@undefineds.co/drizzle-solid';
import { UDFS, UDFS_NAMESPACE } from '../../vocab';

// ============================================================================
// 基类 Schema（共享字段）
// ============================================================================

const credentialSchema = solidSchema({
  id: string('id').primaryKey(),
  provider: uri('provider').predicate(UDFS.provider),
  service: string('service').predicate(UDFS.service),
  status: string('status').predicate(UDFS.status),
  label: string('label').predicate(UDFS.label),
  lastUsedAt: datetime('lastUsedAt').predicate(UDFS.lastUsedAt),
  failCount: int('failCount').predicate(UDFS.failCount),
  rateLimitResetAt: datetime('rateLimitResetAt').predicate(UDFS.rateLimitResetAt),
}, {
  type: UDFS.Credential,
  namespace: UDFS_NAMESPACE,
});

// ============================================================================
// API Key 凭据
// ============================================================================

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

// ============================================================================
// OAuth 凭据
// ============================================================================

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

// ============================================================================
// 向后兼容：Credential 别名指向 ApiKeyCredential
// 现有代码中 import { Credential } 的地方不需要改动
// ============================================================================

export const Credential = ApiKeyCredential;
