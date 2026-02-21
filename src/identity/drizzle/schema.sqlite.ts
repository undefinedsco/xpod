import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const accountUsage = sqliteTable('identity_account_usage', {
  accountId: text('account_id').primaryKey(),
  storageBytes: integer('storage_bytes').notNull().default(0),
  ingressBytes: integer('ingress_bytes').notNull().default(0),
  egressBytes: integer('egress_bytes').notNull().default(0),
  storageLimitBytes: integer('storage_limit_bytes'),
  bandwidthLimitBps: integer('bandwidth_limit_bps'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

export const podUsage = sqliteTable('identity_pod_usage', {
  podId: text('pod_id').primaryKey(),
  accountId: text('account_id').notNull(),
  storageBytes: integer('storage_bytes').notNull().default(0),
  ingressBytes: integer('ingress_bytes').notNull().default(0),
  egressBytes: integer('egress_bytes').notNull().default(0),
  storageLimitBytes: integer('storage_limit_bytes'),
  bandwidthLimitBps: integer('bandwidth_limit_bps'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
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
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
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
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
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
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

export const edgeNodes = sqliteTable('identity_edge_node', {
  id: text('id').primaryKey(),
  ownerAccountId: text('owner_account_id'),     // Owner of the node
  displayName: text('display_name'),
  tokenHash: text('token_hash').notNull(),
  nodeType: text('node_type').default('edge'),  // 'center' | 'edge'
  subdomain: text('subdomain').unique(),
  accessMode: text('access_mode'),
  publicIp: text('public_ip'),
  publicPort: integer('public_port'),
  internalIp: text('internal_ip'),              // Internal network IP for center nodes
  internalPort: integer('internal_port'),
  capabilities: text('capabilities', { mode: 'json' }),
  metadata: text('metadata', { mode: 'json' }),
  connectivityStatus: text('connectivity_status').default('unknown'),
  lastConnectivityCheck: integer('last_connectivity_check', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  lastSeen: integer('last_seen', { mode: 'timestamp' }),
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
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});
