#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function normalizeInstallSpec(rawSpec) {
  return rawSpec.replace(/@v(\d+\.\d+\.\d+(?:[-+][^@/]+)?)$/, '@$1');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const rawSpec = process.argv[2];
  const attempts = Number(process.argv[3] || '30');
  const intervalMs = Number(process.argv[4] || '10000');

  if (!rawSpec) {
    throw new Error('Usage: node scripts/wait-for-npm-package.cjs <package-spec> [attempts] [interval-ms]');
  }

  const packageSpec = normalizeInstallSpec(rawSpec);

  for (let index = 1; index <= attempts; index += 1) {
    const result = spawnSync(getNpmCommand(), [ 'view', packageSpec, 'version' ], {
      encoding: 'utf8',
      stdio: [ 'ignore', 'pipe', 'pipe' ],
    });

    if (result.status === 0) {
      console.log(`[npm-wait] visible: ${packageSpec}`);
      return;
    }

    if (index < attempts) {
      console.log(`[npm-wait] waiting for ${packageSpec} (${index}/${attempts})`);
      await sleep(intervalMs);
    }
  }

  throw new Error(`package not visible on npm in time: ${packageSpec}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
