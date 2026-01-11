import { beforeAll, describe, it, expect } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { Session } from '@inrupt/solid-client-authn-node';

loadEnv({ path: process.env.SOLID_ENV_FILE ?? '.env.local' });

const baseUrl = process.env.XPOD_SERVER_BASE_URL ?? 'http://localhost:3000/';
const clientId = process.env.SOLID_CLIENT_ID;
const clientSecret = process.env.SOLID_CLIENT_SECRET;
const oidcIssuer = process.env.SOLID_OIDC_ISSUER ?? baseUrl;

// Ensure we have necessary credentials and the flag is set
const shouldRunIntegration = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true' && !!clientId && !!clientSecret;
const suite = shouldRunIntegration ? describe : describe.skip;

// TODO: Skip signal tests for now
describe.skip('SignalHandler Integration', () => {
  let session: Session;
  let authFetch: typeof fetch;
  let createdNodeId: string;

  beforeAll(async () => {
    // 1. Check if server is reachable
    try {
      // Use v1/nodes as a probe, expecting 401 or 200
      const probe = await fetch(`${baseUrl}v1/nodes`, { method: 'GET' });
      if (probe.status === 404) {
         // Maybe API is under /api/v1/ or different port?
         // But based on config/local.json, it seems to be proxied.
         // Just proceed, the login will fail if issuer is unreachable.
      }
    } catch (error) {
       const message = error instanceof Error ? error.message : String(error);
       console.warn(`Server check failed at ${baseUrl}: ${message}`);
       // We don't throw here to let Vitest report the failure in the test if desired, 
       // but strictly we should probably throw.
    }

    // 2. Login as a user
    session = new Session();
    await session.login({
      clientId: clientId!,
      clientSecret: clientSecret!,
      oidcIssuer,
      // DPoP is default for recent CSS versions
    });
    
    if (!session.info.isLoggedIn) {
      throw new Error('Failed to login to Solid server');
    }
    
    authFetch = session.fetch.bind(session);
  });

  it('should create a new node to signal against', async () => {
    const response = await authFetch(`${baseUrl}v1/nodes`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ 
        displayName: 'Integration Test Node' 
      })
    });

    if (response.status !== 201) {
      const err = await response.json();
      console.error('Create Node Error:', err);
    }
    expect(response.status).toBe(201);
    const data = await response.json() as any;
    expect(data.success).toBe(true);
    expect(data.nodeId).toBeDefined();
    
    createdNodeId = data.nodeId;
  });

  it('should accept signal from registered node and update metadata', async () => {
    expect(createdNodeId).toBeDefined();

    const response = await authFetch(`${baseUrl}v1/signal`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        nodeId: createdNodeId,
        version: '1.0.0',
        status: 'online',
        pods: ['https://pod1.example.com/', 'https://pod2.example.com/']
      })
    });

    expect(response.status).toBe(200);
    const data = await response.json() as any;
    
    expect(data.status).toBe('ok');
    expect(data.nodeId).toBe(createdNodeId);
    
    // Verify metadata reflected in response
    expect(data.metadata).toBeDefined();
    expect(data.metadata.status).toBe('online');
    expect(data.metadata.version).toBe('1.0.0');
  });

  it('should verify node status via GET /v1/nodes/:id', async () => {
    expect(createdNodeId).toBeDefined();

    const response = await authFetch(`${baseUrl}v1/nodes/${createdNodeId}`, {
      method: 'GET',
      headers: { 
        'Accept': 'application/json'
      }
    });

    expect(response.status).toBe(200);
    const data = await response.json() as any;
    
    expect(data.nodeId).toBe(createdNodeId);
    expect(data.metadata).toBeDefined();
    expect(data.metadata.status).toBe('online');
    expect(data.lastSeen).toBeDefined();
  });

  it('should return 403 when trying to signal for a non-owned node (simulated)', async () => {
    // Note: In a real environment, we can't easily switch users without logging out/in.
    // So we'll try to signal for a random ID, which should return 404 (Node not found)
    // or 403 if we happened to guess a valid ID of another user (unlikely).
    // The previous mocked test tested 403 explicitly.
    // Here we can test "Node not found" or create a second user (complex).
    
    const randomId = '00000000-0000-0000-0000-000000000000';
    const response = await authFetch(`${baseUrl}v1/signal`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        nodeId: randomId,
        status: 'online'
      })
    });

    // 404 is expected because randomId doesn't exist in DB
    expect([403, 404]).toContain(response.status);
  });

  it('should return 400 for invalid request body', async () => {
    const response = await authFetch(`${baseUrl}v1/signal`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        // Missing nodeId
        status: 'online'
      })
    });

    expect(response.status).toBe(400);
  });
});