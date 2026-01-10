#!/usr/bin/env npx ts-node
/**
 * E2E Test Script for API Server
 * 
 * Tests the full flow: API Server -> CSS Pod -> AI Service
 * 
 * Prerequisites:
 * 1. CSS running on localhost:3000
 * 2. API Server running on localhost:3001
 * 3. .env.local with SOLID_CLIENT_ID and SOLID_CLIENT_SECRET
 * 
 * Usage:
 *   npx ts-node scripts/test-api-e2e.ts
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env.local
config({ path: resolve(__dirname, '../.env.local') });

const CSS_BASE_URL = process.env.SOLID_OIDC_ISSUER || 'http://localhost:3000/';
const CLIENT_ID = process.env.SOLID_CLIENT_ID;
const CLIENT_SECRET = process.env.SOLID_CLIENT_SECRET;
const WEBID = process.env.SOLID_WEBID;
const API_SERVER_URL = process.env.API_SERVER_URL || 'http://localhost:3001';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing SOLID_CLIENT_ID or SOLID_CLIENT_SECRET in .env.local');
  process.exit(1);
}

console.log('=== API E2E Test ===');
console.log(`CSS Base URL: ${CSS_BASE_URL}`);
console.log(`API Server: ${API_SERVER_URL}`);
console.log(`Client ID: ${CLIENT_ID}`);
console.log(`WebID: ${WEBID}`);
console.log('');

async function getAccessToken(): Promise<string> {
  const tokenEndpoint = `${CSS_BASE_URL}.oidc/token`;
  console.log(`Getting access token from: ${tokenEndpoint}`);
  
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get token: ${response.status} ${text}`);
  }

  const data = await response.json() as any;
  console.log(`Got access token (expires in ${data.expires_in}s)`);
  return data.access_token;
}

async function storeApiKey(token: string): Promise<void> {
  console.log('\n--- Store API Key in API Server ---');
  
  const response = await fetch(`${API_SERVER_URL}/v1/keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      displayName: 'E2E Test Key',
    }),
  });

  console.log(`Status: ${response.status}`);
  const data = await response.json();
  console.log('Response:', JSON.stringify(data, null, 2));
}

async function listApiKeys(token: string): Promise<void> {
  console.log('\n--- List API Keys ---');
  
  const response = await fetch(`${API_SERVER_URL}/v1/keys`, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  console.log(`Status: ${response.status}`);
  const data = await response.json();
  console.log('Keys:', JSON.stringify(data, null, 2));
}

async function testListProviders(token: string) {
  console.log('\n--- Test: Read providers from Pod ---');
  
  const providersUrl = `${CSS_BASE_URL}test/settings/ai/providers.ttl`;
  console.log(`Fetching: ${providersUrl}`);
  
  const response = await fetch(providersUrl, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'text/turtle',
    },
  });

  if (response.ok) {
    const text = await response.text();
    console.log('Providers TTL:');
    console.log(text.slice(0, 800));
  } else {
    console.log(`Status: ${response.status} (might not exist yet)`);
  }
}

async function testListCredentials(token: string) {
  console.log('\n--- Test: Read credentials from Pod ---');
  
  const credentialsUrl = `${CSS_BASE_URL}test/settings/credentials.ttl`;
  console.log(`Fetching: ${credentialsUrl}`);
  
  const response = await fetch(credentialsUrl, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'text/turtle',
    },
  });

  if (response.ok) {
    const text = await response.text();
    console.log('Credentials TTL:');
    console.log(text.slice(0, 800));
  } else {
    console.log(`Status: ${response.status} (might not exist yet)`);
  }
}

async function testChatCompletion() {
  console.log('\n--- Test: Chat Completion via API Server ---');
  
  // API Server expects Bearer <client_id>, then looks up secret from DB
  const response = await fetch(`${API_SERVER_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CLIENT_ID}`,
    },
    body: JSON.stringify({
      model: 'gemini-2.0-flash',
      messages: [
        { role: 'user', content: 'Say "Hello from E2E test" in exactly 5 words.' }
      ],
    }),
  });

  console.log(`Status: ${response.status}`);
  const data = await response.json();
  console.log('Response:', JSON.stringify(data, null, 2));
  
  return response.status === 200;
}

async function testListModels() {
  console.log('\n--- Test: List Models via API Server ---');

  const response = await fetch(`${API_SERVER_URL}/v1/models`, {
    headers: {
      'Authorization': `Bearer ${CLIENT_ID}`,
    },
  });

  console.log(`Status: ${response.status}`);
  const data = await response.json();
  console.log('Models:', JSON.stringify(data, null, 2));
}

async function testVectorStatus() {
  console.log('\n--- Test: Vector Status via API Server ---');

  const response = await fetch(`${API_SERVER_URL}/v1/vectors/status`, {
    headers: {
      'Authorization': `Bearer ${CLIENT_ID}`,
    },
  });

  console.log(`Status: ${response.status}`);
  if (response.ok) {
    const data = await response.json();
    console.log('Vector Status:', JSON.stringify(data, null, 2));
    return true;
  } else {
    const text = await response.text();
    console.log('Error:', text);
    return false;
  }
}

async function testEmbeddings() {
  console.log('\n--- Test: Generate Embeddings via API Server ---');

  const response = await fetch(`${API_SERVER_URL}/v1/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CLIENT_ID}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-004',
      input: 'Hello, this is a test for embedding generation.',
    }),
  });

  console.log(`Status: ${response.status}`);
  if (response.ok) {
    const data = await response.json() as any;
    console.log('Embedding Response:');
    console.log(`  - Object: ${data.object}`);
    console.log(`  - Model: ${data.model}`);
    console.log(`  - Data count: ${data.data?.length}`);
    if (data.data?.[0]?.embedding) {
      console.log(`  - Embedding dimension: ${data.data[0].embedding.length}`);
      console.log(`  - First 5 values: [${data.data[0].embedding.slice(0, 5).join(', ')}...]`);
    }
    return true;
  } else {
    const text = await response.text();
    console.log('Error:', text);
    return false;
  }
}

async function testHealthCheck() {
  console.log('\n--- Test: Health Check ---');
  
  const response = await fetch(`${API_SERVER_URL}/health`);
  console.log(`Status: ${response.status}`);
  const data = await response.json();
  console.log('Health:', JSON.stringify(data, null, 2));
  return response.status === 200;
}

async function main() {
  try {
    // 0. Check API Server is running
    console.log('=== Checking API Server ===');
    try {
      const healthy = await testHealthCheck();
      if (!healthy) {
        console.error('API Server health check failed');
        process.exit(1);
      }
    } catch (error: any) {
      if (error.cause?.code === 'ECONNREFUSED') {
        console.error(`\nAPI Server not running at ${API_SERVER_URL}`);
        console.error('Start it with: yarn api');
        process.exit(1);
      }
      throw error;
    }

    // 1. Get access token from CSS
    const token = await getAccessToken();

    // 2. Store API Key in API Server (so it can be used for auth)
    await storeApiKey(token);
    await listApiKeys(token);

    // 3. Test reading Pod data directly
    await testListProviders(token);
    await testListCredentials(token);

    // 4. Test API Server endpoints using API Key auth
    console.log('\n=== Testing API Server with API Key ===');
    await testListModels();
    const chatSuccess = await testChatCompletion();

    // 5. Test Vector API endpoints
    console.log('\n=== Testing Vector API ===');
    const vectorStatusSuccess = await testVectorStatus();
    const embeddingsSuccess = await testEmbeddings();

    console.log('\n=== E2E Test Complete ===');
    console.log(`Chat API: ${chatSuccess ? 'PASS' : 'FAIL'}`);
    console.log(`Vector Status API: ${vectorStatusSuccess ? 'PASS' : 'FAIL'}`);
    console.log(`Embeddings API: ${embeddingsSuccess ? 'PASS' : 'FAIL'}`);

    const allPassed = chatSuccess && vectorStatusSuccess && embeddingsSuccess;
    process.exit(allPassed ? 0 : 1);
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

main();
