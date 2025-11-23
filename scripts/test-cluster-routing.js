#!/usr/bin/env node

/**
 * Basic routing check between a running cluster server (port 3100 by default)
 * and a local edge node instance (port 3101).
 *
 * Usage:
 *   CSS_IDENTITY_DB_URL=... XPOD_NODE_ID=... XPOD_NODE_TOKEN=... node scripts/test-cluster-routing.js
 */

const { Client } = require('pg');
const { createHash } = require('crypto');
const http = require('node:http');
const https = require('node:https');

const clusterBaseUrl = process.env.XPOD_CLUSTER_BASE_URL ?? 'http://localhost:3100';
// For test purposes we always report the local service at 3101 as the entrypoint.
const localBaseUrl = 'http://node-local.localhost:3101/';
const signalEndpoint = process.env.XPOD_SIGNAL_ENDPOINT ?? `${clusterBaseUrl.replace(/\/$/u, '')}/api/signal`;
const clusterUrl = new URL(clusterBaseUrl);
const clusterHttpModule = clusterUrl.protocol === 'https:' ? https : http;

const nodeId = process.env.XPOD_NODE_ID;
const nodeToken = process.env.XPOD_NODE_TOKEN;
const nodeHost = process.env.XPOD_NODE_HOST ?? (nodeId ? `${nodeId}.localhost` : undefined);
const connectionString = process.env.CSS_IDENTITY_DB_URL;
const supportedModesEnv = process.env.XPOD_SUPPORTED_MODES ?
  process.env.XPOD_SUPPORTED_MODES.split(',').map((mode) => mode.trim().toLowerCase()).filter(Boolean) :
  undefined;
const capabilityStrings = (supportedModesEnv && supportedModesEnv.length > 0 ?
  supportedModesEnv.map((mode) => mode.startsWith('mode:') ? mode : `mode:${mode}`) :
  [ 'mode:redirect', 'mode:proxy' ]);
const localPort = process.env.XPOD_LOCAL_PORT ?? (localBaseUrl.startsWith('http://localhost:') ? Number(new URL(localBaseUrl).port || '80') : undefined);

if (!nodeId || !nodeToken || !connectionString) {
  console.error('Missing XPOD_NODE_ID, XPOD_NODE_TOKEN, or CSS_IDENTITY_DB_URL.');
  process.exit(1);
}

(async () => {
  const db = new Client({ connectionString });
  await db.connect();
  const now = new Date();
  const tokenHash = createHash('sha256').update(nodeToken).digest('hex');
  await db.query(`
    INSERT INTO identity_edge_node (id, token_hash, created_at, updated_at)
    VALUES ($1, $2, $3, $3)
    ON CONFLICT (id)
    DO UPDATE SET token_hash = EXCLUDED.token_hash,
                  updated_at = EXCLUDED.updated_at
  `, [ nodeId, tokenHash, now ]);
  await db.end();

  const heartbeatPayload = {
    nodeId,
    token: nodeToken,
    publicAddress: localBaseUrl,
    ipv4: '127.0.0.1',
    status: 'active',
    capabilities: capabilityStrings,
    tunnel: {
      status: 'active',
      entrypoint: localBaseUrl,
    },
    metadata: {
      publicAddress: localBaseUrl,
      subdomain: nodeHost,
    },
  };

  const response = await fetch(signalEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(heartbeatPayload),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('Heartbeat error:', response.status, err);
    process.exit(1);
  }

  console.log(await response.text());

  if (nodeHost) {
    const db2 = new Client({ connectionString });
    await db2.connect();
    await db2.query('UPDATE identity_edge_node SET subdomain = $2 WHERE id = $1', [ nodeId, nodeHost ]);
    await db2.end();
  }

  // Request cluster endpoint with custom Host header
  const clusterResponse = await new Promise((resolve, reject) => {
    const req = clusterHttpModule.request({
      hostname: clusterUrl.hostname,
      port: clusterUrl.port || (clusterUrl.protocol === 'https:' ? 443 : 80),
      path: '/',
      method: 'GET',
      headers: { Host: nodeHost },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });

  console.log('Cluster response status:', clusterResponse.status);
  console.log('X-Xpod-Proxy-Node:', clusterResponse.headers['x-xpod-proxy-node']);
})();
