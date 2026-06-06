import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

export const usage = sqliteTable('identity_usage', {
  scopeType: text('scope_type').notNull(), // 'account' | 'pod'
  scopeId: text('scope_id').notNull(),
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
}, (table) => [
  primaryKey({ columns: [ table.scopeType, table.scopeId ] }),
]);

/**
 * Cloud cluster DDNS 记录表
 * 已分配的子域名记录
 */
export const ddnsRecords = sqliteTable('cluster_ddns_record', {
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

export const edgeNodes = sqliteTable('cluster_node', {
  id: text('id').primaryKey(),
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
  podBaseUrls: text('pod_base_urls'),            // JSON string: node-owned Pod/storage URL prefixes
  connectivityStatus: text('connectivity_status').default('unknown'),
  lastConnectivityCheck: integer('last_connectivity_check'),
  createdAt: integer('created_at').notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  updatedAt: integer('updated_at').notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  lastSeen: integer('last_seen'),
});

/**
 * Cloud cluster Service Token 表
 * 用于服务间认证 (Business, Local SP, Cloud, Compute)
 */
export const serviceTokens = sqliteTable('cluster_service_token', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  serviceType: text('service_type').notNull(), // 'local' | 'business' | 'cloud' | 'compute'
  serviceId: text('service_id').notNull(),
  scopes: text('scopes').notNull(), // JSON array: ["quota:write","usage:read"]
  createdAt: integer('created_at').notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  expiresAt: integer('expires_at'),
});
