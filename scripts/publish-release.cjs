#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getPlatformDependencyMismatches } = require('./platform-binaries.cjs');
const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org';

function readNonEmptyEnv(key, env = process.env) {
  const value = env[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function runFile(file, args, extraEnv = {}, options = {}) {
  const runner = options.runFile ?? execFileSync;
  return runner(file, args, {
    cwd: options.cwd,
    stdio: 'inherit',
    env: { ...options.env, ...extraEnv },
    ...(options.commandOptions ?? {}),
  });
}

function readPackMetadata(packJsonPath) {
  const items = JSON.parse(fs.readFileSync(packJsonPath, 'utf8'));
  const pack = Array.isArray(items) ? items[0] : items;
  if (!pack?.filename) {
    throw new Error(`No tarball filename found in ${packJsonPath}`);
  }
  return pack;
}

function readPublishedVersion(packageName, version, registry) {
  try {
    const output = execFileSync(
      'npm',
      [ 'view', `${packageName}@${version}`, 'version', '--json', '--registry', registry ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        env: {
          ...process.env,
          npm_config_registry: registry,
        },
      },
    ).trim();

    if (!output) {
      return undefined;
    }

    const parsed = JSON.parse(output);
    return typeof parsed === 'string' && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readNpmDistTag(packageName, tag, registry, npmEnv, options = {}) {
  try {
    const output = runFile('npm', [
      'view',
      packageName,
      `dist-tags.${tag}`,
      '--json',
      '--registry',
      registry,
    ], npmEnv, {
      ...options,
      commandOptions: {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      },
    });
    const text = String(output ?? '').trim();
    if (!text) return undefined;
    const parsed = JSON.parse(text);
    return typeof parsed === 'string' && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function ensureNpmDistTag(packageName, version, tag, registry, npmEnv, options = {}) {
  const current = readNpmDistTag(packageName, tag, registry, npmEnv, options);
  if (current !== version) {
    try {
      runFile('npm', [
        'dist-tag',
        'add',
        `${packageName}@${version}`,
        tag,
        '--registry',
        registry,
      ], npmEnv, options);
    } catch {
      // npm returns exit code 1 when a concurrently updated tag already points
      // at this version. The authoritative check below decides success.
    }
  }

  const verified = readNpmDistTag(packageName, tag, registry, npmEnv, options);
  if (verified !== version) {
    throw new Error(`[publish:release] npm dist-tag ${tag} points to ${verified ?? '(missing)'}, expected ${version}`);
  }
}

function inferPublishTag(version) {
  const prerelease = version.match(/-(.+)$/)?.[1];
  if (!prerelease) {
    return undefined;
  }

  const tag = prerelease.split('.')[0]?.trim();
  return tag ? tag : undefined;
}

function isSemverLike(value) {
  return /^(?:v)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function validatePublishTag(tag) {
  if (typeof tag !== 'string' || tag.length === 0) {
    throw new Error('XPOD_PUBLISH_TAG must be non-empty when set');
  }
  if (tag.trim() !== tag || /\s/.test(tag)) {
    throw new Error('XPOD_PUBLISH_TAG must not contain whitespace');
  }
  if (tag.startsWith('-')) {
    throw new Error('XPOD_PUBLISH_TAG must not start with -');
  }
  if (tag.startsWith('.') || tag.endsWith('.')) {
    throw new Error('XPOD_PUBLISH_TAG must not start or end with .');
  }
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(tag)) {
    throw new Error('XPOD_PUBLISH_TAG contains unsupported characters');
  }
  if (isSemverLike(tag)) {
    throw new Error('XPOD_PUBLISH_TAG must not be a SemVer version');
  }
  return tag;
}

function resolvePublishTag(version, env = process.env) {
  if (Object.hasOwn(env, 'XPOD_PUBLISH_TAG')) {
    return validatePublishTag(env.XPOD_PUBLISH_TAG);
  }

  const inferred = inferPublishTag(version);
  return inferred ? validatePublishTag(inferred) : undefined;
}

function main(argv = process.argv.slice(2), options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  const repoRoot = options.cwd ?? process.cwd();
  const dryRun = argv.includes('--dry-run') || env.XPOD_PUBLISH_DRY_RUN === 'true';
  const skipBuild = argv.includes('--skip-build');
  const publishPlatformPackages = env.XPOD_PUBLISH_PLATFORM_PACKAGES === 'true';
  const publishRegistry = readNonEmptyEnv('XPOD_PUBLISH_REGISTRY', env) || OFFICIAL_NPM_REGISTRY;
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const explicitPublishTag = Object.hasOwn(env, 'XPOD_PUBLISH_TAG');
  const publishTag = resolvePublishTag(packageJson.version, env);
  const mismatches = getPlatformDependencyMismatches(packageJson, packageJson.version);

  if (mismatches.length > 0) {
    const details = mismatches
      .map((mismatch) => `${mismatch.packageName}: expected ${mismatch.expected}, got ${mismatch.actual ?? '(missing)'}`)
      .join('; ');
    throw new Error(`[publish:release] package.json optionalDependencies do not match version: ${details}`);
  }

  if (!skipBuild) {
    runFile('bun', [ 'run', 'build' ], {}, { ...options, cwd: repoRoot, env });
  }

  const npmCacheDir = path.join(repoRoot, '.test-data', 'npm-cache');
  const packDir = path.join(repoRoot, '.test-data', 'npm-pack');
  fs.mkdirSync(npmCacheDir, { recursive: true });
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.mkdirSync(packDir, { recursive: true });

  const npmEnv = {
    ...env,
    npm_config_cache: npmCacheDir,
    npm_config_registry: publishRegistry,
    XPOD_INCLUDE_PLATFORM_PACKAGES: 'true',
  };

  runFile(process.execPath, [ path.join(repoRoot, 'scripts/run-npm-pack.cjs'), packDir, npmCacheDir ], npmEnv, { ...options, cwd: repoRoot, env });

  const packJsonPath = path.join(packDir, 'pack.json');
  runFile(process.execPath, [ path.join(repoRoot, 'scripts/check-pack-json.cjs'), packJsonPath ], npmEnv, { ...options, cwd: repoRoot, env });

  if (publishPlatformPackages) {
    runFile(process.execPath, [
      path.join(repoRoot, 'scripts/publish-platform-packages.cjs'),
      ...(dryRun ? [ '--dry-run' ] : []),
    ], npmEnv, { ...options, cwd: repoRoot, env });
  } else {
    console.log('[publish:release] skipping platform package publish (set XPOD_PUBLISH_PLATFORM_PACKAGES=true to enable)');
  }

  const pack = readPackMetadata(packJsonPath);
  const tarballPath = path.join(packDir, pack.filename);
  const packageRef = `${packageJson.name}@${packageJson.version}`;

  if (!dryRun) {
    const publishedVersion = (options.readPublishedVersion ?? readPublishedVersion)(packageJson.name, packageJson.version, publishRegistry);
    if (publishedVersion === packageJson.version) {
      if (explicitPublishTag && publishTag) {
        ensureNpmDistTag(packageJson.name, packageJson.version, publishTag, publishRegistry, npmEnv, { ...options, cwd: repoRoot, env });
      }
      console.log(`[publish:release] ${packageRef} already exists on ${publishRegistry}, skipping npm publish`);
      console.log(`[publish:release] registry: ${publishRegistry}`);
      return;
    }
  }

  try {
    runFile('npm', [
      'publish',
      tarballPath,
      '--registry',
      publishRegistry,
      '--access',
      'public',
      ...(publishTag ? [ '--tag', publishTag ] : []),
      ...(dryRun ? [ '--dry-run' ] : []),
    ], npmEnv, { ...options, cwd: repoRoot, env });
  } catch (error) {
    if (!dryRun) {
      const publishedVersion = (options.readPublishedVersion ?? readPublishedVersion)(packageJson.name, packageJson.version, publishRegistry);
      if (publishedVersion === packageJson.version) {
        if (explicitPublishTag && publishTag) {
          ensureNpmDistTag(packageJson.name, packageJson.version, publishTag, publishRegistry, npmEnv, { ...options, cwd: repoRoot, env });
        }
        console.log(`[publish:release] ${packageRef} is already available on ${publishRegistry}, treating publish as successful`);
        console.log(`[publish:release] registry: ${publishRegistry}`);
        return;
      }
    }

    throw error;
  }

  console.log(`[publish:release] ${dryRun ? 'dry-run complete' : 'publish complete'}`);
  console.log(`[publish:release] registry: ${publishRegistry}`);
  if (publishTag) {
    console.log(`[publish:release] dist-tag: ${publishTag}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (_error) {
    process.exit(1);
  }
}

module.exports = {
  inferPublishTag,
  main,
  resolvePublishTag,
  ensureNpmDistTag,
  validatePublishTag,
};
