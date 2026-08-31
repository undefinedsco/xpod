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

function runInIsolatedConsumerProcess(consumerDir) {
  const childScriptPath = path.join(consumerDir, '.xpod-package-consumer-smoke.cjs');
  fs.writeFileSync(childScriptPath, fs.readFileSync(__filename, 'utf8'));

  try {
    const nodeExecutable = process.env.XPOD_SMOKE_NODE || 'node';
    const result = spawnSync(nodeExecutable, [ childScriptPath ], {
      cwd: consumerDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        XPOD_CONSUMER_SMOKE_CHILD: '1',
        XPOD_SECRET_CELL_KEY_ID: 'consumer-smoke',
        XPOD_SECRET_CELL_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
        XPOD_SECRET_CELL_PREVIOUS_KEYS: '{}',
      },
    });
    if (result.status !== 0) {
      throw new Error(`consumer smoke child exited with code ${result.status ?? 1}`);
    }
  } finally {
    fs.rmSync(childScriptPath, { force: true });
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

function resolveInstalledQleverRuntime(requireFromConsumer, rootPackage) {
  const candidates = Object.keys(rootPackage.optionalDependencies ?? {})
    .filter((name) => name.startsWith('@undefineds.co/xpod-'));
  for (const packageName of candidates) {
    try {
      const packageJsonPath = requireFromConsumer.resolve(`${packageName}/package.json`);
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (typeof packageJson.xpodQleverLocalRuntime !== 'string') continue;
      const runtimePath = path.resolve(path.dirname(packageJsonPath), packageJson.xpodQleverLocalRuntime);
      if (fs.existsSync(runtimePath)) return runtimePath;
    } catch {
      // npm skips optional packages that do not match the current platform.
    }
  }
  throw new Error('Installed package is missing its platform QLever runtime');
}

function runInstalledQleverConformance(
  consumerDir,
  packageRoot,
  qleverRuntimePath,
  runtimeRoot,
) {
  const fixturePath = process.env.XPOD_QLEVER_SEMANTIC_FIXTURE_PATH;
  if (!fixturePath || !path.isAbsolute(fixturePath) || !fs.existsSync(fixturePath)) {
    throw new Error('XPOD_QLEVER_SEMANTIC_FIXTURE_PATH must reference the exact checked-out conformance fixture');
  }
  const runnerPath = path.join(packageRoot, 'dist', 'acceptance', 'run-installed-qlever-conformance.js');
  if (!fs.existsSync(runnerPath)) {
    throw new Error('Installed package is missing its QLever conformance runner');
  }
  const artifactPath = path.join(runtimeRoot, 'installed-qlever-conformance.json');
  const nodeExecutable = process.env.XPOD_SMOKE_NODE || 'node';
  const result = spawnSync(nodeExecutable, [ runnerPath ], {
    cwd: consumerDir,
    encoding: 'utf8',
    stdio: [ 'ignore', 'pipe', 'pipe' ],
    env: {
      ...process.env,
      XPOD_QLEVER_CONFORMANCE_BACKEND: 'sqlite',
      XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: qleverRuntimePath,
      XPOD_QLEVER_CONFORMANCE_ARTIFACT_PATH: artifactPath,
      XPOD_QLEVER_CONFORMANCE_TEMP_ROOT: path.join(runtimeRoot, 'qlever-conformance'),
      XPOD_QLEVER_CONFORMANCE_TIMEOUT_MS: '120000',
    },
  });
  if (result.status !== 0) {
    throw new Error(`installed QLever conformance failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  const report = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  if (report.status !== 'ok' || report.backend !== 'sqlite' || report.semantic?.failed?.length !== 0) {
    throw new Error(`installed QLever conformance returned invalid evidence: ${JSON.stringify(report)}`);
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

  const packageJsonPath = requireFromConsumer.resolve('@undefineds.co/xpod/package.json');
  const packageRoot = path.dirname(packageJsonPath);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const qleverRuntimePath = resolveInstalledQleverRuntime(requireFromConsumer, packageJson);
  process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND = qleverRuntimePath;

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
    runInstalledQleverConformance(
      consumerDir,
      packageRoot,
      qleverRuntimePath,
      runtimeRoot,
    );
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
