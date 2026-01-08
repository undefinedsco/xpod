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
