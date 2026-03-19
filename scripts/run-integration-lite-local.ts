import { XpodTestStack } from '../tests/helpers/XpodTestStack';
import { spawn } from 'child_process';

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
  const stack = new XpodTestStack();
  let exitCode = 1;

  try {
    console.log('Starting xpod stack...');
    await stack.start();
    console.log(`Stack ready on ${stack.baseUrl}${stack.socketPath ? ` via ${stack.socketPath}` : ''}`);

    const sharedEnv = {
      ...process.env,
      CSS_BASE_URL: stack.baseUrl,
      XPOD_GATEWAY_SOCKET_PATH: stack.socketPath ?? '',
      XPOD_RUN_INTEGRATION_TESTS: 'true',
    };

    exitCode = await runCommand('bun', [ 'run', 'test:setup' ], sharedEnv);
    if (exitCode === 0) {
      exitCode = await runCommand('bun', [ 'run', 'vitest', '--run',
          'tests/integration',
          '--exclude', 'tests/integration/{DockerCluster,MultiNodeCluster,ProvisionFlow}*',
        ], sharedEnv);
    }
  } finally {
    await stack.stop();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
