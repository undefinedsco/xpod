import { XpodTestStack } from '../tests/helpers/XpodTestStack';
import { spawn } from 'child_process';

async function main() {
  const stack = new XpodTestStack();
  let exitCode = 1;

  try {
    console.log('Starting xpod stack...');
    await stack.start();
    console.log(`Stack ready on ${stack.baseUrl}${stack.socketPath ? ` via ${stack.socketPath}` : ''}`);

    exitCode = await new Promise<number>((resolve) => {
      const child = spawn('yarn', ['vitest', '--run',
        'tests/integration',
        '--exclude', 'tests/integration/{DockerCluster,MultiNodeCluster,ProvisionFlow}*',
      ], {
        stdio: 'inherit',
        env: {
          ...process.env,
          CSS_BASE_URL: stack.baseUrl,
          XPOD_GATEWAY_SOCKET_PATH: stack.socketPath ?? '',
          XPOD_RUN_INTEGRATION_TESTS: 'true',
        },
      });
      child.on('close', (code) => resolve(code ?? 1));
    });
  } finally {
    await stack.stop();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
