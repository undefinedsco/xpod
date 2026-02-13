import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

// Make test runs deterministic:
// - If .env.local exists, load it.
// - For integration runs, let .env.local override ambient env vars.
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
