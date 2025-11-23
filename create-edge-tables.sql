-- Create edge node tables manually
CREATE TABLE IF NOT EXISTS identity_edge_node (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    token_hash TEXT NOT NULL,
    subdomain TEXT UNIQUE,
    access_mode TEXT,
    public_ip TEXT,
    public_port BIGINT,
    capabilities JSONB,
    metadata JSONB,
    connectivity_status TEXT DEFAULT 'unknown',
    last_connectivity_check TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS identity_edge_node_pod (
    node_id TEXT NOT NULL REFERENCES identity_edge_node(id) ON DELETE CASCADE,
    base_url TEXT NOT NULL
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_edge_node_subdomain ON identity_edge_node(subdomain);
CREATE INDEX IF NOT EXISTS idx_edge_node_access_mode ON identity_edge_node(access_mode);
CREATE INDEX IF NOT EXISTS idx_edge_node_connectivity_status ON identity_edge_node(connectivity_status);
CREATE INDEX IF NOT EXISTS idx_edge_node_pod_node_id ON identity_edge_node_pod(node_id);

SELECT 'Edge node tables created successfully';