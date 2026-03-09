import { XpodTestStack } from '../tests/helpers/XpodTestStack';
import { spawn } from 'child_process';

function runYarn(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn('yarn', args, {
      stdio: 'inherit',
      env,
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const stack = new XpodTestStack();
  let exitCode = 1;

  try {
    console.log('Starting xpod stack...');
    await stack.start();
    console.log(`Stack ready on ${stack.baseUrl}${stack.socketPath ? ` via ${stack.socketPath}` : ''}`);

    const testEnv = {
      ...process.env,
      CSS_BASE_URL: stack.baseUrl,
      XPOD_GATEWAY_SOCKET_PATH: stack.socketPath ?? '',
      XPOD_RUN_INTEGRATION_TESTS: 'true',
    };

    const setupCode = await runYarn(['ts-node', 'scripts/setup-test-credentials.ts'], testEnv);
    if (setupCode !== 0) {
      exitCode = setupCode;
      return;
    }

    exitCode = await runYarn([
      'vitest', '--run',
      'tests/integration',
      '--exclude', 'tests/integration/{DockerCluster,MultiNodeCluster,ProvisionFlow,CloudQuotaBusinessToken}*',
    ], testEnv);
  } finally {
    await stack.stop();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
