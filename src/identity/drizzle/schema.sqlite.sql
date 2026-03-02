-- SQLite Schema Definition
-- Unified with PostgreSQL: uses INTEGER for timestamps (Unix epoch), TEXT for JSON

-- Account Usage
CREATE TABLE IF NOT EXISTS identity_account_usage (
  account_id TEXT PRIMARY KEY,
  storage_bytes INTEGER NOT NULL DEFAULT 0,
  ingress_bytes INTEGER NOT NULL DEFAULT 0,
  egress_bytes INTEGER NOT NULL DEFAULT 0,
  storage_limit_bytes INTEGER,
  bandwidth_limit_bps INTEGER,
  compute_seconds INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  compute_limit_seconds INTEGER,
  token_limit_monthly INTEGER,
  period_start INTEGER,
  updated_at INTEGER NOT NULL
);

-- Pod Usage
CREATE TABLE IF NOT EXISTS identity_pod_usage (
  pod_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  storage_bytes INTEGER NOT NULL DEFAULT 0,
  ingress_bytes INTEGER NOT NULL DEFAULT 0,
  egress_bytes INTEGER NOT NULL DEFAULT 0,
  storage_limit_bytes INTEGER,
  bandwidth_limit_bps INTEGER,
  compute_seconds INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  compute_limit_seconds INTEGER,
  token_limit_monthly INTEGER,
  period_start INTEGER,
  updated_at INTEGER NOT NULL
);

-- WebID Profile
CREATE TABLE IF NOT EXISTS identity_webid_profile (
  username TEXT PRIMARY KEY,
  webid_url TEXT NOT NULL,
  storage_url TEXT,
  storage_mode TEXT DEFAULT 'cloud',
  oidc_issuer TEXT,
  profile_data TEXT,
  account_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- DDNS Domains
CREATE TABLE IF NOT EXISTS identity_ddns_domain (
  domain TEXT PRIMARY KEY,
  status TEXT DEFAULT 'active',
  provider TEXT,
  zone_id TEXT,
  created_at INTEGER NOT NULL
);

-- DDNS Records
CREATE TABLE IF NOT EXISTS identity_ddns_record (
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Edge Nodes
CREATE TABLE IF NOT EXISTS identity_edge_node (
  id TEXT PRIMARY KEY,
  owner_account_id TEXT,
  display_name TEXT,
  token_hash TEXT NOT NULL,
  node_type TEXT DEFAULT 'edge',
  subdomain TEXT UNIQUE,
  access_mode TEXT,
  public_ip TEXT,
  public_port INTEGER,
  public_url TEXT,
  service_token_hash TEXT,
  provision_code_hash TEXT,
  internal_ip TEXT,
  internal_port INTEGER,
  hostname TEXT,
  ipv6 TEXT,
  version TEXT,
  capabilities TEXT,
  metadata TEXT,
  connectivity_status TEXT DEFAULT 'unknown',
  last_connectivity_check INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen INTEGER
);

-- Edge Node Pods
CREATE TABLE IF NOT EXISTS identity_edge_node_pod (
  node_id TEXT NOT NULL REFERENCES identity_edge_node(id) ON DELETE CASCADE,
  base_url TEXT NOT NULL
);

-- API Client Credentials
CREATE TABLE IF NOT EXISTS identity_api_client_credentials (
  client_id TEXT PRIMARY KEY,
  web_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL
);

-- Service Tokens
CREATE TABLE IF NOT EXISTS identity_service_token (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  service_type TEXT NOT NULL,
  service_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
