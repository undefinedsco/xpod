#!/usr/bin/env npx ts-node
/**
 * Test script for API Server authentication
 * 
 * Usage:
 *   npx dotenv-cli -e .env.local -- npx ts-node scripts/test-api-server.ts
 */

import { Session } from '@inrupt/solid-client-authn-node';

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001';
const CSS_BASE = process.env.CSS_BASE_URL ?? 'http://localhost:3000/';
const clientId = process.env.SOLID_CLIENT_ID;
const clientSecret = process.env.SOLID_CLIENT_SECRET;
const oidcIssuer = process.env.SOLID_OIDC_ISSUER ?? CSS_BASE;

async function main() {
  console.log('=== API Server Test ===\n');

  // Test public endpoints
  console.log('1. Testing public endpoints...');
  
  const healthRes = await fetch(`${API_BASE}/health`);
  console.log(`   /health: ${healthRes.status} - ${await healthRes.text()}`);
  
  const readyRes = await fetch(`${API_BASE}/ready`);
  console.log(`   /ready: ${readyRes.status} - ${await readyRes.text()}`);

  // Test protected endpoint without auth
  console.log('\n2. Testing protected endpoint without auth...');
  const noAuthRes = await fetch(`${API_BASE}/v1/nodes`);
  console.log(`   /v1/nodes: ${noAuthRes.status} - ${await noAuthRes.text()}`);

  // Test with authentication
  if (!clientId || !clientSecret) {
    console.log('\n3. Skipping auth test - SOLID_CLIENT_ID or SOLID_CLIENT_SECRET not set');
    return;
  }

  console.log('\n3. Getting Solid token...');
  console.log(`   OIDC Issuer: ${oidcIssuer}`);
  console.log(`   Client ID: ${clientId.slice(0, 20)}...`);

  const session = new Session();
  try {
    await session.login({
      clientId,
      clientSecret,
      oidcIssuer,
      tokenType: 'DPoP',
      // @ts-ignore - timeout option
      timeout: 30000,
    });
    console.log(`   Login successful! WebID: ${session.info.webId}`);
  } catch (error) {
    console.error(`   Login failed: ${error}`);
    return;
  }

  // Test protected endpoint with auth - list nodes
  console.log('\n4. Testing /v1/nodes with auth...');
  const nodesRes = await session.fetch(`${API_BASE}/v1/nodes`);
  console.log(`   GET /v1/nodes: ${nodesRes.status}`);
  const nodesBody = await nodesRes.text();
  console.log(`   Response: ${nodesBody}`);

  // Test signal endpoint with auth
  console.log('\n5. Testing /v1/signal with auth...');
  const signalRes = await session.fetch(`${API_BASE}/v1/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: 'test-node' }),
  });
  console.log(`   POST /v1/signal: ${signalRes.status}`);
  console.log(`   Response: ${await signalRes.text()}`);

  // Test API keys endpoint
  console.log('\n6. Testing /v1/keys with auth...');
  const keysRes = await session.fetch(`${API_BASE}/v1/keys`);
  console.log(`   GET /v1/keys: ${keysRes.status}`);
  console.log(`   Response: ${await keysRes.text()}`);

  await session.logout();
  console.log('\n=== Test Complete ===');
}

main().catch(console.error);
