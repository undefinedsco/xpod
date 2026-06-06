-- PostgreSQL Schema Definition
-- Unified with SQLite: uses BIGINT for timestamps (Unix epoch), TEXT for JSON

-- Usage
CREATE TABLE IF NOT EXISTS identity_usage (
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  storage_bytes BIGINT NOT NULL DEFAULT 0,
  ingress_bytes BIGINT NOT NULL DEFAULT 0,
  egress_bytes BIGINT NOT NULL DEFAULT 0,
  storage_limit_bytes BIGINT,
  bandwidth_limit_bps BIGINT,
  compute_seconds BIGINT NOT NULL DEFAULT 0,
  tokens_used BIGINT NOT NULL DEFAULT 0,
  compute_limit_seconds BIGINT,
  token_limit_monthly BIGINT,
  period_start BIGINT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (scope_type, scope_id)
);

-- Cloud cluster DDNS Records
CREATE TABLE IF NOT EXISTS cluster_ddns_record (
  subdomain TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  ip_address TEXT,
  ipv6_address TEXT,
  record_type TEXT DEFAULT 'A',
  node_id TEXT,
  username TEXT,
  status TEXT DEFAULT 'active',
  banned_reason TEXT,
  ttl INTEGER DEFAULT 60,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

-- Edge Nodes
CREATE TABLE IF NOT EXISTS cluster_node (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  token_hash TEXT NOT NULL,
  node_type TEXT DEFAULT 'edge',
  subdomain TEXT UNIQUE,
  access_mode TEXT,
  ipv4 TEXT,
  public_port BIGINT,
  public_url TEXT,
  service_token_hash TEXT,
  provision_code_hash TEXT,
  internal_ip TEXT,
  internal_port BIGINT,
  hostname TEXT,
  ipv6 TEXT,
  version TEXT,
  capabilities TEXT,
  metadata TEXT,
  pod_base_urls TEXT,
  connectivity_status TEXT DEFAULT 'unknown',
  last_connectivity_check BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_seen BIGINT
);

-- Cloud cluster Service Tokens
CREATE TABLE IF NOT EXISTS cluster_service_token (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  service_type TEXT NOT NULL,
  service_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT
);
