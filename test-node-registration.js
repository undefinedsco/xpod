#!/usr/bin/env node
/**
 * Test script for node registration with actual database access
 */

const { randomBytes, createHash } = require('node:crypto');
const { Client } = require('pg');

const connectionString =
  process.env.CSS_IDENTITY_DB_URL ||
  process.env.IDENTITY_DB_URL ||
  'postgresql://postgres:f5xzqbpt@dbconn.sealosgzg.site:47435/?directConnection=true';

const signalEndpoint =
  process.env.XPOD_SIGNAL_ENDPOINT ||
  process.env.SIGNAL_ENDPOINT ||
  'http://localhost:3100/api/signal';

const fixedNodeId = process.env.XPOD_NODE_ID;
const fixedNodeToken = process.env.XPOD_NODE_TOKEN;
const nodeDisplayName = process.env.NODE_DISPLAY_NAME || 'Local Test Node';
const nodePublicAddress = process.env.XPOD_NODE_PUBLIC_ADDRESS || 'http://localhost:3101/';

async function createTestNode() {
  const client = new Client({ connectionString });

  try {
    await client.connect();
    console.log('Connected to database');

    // Generate test node credentials
    const nodeId = fixedNodeId ?? `test-node-${Math.random().toString(36).substring(7)}`;
    const token = fixedNodeToken ?? randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = new Date();

    const result = await client.query(
      `
      INSERT INTO identity_edge_node (id, display_name, token_hash, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id)
      DO UPDATE SET
        display_name = EXCLUDED.display_name,
        token_hash = EXCLUDED.token_hash,
        updated_at = EXCLUDED.updated_at
      RETURNING *
    `,
      [ nodeId, nodeDisplayName, tokenHash, now, now ],
    );

    console.log('Test node created:', {
      nodeId: result.rows[0].id,
      token: token,
      displayName: result.rows[0].display_name,
      createdAt: result.rows[0].created_at
    });

    // Now test the signal API with the created credentials
    const signalPayload = {
      nodeId: result.rows[0].id,
      token,
      publicAddress: nodePublicAddress,
      ipv4: '127.0.0.1',
      status: 'active',
      capabilities: [ 'solid-1.0', 'http-basic' ],
      version: '1.0.0',
    };

    console.log('\nTesting signal API with:');
    console.log(JSON.stringify({ ...signalPayload, token: '[redacted]' }, null, 2));

    const response = await fetch(signalEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(signalPayload),
    });

    console.log(`\nSignal API Response: ${response.status} ${response.statusText}`);
    if (!response.ok) {
      const errorText = await response.text();
      console.log('Error response:', errorText);
    } else {
      const responseData = await response.json();
      console.log('Success response:', JSON.stringify(responseData, null, 2));
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
  }
}

createTestNode();
