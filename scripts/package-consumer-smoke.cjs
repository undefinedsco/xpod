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

function getSmokeMode() {
  if (process.env.XPOD_CONSUMER_SMOKE_CHILD === '1') {
    return process.env.XPOD_CONSUMER_SMOKE_MODE || 'runtime';
  }
  return process.argv[3] === '--package-only' ? 'package-only' : 'runtime';
}

function runInIsolatedConsumerProcess(consumerDir, smokeMode, executable = process.env.XPOD_SMOKE_NODE || 'node') {
  const childScriptPath = path.join(consumerDir, '.xpod-package-consumer-smoke.cjs');
  fs.writeFileSync(childScriptPath, fs.readFileSync(__filename, 'utf8'));

  try {
    const result = spawnSync(executable, [ childScriptPath ], {
      cwd: consumerDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        XPOD_CONSUMER_SMOKE_CHILD: '1',
        XPOD_CONSUMER_SMOKE_MODE: smokeMode,
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
  const nodeExecutable = typeof globalThis.Bun !== 'undefined' ? process.execPath : process.env.XPOD_SMOKE_NODE || 'node';
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
    let packageJsonPath;
    try { packageJsonPath = requireFromConsumer.resolve(`${packageName}/package.json`); }
    catch(error) { if(error.code==='MODULE_NOT_FOUND')continue;throw error; }
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    if (typeof packageJson.xpodQleverLocalRuntime !== 'string') throw Error('Selected platform package lacks QLever runtime metadata');
    const runtimePath = path.resolve(path.dirname(packageJsonPath), packageJson.xpodQleverLocalRuntime);
    if (!fs.existsSync(runtimePath)) throw Error(`Selected platform QLever payload is missing: ${runtimePath}`);
    return runtimePath;
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
  const nodeExecutable = typeof globalThis.Bun !== 'undefined' ? process.execPath : process.env.XPOD_SMOKE_NODE || 'node';
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

async function runInstalledSqliteConformance(packageRoot, runtimeRoot) {
  if (typeof globalThis.Bun === 'undefined') return; // Node remains an independent control.
  const { LocalPhysicalOperationService } = require(path.join(packageRoot, 'dist/storage/LocalPhysicalOperationService.js'));
  const { getSqliteRuntime } = require(path.join(packageRoot, 'dist/storage/SqliteRuntime.js'));
  const { SqliteVectorStore } = require(path.join(packageRoot, 'dist/storage/vector/SqliteVectorStore.js'));
  // Coordination must open first, then ordinary RDF/FTS, then public vec0 on that same frozen choice.
  const service = new LocalPhysicalOperationService(path.join(runtimeRoot, 'authority'));
  const db = getSqliteRuntime().openDatabase(path.join(runtimeRoot, 'ordinary.sqlite'));
  const vectors = new SqliteVectorStore({connectionString:path.join(runtimeRoot,'vec.sqlite'), operationService:service});
  try {
    await service.run(() => {
      db.exec('CREATE TABLE rdf(s TEXT,p TEXT,o TEXT); INSERT INTO rdf VALUES("s","p","current"); CREATE VIRTUAL TABLE docs USING fts5(body); INSERT INTO docs VALUES("current")');
      if(db.prepare('SELECT o FROM rdf').get().o!=='current')throw Error('Bun RDF');
      if(db.prepare('SELECT count(*) n FROM docs WHERE docs MATCH "current"').get().n!==1)throw Error('Bun FTS');
    });
    const vector = Array(768).fill(0);vector[0]=1;
    await vectors.ensureVectorTable('consumer-cold');
    await vectors.upsertVector('consumer-cold',41,vector);
    const saved=await vectors.getVector('consumer-cold',41);
    if(saved?.embedding.length!==768 || saved.embedding[0]!==1)throw Error('Bun public VEC readback');
    const nearest=await vectors.search('consumer-cold',vector,{limit:1});
    if(nearest[0]?.id!==41)throw Error('Bun public VEC search');
  } finally {
    await vectors.close();await service.run(()=>db.close());await service.close();
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
  const smokeMode = getSmokeMode();
  if (process.env.XPOD_CONSUMER_SMOKE_CHILD !== '1') {
    runInIsolatedConsumerProcess(consumerDir, smokeMode);
    if (smokeMode === 'runtime') runInIsolatedConsumerProcess(consumerDir, smokeMode, 'bun');
    return;
  }

  const requireFromConsumer = createRequire(path.join(consumerDir, 'package.json'));

  const packageJsonPath = requireFromConsumer.resolve('@undefineds.co/xpod/package.json');
  const packageRoot = path.dirname(packageJsonPath);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  const qleverRuntimePath = smokeMode === 'runtime' ? resolveInstalledQleverRuntime(requireFromConsumer, packageJson) : undefined;
  if (qleverRuntimePath) process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND = qleverRuntimePath;

  const runtime = requireFromConsumer('@undefineds.co/xpod/runtime');
  const testUtils = requireFromConsumer('@undefineds.co/xpod/test-utils');
  if (typeof runtime.startXpodRuntime !== 'function') {
    throw new Error('Missing startXpodRuntime export from runtime entry');
  }
  if (typeof testUtils.startNoAuthXpod !== 'function') {
    throw new Error('Missing startNoAuthXpod export from test-utils entry');
  }

  runCli(consumerDir, requireFromConsumer);

  if (smokeMode === 'package-only') {
    console.log(`[consumer-smoke] package-only ok: ${consumerDir}`);
    return;
  }


  const previousCwd = process.cwd();
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-smoke-'));
  const transport = process.env.XPOD_TEST_TRANSPORT || process.env.XPOD_SMOKE_TRANSPORT || 'port';
  let xpod;

  try {
    await runInstalledSqliteConformance(packageRoot, runtimeRoot);
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
