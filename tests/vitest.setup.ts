import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';
import '../src/runtime/configure-drizzle-solid';
import { registerSocketOriginShims } from '../src/runtime/socket-shim';

// Make test runs deterministic:
// - If .env.local exists, load it.
// - Keep explicit process env (e.g. CSS_BASE_URL from integration launcher) as highest priority.
const envPath = path.resolve(process.cwd(), '.env.local');
const isIntegrationRun = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';

if (!fs.existsSync(envPath)) {
  if (isIntegrationRun) {
    throw new Error(
      'XPOD_RUN_INTEGRATION_TESTS=true but .env.local is missing at: ' +
        envPath +
        '. Run yarn test:setup (or yarn test:integration) to generate credentials first.',
    );
  }
} else {
  dotenv.config({ path: envPath, override: isIntegrationRun });
}

const socketOriginMapRaw = process.env.XPOD_SOCKET_ORIGIN_MAP;
if (isIntegrationRun && socketOriginMapRaw) {
  const socketOriginMap = JSON.parse(socketOriginMapRaw) as Record<string, string>;
  for (const [origin, socketPath] of Object.entries(socketOriginMap)) {
    if (!origin || !socketPath) {
      continue;
    }
    registerSocketOriginShims(origin, socketPath);
  }
} else {
  const socketPath = process.env.XPOD_GATEWAY_SOCKET_PATH;
  const socketBaseUrl = process.env.CSS_BASE_URL;
  if (isIntegrationRun && socketPath && socketBaseUrl) {
    registerSocketOriginShims(socketBaseUrl, socketPath);
  }
}
