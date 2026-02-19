import { XpodTestStack } from '../tests/helpers/XpodTestStack';
import { spawn } from 'child_process';

async function main() {
  const stack = new XpodTestStack();
  let exitCode = 1;

  try {
    console.log('Starting xpod stack...');
    await stack.start();
    console.log(`Stack ready on port ${stack.port}`);

    exitCode = await new Promise<number>((resolve) => {
      const child = spawn('yarn', ['vitest', '--run',
        'tests/integration',
        '--exclude', 'tests/integration/{DockerCluster,MultiNodeCluster}*',
      ], {
        stdio: 'inherit',
        env: {
          ...process.env,
          CSS_BASE_URL: `http://localhost:${stack.port}/`,
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
