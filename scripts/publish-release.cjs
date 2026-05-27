#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { getPlatformDependencyMismatches } = require('./platform-binaries.cjs');
const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org';

function readNonEmptyEnv(key) {
  const value = process.env[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function run(command, extraEnv = {}) {
  execSync(command, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
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
    const output = execSync(
      `npm view ${JSON.stringify(`${packageName}@${version}`)} version --json --registry ${JSON.stringify(registry)}`,
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

function inferPublishTag(version) {
  const prerelease = version.match(/-(.+)$/)?.[1];
  if (!prerelease) {
    return undefined;
  }

  const tag = prerelease.split('.')[0]?.trim();
  return tag ? tag : undefined;
}

function main() {
  const repoRoot = process.cwd();
  const dryRun = process.argv.includes('--dry-run') || process.env.XPOD_PUBLISH_DRY_RUN === 'true';
  const skipBuild = process.argv.includes('--skip-build');
  const publishPlatformPackages = process.env.XPOD_PUBLISH_PLATFORM_PACKAGES === 'true';
  const publishRegistry = readNonEmptyEnv('XPOD_PUBLISH_REGISTRY') || OFFICIAL_NPM_REGISTRY;
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const publishTag = inferPublishTag(packageJson.version);
  const mismatches = getPlatformDependencyMismatches(packageJson, packageJson.version);

  if (mismatches.length > 0) {
    console.error('[publish:release] package.json optionalDependencies do not match version');
    for (const mismatch of mismatches) {
      console.error(`- ${mismatch.packageName}: expected ${mismatch.expected}, got ${mismatch.actual ?? '(missing)'}`);
    }
    process.exit(1);
  }

  if (!skipBuild) {
    run('bun run build');
  }

  const npmCacheDir = path.join(repoRoot, '.test-data', 'npm-cache');
  const packDir = path.join(repoRoot, '.test-data', 'npm-pack');
  fs.mkdirSync(npmCacheDir, { recursive: true });
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.mkdirSync(packDir, { recursive: true });

  const npmEnv = {
    npm_config_cache: npmCacheDir,
    npm_config_registry: publishRegistry,
    XPOD_INCLUDE_PLATFORM_PACKAGES: publishPlatformPackages ? 'true' : 'false',
  };

  run(`node scripts/run-npm-pack.cjs ${JSON.stringify(packDir)} ${JSON.stringify(npmCacheDir)}`, npmEnv);

  const packJsonPath = path.join(packDir, 'pack.json');
  run(`node scripts/check-pack-json.cjs ${JSON.stringify(packJsonPath)}`);

  if (publishPlatformPackages) {
    run(`node scripts/publish-platform-packages.cjs${dryRun ? ' --dry-run' : ''}`, npmEnv);
  } else {
    console.log('[publish:release] skipping platform package publish (set XPOD_PUBLISH_PLATFORM_PACKAGES=true to enable)');
  }

  const pack = readPackMetadata(packJsonPath);
  const tarballPath = path.join(packDir, pack.filename);
  const packageRef = `${packageJson.name}@${packageJson.version}`;

  if (!dryRun) {
    const publishedVersion = readPublishedVersion(packageJson.name, packageJson.version, publishRegistry);
    if (publishedVersion === packageJson.version) {
      console.log(`[publish:release] ${packageRef} already exists on ${publishRegistry}, skipping npm publish`);
      console.log(`[publish:release] registry: ${publishRegistry}`);
      return;
    }
  }

  try {
    run(`npm publish ${JSON.stringify(tarballPath)} --registry ${publishRegistry} --access public${publishTag ? ` --tag ${publishTag}` : ''}${dryRun ? ' --dry-run' : ''}`, npmEnv);
  } catch (error) {
    if (!dryRun) {
      const publishedVersion = readPublishedVersion(packageJson.name, packageJson.version, publishRegistry);
      if (publishedVersion === packageJson.version) {
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

try {
  main();
} catch (_error) {
  process.exit(1);
}
