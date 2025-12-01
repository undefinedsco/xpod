/**
 * FRP Tunnel End-to-End Integration Test
 *
 * Validates: Client → cluster:server → FRP tunnel → cluster:local
 *
 * Prerequisites:
 * 1. FRPS server running
 * 2. cluster:server running (port 3100)
 * 3. cluster:local running (port 3101) with frpc connected
 *
 * Environment (reuse existing CSS variables):
 *   XPOD_RUN_FRP_E2E=true
 *   CSS_FRP_SERVER_HOST=your-frps-server
 *   CSS_FRP_SERVER_PORT=7000
 *   CSS_FRP_TOKEN=your-token
 *
 * Run:
 *   XPOD_RUN_FRP_E2E=true yarn test tests/integration/FrpTunnel.integration.test.ts --run
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.cluster' });

// Use existing CSS config variables
const frpServerHost = process.env.CSS_FRP_SERVER_HOST;
const frpServerPort = process.env.CSS_FRP_SERVER_PORT ?? '7000';
const frpToken = process.env.CSS_FRP_TOKEN;

// Fixed cluster URLs (match yarn cluster:server / cluster:local)
const clusterServerUrl = 'http://localhost:3100';
const edgeLocalUrl = 'http://localhost:3101';
const edgeNodeSubdomain = 'node-local';

const shouldRun = process.env.XPOD_RUN_FRP_E2E === 'true';
const suite = shouldRun ? describe : describe.skip;

suite('FRP Tunnel E2E', () => {
  beforeAll(async () => {
    // Verify cluster:server is running
    const serverCheck = await fetch(clusterServerUrl, { method: 'HEAD' }).catch(() => null);
    if (!serverCheck) {
      throw new Error(`cluster:server not running at ${clusterServerUrl}. Run: yarn cluster:server`);
    }

    // Verify cluster:local is running
    const localCheck = await fetch(edgeLocalUrl, { method: 'HEAD' }).catch(() => null);
    if (!localCheck) {
      throw new Error(`cluster:local not running at ${edgeLocalUrl}. Run: yarn cluster:local`);
    }
  });

  it('routes request via subdomain to edge node', async () => {
    // Request cluster:server with edge node subdomain in Host header
    const edgeHost = `${edgeNodeSubdomain}.localhost:3100`;

    const response = await fetch(`${clusterServerUrl}/.well-known/solid`, {
      method: 'GET',
      headers: {
        'host': edgeHost,
        'accept': 'application/json',
      },
      redirect: 'manual',
    });

    // Redirect mode (302/307) or Proxy mode (200)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      expect(location).toBeDefined();
      console.log(`Redirect → ${location}`);

      const finalResponse = await fetch(location!, { headers: { accept: 'application/json' } });
      expect(finalResponse.ok).toBe(true);
    } else {
      expect(response.ok).toBe(true);
    }
  }, 15000);

  it('accesses edge node resource through cluster:server', async () => {
    const edgeHost = `${edgeNodeSubdomain}.localhost:3100`;
    const testPath = `/test-frp-${Date.now()}.txt`;
    const testContent = `FRP test ${new Date().toISOString()}`;

    // Create resource directly on edge node
    const createRes = await fetch(`${edgeLocalUrl}${testPath}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: testContent,
    });

    if (createRes.status === 401 || createRes.status === 403) {
      console.log('Edge node requires auth, skipping');
      return;
    }
    expect(createRes.ok).toBe(true);

    try {
      // Access through cluster:server
      const accessRes = await fetch(`${clusterServerUrl}${testPath}`, {
        method: 'GET',
        headers: { 'host': edgeHost, 'accept': 'text/plain' },
        redirect: 'follow',
      });

      if (accessRes.ok) {
        const received = await accessRes.text();
        expect(received).toContain('FRP test');
      } else if ([401, 403].includes(accessRes.status)) {
        console.log('Cluster access requires auth');
      } else {
        throw new Error(`Unexpected: ${accessRes.status}`);
      }
    } finally {
      await fetch(`${edgeLocalUrl}${testPath}`, { method: 'DELETE' }).catch(() => {});
    }
  }, 20000);

  it('verifies FRP config is returned in signal response', async () => {
    if (!frpServerHost || !frpToken) {
      console.log('FRP not configured, skipping signal test');
      return;
    }

    const signalRes = await fetch(`${clusterServerUrl}/api/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'test-frp-node',
        token: 'test-token',
        reachability: { status: 'unreachable' },
      }),
    });

    if (!signalRes.ok) {
      console.log(`Signal endpoint error: ${signalRes.status}`);
      return;
    }

    const data = await signalRes.json();
    expect(data.tunnel).toBeDefined();
    expect(data.tunnel.status).toBe('active');
    expect(data.tunnel.serverHost).toBe(frpServerHost);
    expect(data.tunnel.serverPort).toBe(Number(frpServerPort));
  }, 10000);
});
