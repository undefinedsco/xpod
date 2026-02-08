-- PostgreSQL 初始化脚本 for XPod 测试环境
-- 创建 Identity 相关的表

-- API Client Credentials 表
CREATE TABLE IF NOT EXISTS identity_api_client_credentials (
    client_id TEXT PRIMARY KEY,
    client_secret_encrypted TEXT NOT NULL,
    web_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    display_name TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Edge Nodes 表
CREATE TABLE IF NOT EXISTS identity_edge_node (
    id TEXT PRIMARY KEY,
    owner_account_id TEXT,
    display_name TEXT,
    token_hash TEXT NOT NULL,
    node_type TEXT DEFAULT 'edge',
    subdomain TEXT UNIQUE,
    access_mode TEXT,
    public_ip TEXT,
    public_port BIGINT,
    internal_ip TEXT,
    internal_port BIGINT,
    capabilities JSONB,
    metadata JSONB,
    connectivity_status TEXT DEFAULT 'unknown',
    last_connectivity_check TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMP WITH TIME ZONE
);

-- Edge Node Pods 表
CREATE TABLE IF NOT EXISTS identity_edge_node_pod (
    node_id TEXT NOT NULL REFERENCES identity_edge_node(id) ON DELETE CASCADE,
    base_url TEXT NOT NULL
);

-- WebID Profiles 表
CREATE TABLE IF NOT EXISTS identity_webid_profile (
    username TEXT PRIMARY KEY,
    webid_url TEXT NOT NULL,
    storage_url TEXT,
    storage_mode TEXT DEFAULT 'cloud',
    oidc_issuer TEXT,
    profile_data JSONB,
    account_id TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- DDNS Domains 表
CREATE TABLE IF NOT EXISTS identity_ddns_domain (
    domain TEXT PRIMARY KEY,
    status TEXT DEFAULT 'active',
    provider TEXT,
    zone_id TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- DDNS Records 表
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
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Account Usage 表
CREATE TABLE IF NOT EXISTS identity_account_usage (
    account_id TEXT PRIMARY KEY,
    storage_bytes BIGINT NOT NULL DEFAULT 0,
    ingress_bytes BIGINT NOT NULL DEFAULT 0,
    egress_bytes BIGINT NOT NULL DEFAULT 0,
    storage_limit_bytes BIGINT,
    bandwidth_limit_bps BIGINT,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Pod Usage 表
CREATE TABLE IF NOT EXISTS identity_pod_usage (
    pod_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    storage_bytes BIGINT NOT NULL DEFAULT 0,
    ingress_bytes BIGINT NOT NULL DEFAULT 0,
    egress_bytes BIGINT NOT NULL DEFAULT 0,
    storage_limit_bytes BIGINT,
    bandwidth_limit_bps BIGINT,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_edge_node_owner ON identity_edge_node(owner_account_id);
CREATE INDEX IF NOT EXISTS idx_edge_node_subdomain ON identity_edge_node(subdomain);
CREATE INDEX IF NOT EXISTS idx_api_credentials_account ON identity_api_client_credentials(account_id);
CREATE INDEX IF NOT EXISTS idx_api_credentials_webid ON identity_api_client_credentials(web_id);
CREATE INDEX IF NOT EXISTS idx_ddns_record_domain ON identity_ddns_record(domain);
CREATE INDEX IF NOT EXISTS idx_ddns_record_node ON identity_ddns_record(node_id);
