import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { nodeRuntimeDriver } from '../../src/runtime/driver/node/NodeRuntimeDriver';
import { XpodTestStack } from './XpodTestStack';
import { setupAccount } from '../integration/helpers/solidAccount';
import { getFreePort } from '../../src/runtime/port-finder';
import { deriveRefreshConfig, refreshPolicy } from './browserRefreshPolicy';

if (Object.prototype.hasOwnProperty.call(process.env, 'XPOD_E2E_REFRESH_MANIFEST')) {
  throw new Error('External deployment must not start the source refresh fixture');
}

const mode = process.argv[2];
if (mode !== 'renew' && mode !== 'expire') throw new Error('Expected renew or expire fixture mode');
const root = path.resolve('.test-data/browser-session-refresh', randomUUID());
const { accessTokenTtl, refreshTokenTtl } = refreshPolicy(mode);
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
        const derived = deriveRefreshConfig(readFileSync(copiedPath, 'utf8'), mode);
        writeFileSync(copiedPath, derived.config);
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
