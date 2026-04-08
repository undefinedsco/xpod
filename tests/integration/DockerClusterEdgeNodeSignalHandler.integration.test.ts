import { beforeAll, describe, it, expect } from 'vitest';
import { getConfiguredAccount, loginWithClientCredentials } from './helpers/solidAccount';

const RUN_INTEGRATION_TESTS = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const suite = RUN_INTEGRATION_TESTS ? describe : describe.skip;

const STANDALONE_BASE = (process.env.CSS_BASE_URL || `http://localhost:${process.env.STANDALONE_PORT || '5739'}`).replace(/\/$/, '');

suite('EdgeNodeSignalHandler Integration', () => {
  let authFetch: typeof fetch;
  let createdNodeId: string;
  let createdNodeToken: string;

  const baseUrl = `${STANDALONE_BASE}/`;

  beforeAll(async () => {
    const account = getConfiguredAccount(STANDALONE_BASE);
    if (!account) {
      throw new Error(`Missing integration credentials for ${STANDALONE_BASE}`);
    }

    const session = await loginWithClientCredentials(account);
    authFetch = session.fetch.bind(session) as typeof fetch;
  }, 30_000);

  it('should register a node to signal against', async () => {
    const response = await fetch(`${baseUrl}provision/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicUrl: 'https://integration-signal.invalid',
        nodeId: `integration-signal-${Date.now()}`,
        displayName: 'Integration Test Node',
      }),
    });

    expect(response.status).toBe(201);
    const data = await response.json() as { nodeId: string; nodeToken: string };
    expect(data.nodeId).toBeDefined();
    expect(data.nodeToken).toBeDefined();

    createdNodeId = data.nodeId;
    createdNodeToken = data.nodeToken;
  });

  it('should accept signal from nodeToken-authenticated node and update metadata', async () => {
    const response = await fetch(`${baseUrl}v1/signal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `XpodNode ${createdNodeId}:${createdNodeToken}`,
      },
      body: JSON.stringify({
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

  it('should return 501 for WebID-based signaling while node management is downlined', async () => {
    const response = await authFetch(`${baseUrl}v1/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: createdNodeId, status: 'online' }),
    });

    expect(response.status).toBe(501);
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
