#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  getCurrentPlatformTarget,
  QLEVER_LOCAL_RUNTIME_RELATIVE_PATH,
  resolvePlatformTarget,
} = require('./platform-binaries.cjs');

const repoRoot = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function readNonEmptyEnv(key) {
  const value = process.env[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function createReadme(rootPackage, target) {
  return [
    `# ${target.packageName}`,
    '',
    `Prebuilt ${target.label} Bun binary for \`${rootPackage.name}\`.`,
    '',
    'This package is installed automatically as an optional dependency of the main `@undefineds.co/xpod` package on matching platforms.',
    '',
    'It is not intended to be imported directly.',
    '',
  ].join('\n');
}

function createStagePackageJson(rootPackage, target) {
  const packageJson = {
    name: target.packageName,
    version: rootPackage.version,
    description: `Prebuilt ${target.label} binary for ${rootPackage.name}`,
    license: rootPackage.license,
    repository: rootPackage.repository,
    private: false,
    os: target.os,
    cpu: target.cpu,
    files: [
      target.binaryName,
      'qlever',
      'README.md',
      'LICENSE',
    ],
    xpodBinary: `./${target.binaryName}`,
    xpodQleverLocalRuntime: `./${QLEVER_LOCAL_RUNTIME_RELATIVE_PATH}`,
  };

  if (target.libc) {
    packageJson.libc = target.libc;
  }

  return packageJson;
}

function resolveQleverRuntimeArtifactPath(options = {}) {
  const artifactPath = options.qleverRuntimeArtifactPath
    ?? readNonEmptyEnv('XPOD_QLEVER_LOCAL_RUNTIME_ARTIFACT');
  if (!artifactPath) {
    throw new Error('Missing QLever local runtime artifact: pass --qlever-runtime-artifact=<path> or set XPOD_QLEVER_LOCAL_RUNTIME_ARTIFACT');
  }

  const resolvedPath = path.resolve(repoRoot, artifactPath);
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile() || !resolvedPath.endsWith('.tar.gz')) {
    throw new Error(`QLever local runtime artifact does not exist: ${resolvedPath}`);
  }

  return resolvedPath;
}

function extractQleverRuntimeArtifact(stageDir, artifactPath) {
  const runtimeOutputPath = path.join(stageDir, QLEVER_LOCAL_RUNTIME_RELATIVE_PATH);
  const runtimeRoot = path.join(stageDir, 'qlever');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const result = spawnSync('tar', [ '-xzf', artifactPath, '-C', runtimeRoot ], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`Failed to extract QLever local runtime artifact: ${artifactPath}`);
  }
  if (!fs.existsSync(runtimeOutputPath) || !fs.statSync(runtimeOutputPath).isFile()) {
    throw new Error(`QLever local runtime archive is missing ${QLEVER_LOCAL_RUNTIME_RELATIVE_PATH}`);
  }
  fs.chmodSync(runtimeOutputPath, 0o755);
  return runtimeOutputPath;
}

function buildPlatformPackage(targetRef, options = {}) {
  const target = targetRef === 'current'
    ? getCurrentPlatformTarget()
    : resolvePlatformTarget(targetRef);

  if (!target) {
    throw new Error(`Unsupported platform target: ${targetRef ?? '(missing)'}`);
  }

  const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const stageDir = options.stageDir ?? path.join(repoRoot, 'dist', 'npm', target.id);
  const qleverRuntimeArtifactPath = resolveQleverRuntimeArtifactPath(options);
  const binaryOutputPath = path.join(stageDir, target.binaryName);
  const relativeBinaryOutputPath = path.relative(repoRoot, binaryOutputPath);

  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  run(process.execPath, [
    'scripts/build-bun-single.js',
    `--target=${target.bunTarget}`,
    `--output=${relativeBinaryOutputPath}`,
  ]);
  const qleverRuntimeOutputPath = extractQleverRuntimeArtifact(stageDir, qleverRuntimeArtifactPath);
  if (target.os.includes('darwin')) {
    if (process.platform !== 'darwin' || process.arch !== target.cpu[0]) {
      throw new Error('macOS native platform package requires matching-host cold Bun qualification');
    }
    // Qualify the same extracted payload in cold Bun; no host preload or alternate asset list.
    run('bun', ['--no-env-file', '-e', `
      const {getSqliteRuntime}=require('./dist/storage/SqliteRuntime.js');
      const db=getSqliteRuntime().openDatabase(':memory:');
      db.exec('CREATE VIRTUAL TABLE docs USING fts5(body); INSERT INTO docs VALUES("current")');
      if(db.prepare('SELECT count(*) n FROM docs WHERE docs MATCH "current"').get().n!==1)throw Error('FTS');
      db.loadExtension(require('sqlite-vec').getLoadablePath());
      db.exec('CREATE VIRTUAL TABLE vectors USING vec0(embedding float[768])');
      const vector=new Float32Array(768);vector[0]=1;
      db.prepare('INSERT INTO vectors(rowid,embedding) VALUES(?,?)').run(41,vector);
      if(db.prepare('SELECT length(embedding) n FROM vectors WHERE rowid=41').get().n!==3072)throw Error('VEC readback');
      if(db.prepare('SELECT rowid FROM vectors WHERE embedding MATCH ? AND k=1').get(vector).rowid!==41)throw Error('VEC search');
      db.close();
    `], { env: { ...process.env, XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: qleverRuntimeOutputPath, XPOD_SQLITE_RUNTIME: 'bun-sqlite' } });
  }

  writeJson(path.join(stageDir, 'package.json'), createStagePackageJson(rootPackage, target));
  fs.writeFileSync(path.join(stageDir, 'README.md'), createReadme(rootPackage, target));
  fs.copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(stageDir, 'LICENSE'));

  if (process.platform !== 'win32') {
    fs.chmodSync(binaryOutputPath, 0o755);
  }

  return {
    target,
    stageDir,
    binaryOutputPath,
    qleverRuntimeOutputPath,
  };
}

function packStageDirectory(stageDir) {
  run('npm', [ 'pack' ], { cwd: stageDir });
}

function parseArgs(argv) {
  const args = {
    pack: false,
    target: undefined,
  };

  for (const arg of argv) {
    if (arg === '--pack') {
      args.pack = true;
      continue;
    }

    if (arg === '--current') {
      args.target = 'current';
      continue;
    }

    if (arg.startsWith('--target=')) {
      args.target = arg.slice('--target='.length);
      continue;
    }

    if (arg.startsWith('--qlever-runtime-artifact=')) {
      args.qleverRuntimeArtifactPath = arg.slice('--qlever-runtime-artifact='.length);
      continue;
    }

    if (arg.startsWith('--stage-dir=')) {
      args.stageDir = path.resolve(repoRoot, arg.slice('--stage-dir='.length));
    }
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = buildPlatformPackage(args.target ?? 'current', {
    qleverRuntimeArtifactPath: args.qleverRuntimeArtifactPath,
    stageDir: args.stageDir,
  });
  if (args.pack) {
    packStageDirectory(result.stageDir);
  }
  console.log(`[build:platform-package] ${result.target.packageName} -> ${path.relative(repoRoot, result.stageDir)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

module.exports = {
  buildPlatformPackage,
  extractQleverRuntimeArtifact,
  createStagePackageJson,
  resolveQleverRuntimeArtifactPath,
};
