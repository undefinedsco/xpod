import { XpodTestStack } from '../tests/helpers/XpodTestStack';
import { createFakeQleverRuntimeCommand } from '../tests/helpers/qleverRuntime';
import { spawn } from 'child_process';

const TEST_GATEWAY_ENV = {
  XPOD_GATEWAY_LOCATOR_KEY_ID: 'integration-lite',
  XPOD_GATEWAY_LOCATOR_SECRET: 'integration-lite-locator-secret',
  XPOD_GATEWAY_INTERNAL_CLIENT_ID: 'integration-lite-internal-client',
  XPOD_GATEWAY_INTERNAL_CLIENT_SECRET: 'integration-lite-internal-secret',
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
  let exitCode = 1;

  try {
    console.log('Starting xpod stack...');
    const liteRuntimeEnv = {
      XPOD_LOCAL_AUTO_PROVISION: 'false',
      XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: qleverRuntimeFixture.command,
      ...TEST_GATEWAY_ENV,
    };
    await stack.start('local', { env: liteRuntimeEnv, transport: 'port' });
    console.log(`Stack ready on ${stack.baseUrl}${stack.socketPath ? ` via ${stack.socketPath}` : ''}`);

    const sharedEnv = {
      ...process.env,
      ...liteRuntimeEnv,
      CSS_BASE_URL: stack.baseUrl,
      XPOD_GATEWAY_SOCKET_PATH: stack.socketPath ?? '',
      XPOD_RUN_INTEGRATION_TESTS: 'true',
    };

    exitCode = await runCommand('bun', [ 'run', 'test:setup' ], sharedEnv);
    if (exitCode === 0) {
      exitCode = await runCommand('bun', [ 'run', 'vitest', '--run',
          'tests/integration',
          '--exclude', 'tests/integration/{DockerCluster,MultiNodeCluster,ProvisionFlow,CloudQuotaBusinessToken}*',
        ], sharedEnv);
    }
  } finally {
    await stack.stop();
    qleverRuntimeFixture.cleanup();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
