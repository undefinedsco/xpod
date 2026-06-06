-- PostgreSQL 初始化脚本 for XPod 测试环境
-- 创建 Identity 相关的表

-- Cloud cluster Nodes 表
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
    capabilities JSONB,
    metadata JSONB,
    pod_base_urls TEXT,
    connectivity_status TEXT DEFAULT 'unknown',
    last_connectivity_check TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMP WITH TIME ZONE
);

-- Cloud cluster DDNS Records 表
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
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Usage 表：account/pod 通过 scope_type + scope_id 区分，不拆分成多张表
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
    period_start TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (scope_type, scope_id)
);

-- Cloud cluster Service Token 表
CREATE TABLE IF NOT EXISTS cluster_service_token (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    service_type TEXT NOT NULL,
    service_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_cluster_node_subdomain ON cluster_node(subdomain);
CREATE INDEX IF NOT EXISTS idx_cluster_ddns_record_domain ON cluster_ddns_record(domain);
CREATE INDEX IF NOT EXISTS idx_cluster_ddns_record_node ON cluster_ddns_record(node_id);
CREATE INDEX IF NOT EXISTS idx_usage_account_id ON identity_usage(account_id);
