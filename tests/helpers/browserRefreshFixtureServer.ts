import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { nodeRuntimeDriver } from '../../src/runtime/driver/node/NodeRuntimeDriver';
import { XpodTestStack } from './XpodTestStack';
import { setupAccount } from '../integration/helpers/solidAccount';
import { getFreePort } from '../../src/runtime/port-finder';

const mode = process.argv[2];
if (mode !== 'renew' && mode !== 'expire') throw new Error('Expected renew or expire fixture mode');
const root = path.resolve('.test-data/browser-session-refresh', randomUUID());
const accessTokenTtl = 30;
const refreshTokenTtl = mode === 'expire' ? 5 : 180;
function applyTokenPolicy(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, any>;
  if (record.ttl?.AccessToken && record.ttl?.RefreshToken) {
    record.clockTolerance = 0;
    record.ttl = { ...record.ttl, AccessToken: accessTokenTtl, RefreshToken: refreshTokenTtl };
    return true;
  }
  // Components.js normalizes JSON config parameters into RDF JSON literals.
  if (typeof record['@value'] === 'string' && record['@type'] === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#JSON') {
    const literal = JSON.parse(record['@value']);
    if (applyTokenPolicy(literal)) {
      record['@value'] = JSON.stringify(literal);
      return true;
    }
  }
  return Object.values(record).some(applyTokenPolicy);
}
const stack = new XpodTestStack();
let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  return stopping ??= (async () => {
    try { await stack.stop(); } finally { await rm(root, { recursive: true, force: true }); }
  })();
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => { void stop().then(() => process.exit(0), () => process.exit(1)); });
}
try {
  await mkdir(root, { recursive: true });
  const port = await getFreePort(30_000 + Math.floor(Math.random() * 20_000));
  const baseUrl = `http://127.0.0.1:${port}/`;
  await stack.start('local', {
    transport: 'port', gatewayPort: port, baseUrl, runtimeRoot: root,
    open: false, apiOpen: false, envFile: undefined, logLevel: 'error',
    cssRunner: {
      name: 'short-lived-token-fixture',
      async start(options) {
        // Xpod generates this disposable config copy before invoking its runner.
        // Keep the existing provider config/keys intact; change only TTL policy.
        const copiedPath = path.join(root, 'config', 'main.json');
        const copiedConfig = JSON.parse(readFileSync(copiedPath, 'utf8'));
        if (!applyTokenPolicy(copiedConfig)) throw new Error('Missing IdP config in isolated runtime copy');
        writeFileSync(copiedPath, JSON.stringify(copiedConfig));
        return nodeRuntimeDriver.cssRunner.start(options);
      },
    },
    env: { SOLID_OIDC_ISSUER: baseUrl, XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND ?? '' },
  });
  const account = await setupAccount(stack.baseUrl, `refresh-${mode}`);
  if (!account?.email || !account.password || !account.webId || !account.podUrl) throw new Error('Fixture account setup failed');
  console.log(`XPOD_REFRESH_READY ${JSON.stringify({ baseUrl, account, accessTokenTtl, refreshTokenTtl })}`);
} catch (error) {
  console.error('XPOD_REFRESH_ERROR', error instanceof Error ? error.message : 'Fixture startup failed');
  await stop();
  process.exit(1);
}
