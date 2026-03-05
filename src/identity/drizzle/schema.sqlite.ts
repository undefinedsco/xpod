import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const accountUsage = sqliteTable('identity_account_usage', {
  accountId: text('account_id').primaryKey(),
  storageBytes: integer('storage_bytes').notNull().default(0),
  ingressBytes: integer('ingress_bytes').notNull().default(0),
  egressBytes: integer('egress_bytes').notNull().default(0),
  storageLimitBytes: integer('storage_limit_bytes'),
  bandwidthLimitBps: integer('bandwidth_limit_bps'),
  computeSeconds: integer('compute_seconds').notNull().default(0),
  tokensUsed: integer('tokens_used').notNull().default(0),
  computeLimitSeconds: integer('compute_limit_seconds'),
  tokenLimitMonthly: integer('token_limit_monthly'),
  periodStart: integer('period_start'),
  updatedAt: integer('updated_at').notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
});

export const podUsage = sqliteTable('identity_pod_usage', {
  podId: text('pod_id').primaryKey(),
  accountId: text('account_id').notNull(),
  storageBytes: integer('storage_bytes').notNull().default(0),
  ingressBytes: integer('ingress_bytes').notNull().default(0),
  egressBytes: integer('egress_bytes').notNull().default(0),
  storageLimitBytes: integer('storage_limit_bytes'),
  bandwidthLimitBps: integer('bandwidth_limit_bps'),
  computeSeconds: integer('compute_seconds').notNull().default(0),
  tokensUsed: integer('tokens_used').notNull().default(0),
  computeLimitSeconds: integer('compute_limit_seconds'),
  tokenLimitMonthly: integer('token_limit_monthly'),
  periodStart: integer('period_start'),
  updatedAt: integer('updated_at').notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
});

/**
 * WebID Profile 托管表
 * 用于身份与存储分离架构，Cloud 托管用户的 WebID Profile
 */
export const webidProfiles = sqliteTable('identity_webid_profile', {
  username: text('username').primaryKey(),
  webidUrl: text('webid_url').notNull(),              // https://id.undefineds.co/alice/profile/card#me
  storageUrl: text('storage_url'),                    // https://alice.undefineds.xyz/ 或 https://pods.undefineds.co/alice/
  storageMode: text('storage_mode').default('cloud'), // 'cloud' | 'local' | 'custom'
  oidcIssuer: text('oidc_issuer'),                    // https://id.undefineds.co/
  profileData: text('profile_data', { mode: 'json' }), // WebID Profile 的 JSON-LD 表示
  accountId: text('account_id'),                      // 关联的 CSS 账户 ID
  createdAt: integer('created_at').notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  updatedAt: integer('updated_at').notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
});

/**
 * DDNS 域名池表
 * 管理可用的 DDNS 域名
 */
export const ddnsDomains = sqliteTable('identity_ddns_domain', {
  domain: text('domain').primaryKey(),                // undefineds.xyz
  status: text('status').default('active'),           // 'active' | 'suspended'
  provider: text('provider'),                         // 'cloudflare' | 'tencent'
  zoneId: text('zone_id'),                            // DNS Zone ID
  createdAt: integer('created_at').notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
});

/**
 * DDNS 记录表
 * 已分配的子域名记录
 */
export const ddnsRecords = sqliteTable('identity_ddns_record', {
  subdomain: text('subdomain').primaryKey(),          // alice
  domain: text('domain').notNull(),                   // undefineds.xyz
  ipAddress: text('ip_address'),
  ipv6Address: text('ipv6_address'),
  recordType: text('record_type').default('A'),       // 'A' | 'AAAA'
  nodeId: text('node_id'),                            // 关联的节点 ID
  username: text('username'),                         // 关联的用户名
  status: text('status').default('active'),           // 'active' | 'banned'
  bannedReason: text('banned_reason'),
  ttl: integer('ttl').default(60),
  createdAt: integer('created_at').notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  updatedAt: integer('updated_at').notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
});

export const edgeNodes = sqliteTable('identity_edge_node', {
  id: text('id').primaryKey(),
  ownerAccountId: text('owner_account_id'),     // Owner of the node
  displayName: text('display_name'),
  tokenHash: text('token_hash').notNull(),
  nodeType: text('node_type').default('edge'),  // 'center' | 'edge' | 'sp'
  subdomain: text('subdomain').unique(),
  accessMode: text('access_mode'),
  ipv4: text('ipv4'),                          // IPv4 地址
  publicPort: integer('public_port'),
  publicUrl: text('public_url'),                // SP 的公网地址 (e.g. https://sp.example)
  serviceTokenHash: text('service_token_hash'), // Cloud → SP 回调认证 token (明文)
  provisionCodeHash: text('provision_code_hash'), // bind 时用户传入的配对码 (hash)
  internalIp: text('internal_ip'),              // Internal network IP for center nodes
  internalPort: integer('internal_port'),
  // Extracted from metadata
  hostname: text('hostname'),                   // 节点主机名
  ipv6: text('ipv6'),                          // IPv6 地址
  version: text('version'),                    // Agent 版本
  // JSON fields
  capabilities: text('capabilities'),           // JSON string: 能力列表
  metadata: text('metadata'),                   // JSON string: 复杂对象 (tunnel, certificate, metrics)
  connectivityStatus: text('connectivity_status').default('unknown'),
  lastConnectivityCheck: integer('last_connectivity_check'),
  createdAt: integer('created_at').notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  updatedAt: integer('updated_at').notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  lastSeen: integer('last_seen'),
});

export const edgeNodePods = sqliteTable('identity_edge_node_pod', {
  nodeId: text('node_id').notNull().references(() => edgeNodes.id, { onDelete: 'cascade' }),
  baseUrl: text('base_url').notNull(),
});

export const apiClientCredentials = sqliteTable('identity_api_client_credentials', {
  clientId: text('client_id').primaryKey(),
  webId: text('web_id').notNull(),
  accountId: text('account_id').notNull(),
  displayName: text('display_name'),
  createdAt: integer('created_at').notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
});

/**
 * Service Token 表
 * 用于服务间认证 (Business, Local SP, Cloud, Compute)
 */
export const serviceTokens = sqliteTable('identity_service_token', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  serviceType: text('service_type').notNull(), // 'local' | 'business' | 'cloud' | 'compute'
  serviceId: text('service_id').notNull(),
  scopes: text('scopes').notNull(), // JSON array: ["quota:write","usage:read"]
  createdAt: integer('created_at').notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  expiresAt: integer('expires_at'),
});
