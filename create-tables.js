#!/usr/bin/env node

import pg from 'pg';
const { Client } = pg;

async function createTables() {
  const client = new Client({
    connectionString: "postgresql://postgres:f5xzqbpt@dbconn.sealosgzg.site:47435/?directConnection=true"
  });

  try {
    await client.connect();
    console.log('Connected to database');

    // Create edge node table
    await client.query(`
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
    `);
    console.log('Created identity_edge_node table');

    // Create edge node pods table
    await client.query(`
      CREATE TABLE IF NOT EXISTS identity_edge_node_pod (
          node_id TEXT NOT NULL REFERENCES identity_edge_node(id) ON DELETE CASCADE,
          base_url TEXT NOT NULL
      );
    `);
    console.log('Created identity_edge_node_pod table');

    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_edge_node_subdomain ON identity_edge_node(subdomain);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_edge_node_access_mode ON identity_edge_node(access_mode);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_edge_node_connectivity_status ON identity_edge_node(connectivity_status);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_edge_node_pod_node_id ON identity_edge_node_pod(node_id);
    `);
    console.log('Created indexes');

    console.log('All edge node tables created successfully');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
  }
}

createTables();