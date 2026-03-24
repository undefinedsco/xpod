#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

function getConsumerDir() {
  if (process.env.XPOD_CONSUMER_SMOKE_CHILD === '1') {
    return process.cwd();
  }
  return path.resolve(process.cwd(), process.argv[2] || '.test-data/package-smoke');
}

function runInIsolatedConsumerProcess(consumerDir) {
  const childScriptPath = path.join(consumerDir, '.xpod-package-consumer-smoke.cjs');
  fs.writeFileSync(childScriptPath, fs.readFileSync(__filename, 'utf8'));

  try {
    const result = spawnSync(process.execPath, [ childScriptPath ], {
      cwd: consumerDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        XPOD_CONSUMER_SMOKE_CHILD: '1',
      },
    });
    if (result.status !== 0) {
      throw new Error(`consumer smoke child exited with code ${result.status ?? 1}`);
    }
  } finally {
    fs.rmSync(childScriptPath, { force: true });
  }
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function isPortConflict(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to start server\. Is port \d+ in use\?/i.test(message) ||
    /EADDRINUSE/i.test(message) ||
    /address already in use/i.test(message);
}

async function startNoAuthXpodWithRetry(testUtils, options, maxAttempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const port = await getFreePort();
    try {
      return await testUtils.startNoAuthXpod({
        ...options,
        port,
      });
    } catch (error) {
      lastError = error;
      if (!isPortConflict(error) || attempt === maxAttempts) {
        throw error;
      }
      console.warn(`[consumer-smoke] port conflict on ${port}, retry ${attempt}/${maxAttempts}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
  throw lastError;
}

function runCli(consumerDir, requireFromConsumer) {
  const packageJsonPath = requireFromConsumer.resolve('@undefineds.co/xpod/package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const binRelative = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.xpod;
  if (!binRelative) {
    throw new Error('Missing xpod bin entry');
  }
  const binPath = path.resolve(path.dirname(packageJsonPath), binRelative);
  const nodeExecutable = process.env.XPOD_SMOKE_NODE || 'node';
  const result = spawnSync(nodeExecutable, [ binPath, '--help' ], {
    cwd: consumerDir,
    encoding: 'utf8',
    stdio: [ 'ignore', 'pipe', 'pipe' ],
    env: {
      ...process.env,
      XPOD_PREFER_JS_CLI: 'true',
    },
  });
  if (result.status !== 0) {
    throw new Error(`xpod --help failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

async function main() {
  const consumerDir = getConsumerDir();
  if (process.env.XPOD_CONSUMER_SMOKE_CHILD !== '1') {
    runInIsolatedConsumerProcess(consumerDir);
    return;
  }

  const requireFromConsumer = createRequire(path.join(consumerDir, 'package.json'));

  const runtime = requireFromConsumer('@undefineds.co/xpod/runtime');
  const testUtils = requireFromConsumer('@undefineds.co/xpod/test-utils');
  if (typeof runtime.startXpodRuntime !== 'function') {
    throw new Error('Missing startXpodRuntime export from runtime entry');
  }
  if (typeof testUtils.startNoAuthXpod !== 'function') {
    throw new Error('Missing startNoAuthXpod export from test-utils entry');
  }

  runCli(consumerDir, requireFromConsumer);

  const previousCwd = process.cwd();
  let xpod;

  try {
    process.chdir(consumerDir);
    xpod = await startNoAuthXpodWithRetry(testUtils, {
      logLevel: 'error',
    });
    const response = await fetch(new URL('/service/status', xpod.baseUrl));
    if (!response.ok) {
      throw new Error(`Unexpected status from installed package runtime: ${response.status}`);
    }
  } finally {
    if (xpod) {
      await xpod.stop();
    }
    process.chdir(previousCwd);
  }

  console.log(`[consumer-smoke] ok: ${consumerDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
