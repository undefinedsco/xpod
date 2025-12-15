import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { jsonb } from 'drizzle-orm/pg-core/columns/jsonb';
import { bigint as pgBigint } from 'drizzle-orm/pg-core/columns/bigint';

export const accountUsage = pgTable('identity_account_usage', {
  accountId: text('account_id').primaryKey(),
  storageBytes: pgBigint('storage_bytes', { mode: 'number' }).notNull().default(0),
  ingressBytes: pgBigint('ingress_bytes', { mode: 'number' }).notNull().default(0),
  egressBytes: pgBigint('egress_bytes', { mode: 'number' }).notNull().default(0),
  storageLimitBytes: pgBigint('storage_limit_bytes', { mode: 'number' }),
  bandwidthLimitBps: pgBigint('bandwidth_limit_bps', { mode: 'number' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const podUsage = pgTable('identity_pod_usage', {
  podId: text('pod_id').primaryKey(),
  accountId: text('account_id').notNull(),
  storageBytes: pgBigint('storage_bytes', { mode: 'number' }).notNull().default(0),
  ingressBytes: pgBigint('ingress_bytes', { mode: 'number' }).notNull().default(0),
  egressBytes: pgBigint('egress_bytes', { mode: 'number' }).notNull().default(0),
  storageLimitBytes: pgBigint('storage_limit_bytes', { mode: 'number' }),
  bandwidthLimitBps: pgBigint('bandwidth_limit_bps', { mode: 'number' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});


export const edgeNodes = pgTable('identity_edge_node', {
  id: text('id').primaryKey(),
  displayName: text('display_name'),
  tokenHash: text('token_hash').notNull(),
  nodeType: text('node_type').default('edge'),  // 'center' | 'edge'
  subdomain: text('subdomain').unique(),
  accessMode: text('access_mode'),
  publicIp: text('public_ip'),
  publicPort: pgBigint('public_port', { mode: 'number' }),
  internalIp: text('internal_ip'),              // Internal network IP
  internalPort: pgBigint('internal_port', { mode: 'number' }),
  capabilities: jsonb('capabilities'),
  metadata: jsonb('metadata'),
  connectivityStatus: text('connectivity_status').default('unknown'),
  lastConnectivityCheck: timestamp('last_connectivity_check', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp('last_seen', { withTimezone: true }),
});

export const edgeNodePods = pgTable('identity_edge_node_pod', {
  nodeId: text('node_id').notNull().references(() => edgeNodes.id, { onDelete: 'cascade' }),
  baseUrl: text('base_url').notNull(),
});
