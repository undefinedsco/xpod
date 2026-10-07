import { XpodTestStack } from '../tests/helpers/XpodTestStack';
import { createFakeQleverRuntimeCommand } from '../tests/helpers/qleverRuntime';
import { spawn } from 'child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { normalizeDatabaseUrl } from '../src/runtime/database-url';

const TEST_SECRET_CELL_KEY = Buffer.alloc(32, 1).toString('base64');
const TEST_SECRET_CELL_PREVIOUS_KEYS = JSON.stringify({
  'previous-id': Buffer.alloc(32, 2).toString('base64'),
});
const TEST_GATEWAY_ENV = {
  XPOD_SECRET_CELL_KEY_ID: 'integration-lite',
  XPOD_SECRET_CELL_KEY: TEST_SECRET_CELL_KEY,
  XPOD_SECRET_CELL_PREVIOUS_KEYS: TEST_SECRET_CELL_PREVIOUS_KEYS,
};

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env,
    });

    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', reject);
  });
}

async function main() {
  const componentBuildExitCode = await runCommand('bun', [ 'run', 'build:components' ], process.env);
  if (componentBuildExitCode !== 0) {
    throw new Error(`Components.js metadata generation failed with exit code ${componentBuildExitCode}`);
  }

  const stack = new XpodTestStack();
  const qleverRuntimeFixture = createFakeQleverRuntimeCommand();
  // Direct-store acceptance uses the same real Pod registry as this Gateway, never a synthetic owner map.
  const identityDbPath = path.resolve('.test-data', 'integration', `lite-identity-${randomUUID()}.sqlite`);
  const identityDbUrl = normalizeDatabaseUrl(identityDbPath);
  let exitCode = 1;

  try {
    console.log('Starting xpod stack...');
    await mkdir(path.dirname(identityDbPath), { recursive: true });
    const liteRuntimeEnv = {
      ...TEST_GATEWAY_ENV,
      XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: qleverRuntimeFixture.command,
    };
    // Suites that verify authentication create their own strict stack. Keep
    // the shared fixture's established open-mode contract for other suites.
    await stack.start('local', { env: liteRuntimeEnv, transport: 'port', identityDbUrl });
    console.log(`Stack ready on ${stack.baseUrl}${stack.socketPath ? ` via ${stack.socketPath}` : ''}`);

    const sharedEnv = {
      ...process.env,
      ...liteRuntimeEnv,
      CSS_BASE_URL: stack.baseUrl,
      XPOD_GATEWAY_SOCKET_PATH: stack.socketPath ?? '',
      XPOD_RUN_INTEGRATION_TESTS: 'true',
      SOLID_ENV_FILE: path.resolve('.test-data', 'integration', 'lite.env'),
      XPOD_INTEGRATION_IDENTITY_DB_URL: identityDbUrl,
    };

    exitCode = await runCommand('bun', [ 'run', 'test:setup' ], sharedEnv);
    if (exitCode === 0) {
      exitCode = await runCommand('bun', [ 'run', 'vitest', '--run',
          ...(process.argv.length > 2 ? process.argv.slice(2) : [
            'tests/integration',
            'tests/http/ServerLogin.integration.test.ts',
            'tests/http/ServerApiAuth.integration.test.ts',
          ]),
          '--exclude', 'tests/integration/{DockerCluster,MultiNodeCluster,ProvisionFlow,CloudQuotaBusinessToken}*',
        ], sharedEnv);
    }
  } finally {
    await stack.stop();
    qleverRuntimeFixture.cleanup();
    await Promise.all([ identityDbPath, `${identityDbPath}-wal`, `${identityDbPath}-shm` ]
      .map(file => rm(file, { force: true })));
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
