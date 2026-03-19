import { beforeAll, describe, it, expect } from 'vitest';
import { getConfiguredAccount, loginWithClientCredentials } from './helpers/solidAccount';

const RUN_INTEGRATION_TESTS = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const suite = RUN_INTEGRATION_TESTS ? describe : describe.skip;

const STANDALONE_BASE = (process.env.CSS_BASE_URL || `http://localhost:${process.env.STANDALONE_PORT || '5739'}`).replace(/\/$/, '');

suite('EdgeNodeSignalHandler Integration', () => {
  let authFetch: typeof fetch;
  let createdNodeId: string;

  const baseUrl = `${STANDALONE_BASE}/`;

  beforeAll(async () => {
    const account = getConfiguredAccount(STANDALONE_BASE);
    if (!account) {
      throw new Error(`Missing integration credentials for ${STANDALONE_BASE}`);
    }

    const session = await loginWithClientCredentials(account);
    authFetch = session.fetch.bind(session) as typeof fetch;
  }, 30_000);

  it('should create a new node to signal against', async () => {
    const response = await authFetch(`${baseUrl}v1/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Integration Test Node' }),
    });

    expect(response.status).toBe(201);
    const data = await response.json() as { success: boolean; nodeId: string };
    expect(data.success).toBe(true);
    expect(data.nodeId).toBeDefined();

    createdNodeId = data.nodeId;
  });

  it('should accept signal from registered node and update metadata', async () => {
    const response = await authFetch(`${baseUrl}v1/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: createdNodeId,
        version: '1.0.0',
        status: 'online',
        pods: ['https://pod1.example.com/', 'https://pod2.example.com/'],
      }),
    });

    if (response.status !== 200) {
      const errorData = await response.json();
      console.error(`Signal request failed with status ${response.status}:`, errorData);
    }

    expect(response.status).toBe(200);
    const data = await response.json() as {
      status: string;
      nodeId: string;
      metadata: { status?: string; version?: string };
    };

    expect(data.status).toBe('ok');
    expect(data.nodeId).toBe(createdNodeId);
    if (data.metadata?.status) expect(data.metadata.status).toBe('online');
    expect(data.metadata?.version).toBe('1.0.0');
  });

  it('should verify node status via GET /v1/nodes/:id', async () => {
    const response = await authFetch(`${baseUrl}v1/nodes/${createdNodeId}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    expect(response.status).toBe(200);
    const data = await response.json() as {
      nodeId: string;
      metadata?: { status?: string };
      lastSeen?: string;
    };

    expect(data.nodeId).toBe(createdNodeId);
    if (data.metadata?.status) expect(data.metadata.status).toBe('online');
    expect(data.lastSeen).toBeDefined();
  });

  it('should return 403/404 when signaling a non-owned or missing node', async () => {
    const randomId = '00000000-0000-0000-0000-000000000000';
    const response = await authFetch(`${baseUrl}v1/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: randomId, status: 'online' }),
    });

    expect([403, 404]).toContain(response.status);
  });

  it('should return 400 for invalid request body', async () => {
    const response = await authFetch(`${baseUrl}v1/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'online' }),
    });

    expect(response.status).toBe(400);
  });
});
