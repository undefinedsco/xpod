#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

function getConsumerDir() {
  if (process.env.XPOD_CONSUMER_SMOKE_CHILD === '1') {
    return process.cwd();
  }
  return path.resolve(process.cwd(), process.argv[2] || '.test-data/package-smoke');
}

function createFakeQleverRuntimeCommand() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-qlever-runtime-'));
  const fixturePath = path.resolve(__dirname, '../tests/fixtures/fake-qlever-native-runtime.js');
  const command = path.join(
    directory,
    process.platform === 'win32' ? 'xpod_qlever_local_runtime.cmd' : 'xpod_qlever_local_runtime',
  );
  const wrapper = process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`
    : `#!${process.execPath}\nrequire(${JSON.stringify(fixturePath)});\n`;
  fs.writeFileSync(command, wrapper);
  if (process.platform !== 'win32') {
    fs.chmodSync(command, 0o755);
  }
  return {
    command,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

function runInIsolatedConsumerProcess(consumerDir) {
  const childScriptPath = path.join(consumerDir, '.xpod-package-consumer-smoke.cjs');
  const runtimeFixture = createFakeQleverRuntimeCommand();

  try {
    fs.writeFileSync(childScriptPath, fs.readFileSync(__filename, 'utf8'));
    const nodeExecutable = process.env.XPOD_SMOKE_NODE || process.execPath;
    const result = spawnSync(nodeExecutable, [ childScriptPath ], {
      cwd: consumerDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        XPOD_CONSUMER_SMOKE_CHILD: '1',
        XPOD_GATEWAY_LOCATOR_KEY_ID: 'consumer-smoke',
        XPOD_GATEWAY_LOCATOR_SECRET: 'consumer-smoke-locator-secret',
        XPOD_GATEWAY_INTERNAL_CLIENT_ID: 'consumer-smoke-internal-client',
        XPOD_GATEWAY_INTERNAL_CLIENT_SECRET: 'consumer-smoke-internal-secret',
        XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: runtimeFixture.command,
      },
    });
    if (result.status !== 0) {
      throw new Error(`consumer smoke child exited with code ${result.status ?? 1}`);
    }
  } finally {
    fs.rmSync(childScriptPath, { force: true });
    runtimeFixture.cleanup();
  }
}

function runCli(consumerDir, requireFromConsumer) {
  const packageJsonPath = requireFromConsumer.resolve('@undefineds.co/xpod/package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const binRelative = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.xpod;
  if (!binRelative) {
    throw new Error('Missing xpod bin entry');
  }
  const binPath = path.resolve(path.dirname(packageJsonPath), binRelative);
  const nodeExecutable = process.env.XPOD_SMOKE_NODE || process.execPath;
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

function shouldRetryRemove(error) {
  return Boolean(error && typeof error === 'object' && [
    'EBUSY',
    'ENOTEMPTY',
    'EPERM',
  ].includes(error.code));
}

async function removeRuntimeRoot(runtimeRoot) {
  const maxAttempts = process.platform === 'win32' ? 8 : 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      fs.rmSync(runtimeRoot, {
        recursive: true,
        force: true,
      });
      return;
    } catch (error) {
      const finalAttempt = attempt === maxAttempts;
      if (!shouldRetryRemove(error)) {
        throw error;
      }
      if (finalAttempt) {
        if (process.platform === 'win32') {
          console.warn(`[consumer-smoke] cleanup skipped for busy runtime root: ${runtimeRoot} (${error.code})`);
          return;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 200));
    }
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
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-smoke-'));
  const transport = process.env.XPOD_TEST_TRANSPORT || process.env.XPOD_SMOKE_TRANSPORT || 'port';
  let xpod;

  try {
    process.chdir(consumerDir);
    xpod = await runtime.startXpodRuntime({
      mode: 'local',
      open: true,
      transport,
      runtimeRoot,
      logLevel: 'error',
    });
    const response = await xpod.fetch('/service/status');
    if (!response.ok) {
      throw new Error(`Unexpected status from installed package runtime: ${response.status}`);
    }
  } finally {
    if (xpod) {
      await xpod.stop();
    }
    process.chdir(previousCwd);
    await removeRuntimeRoot(runtimeRoot);
  }

  console.log(`[consumer-smoke] ok: ${consumerDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
