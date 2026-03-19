#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

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

function runCli(consumerDir, requireFromConsumer) {
  const packageJsonPath = requireFromConsumer.resolve('@undefineds.co/xpod/package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const binRelative = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.xpod;
  if (!binRelative) {
    throw new Error('Missing xpod bin entry');
  }
  const binPath = path.resolve(path.dirname(packageJsonPath), binRelative);
  const result = spawnSync(process.execPath, [ binPath, '--help' ], {
    cwd: consumerDir,
    encoding: 'utf8',
    stdio: [ 'ignore', 'pipe', 'pipe' ],
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`xpod --help failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

async function main() {
  const consumerDir = path.resolve(process.cwd(), process.argv[2] || '.test-data/package-smoke');
  const requireFromConsumer = createRequire(path.join(consumerDir, 'package.json'));

  const root = requireFromConsumer('@undefineds.co/xpod');
  const runtime = requireFromConsumer('@undefineds.co/xpod/runtime');
  const testUtils = requireFromConsumer('@undefineds.co/xpod/test-utils');

  if (typeof root.startXpodRuntime !== 'function') {
    throw new Error('Missing startXpodRuntime export from root entry');
  }
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
    const port = await getFreePort();
    xpod = await testUtils.startNoAuthXpod({
      port,
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
