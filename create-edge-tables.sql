-- Create edge node tables manually
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
    last_connectivity_check TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_cluster_node_subdomain ON cluster_node(subdomain);
CREATE INDEX IF NOT EXISTS idx_cluster_node_access_mode ON cluster_node(access_mode);
CREATE INDEX IF NOT EXISTS idx_cluster_node_connectivity_status ON cluster_node(connectivity_status);

SELECT 'Edge node tables created successfully';
