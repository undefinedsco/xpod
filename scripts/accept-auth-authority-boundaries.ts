import { spawn } from 'node:child_process';

type AcceptanceStep = {
  label: string;
  command: string;
  args: string[];
};

const skipBuild = process.argv.includes('--skip-build');
const steps: AcceptanceStep[] = [
  ...(skipBuild ? [] : [
    { label: 'Build shared packages', command: 'bun', args: ['run', 'build:packages'] },
    { label: 'Build product bundles', command: 'bun', args: ['run', 'build:ui'] },
  ]),
  {
    label: 'Run real browser authority acceptance',
    command: 'bunx',
    args: [
      'playwright',
      'test',
      'tests/e2e/shared-login.spec.ts',
      '--grep',
      '@auth-boundary',
      '--workers=1',
      '--reporter=line',
    ],
  },
];

for (const step of steps) {
  process.stdout.write(`\n[auth acceptance] ${step.label}\n`);
  const exitCode = await run(step.command, step.args);
  if (exitCode !== 0) process.exit(exitCode);
}

process.stdout.write('\n[auth acceptance] Account/WebID authority boundaries passed.\n');

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}
