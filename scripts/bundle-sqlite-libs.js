#!/usr/bin/env node
/**
 * Bundle SQLite + sqlite-vec libraries for packaging
 *
 * Copies platform-specific libraries to lib/ directory
 */

const fs = require('fs');
const path = require('path');

const PLATFORMS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
];

const LIB_NAMES = {
  'darwin-arm64': { sqlite: 'libsqlite3.dylib', vec: 'vec0.dylib' },
  'darwin-x64': { sqlite: 'libsqlite3.dylib', vec: 'vec0.dylib' },
  'linux-x64': { sqlite: 'libsqlite3.so', vec: 'vec0.so' },
  'linux-arm64': { sqlite: 'libsqlite3.so', vec: 'vec0.so' },
  'win32-x64': { sqlite: 'sqlite3.dll', vec: 'vec0.dll' },
};

function copyLib(platform, sourcePath, destDir) {
  if (!fs.existsSync(sourcePath)) {
    console.warn(`  ⚠️  Not found: ${sourcePath}`);
    return false;
  }

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const destPath = path.join(destDir, path.basename(sourcePath));
  fs.copyFileSync(sourcePath, destPath);
  console.log(`  ✅ Copied: ${path.basename(sourcePath)}`);
  return true;
}

function bundlePlatform(platform) {
  console.log(`\n📦 Bundling for ${platform}...`);

  const [os, arch] = platform.split('-');
  const libNames = LIB_NAMES[platform];
  const destDir = path.join('lib', platform);

  let found = 0;

  // 1. sqlite-vec extension
  const vecPackageName = `sqlite-vec-${platform}`;
  const vecSource = path.join('node_modules', vecPackageName, libNames.vec);
  if (copyLib(platform, vecSource, destDir)) found++;

  // 2. SQLite library (from Homebrew or other sources)
  // Note: SQLite needs to be provided separately for each platform
  const sqlitePaths = {
    'darwin-arm64': '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
    'darwin-x64': '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
    'linux-x64': '/usr/lib/x86_64-linux-gnu/libsqlite3.so',
    'linux-arm64': '/usr/lib/aarch64-linux-gnu/libsqlite3.so',
    'win32-x64': 'C:/Program Files/SQLite/sqlite3.dll',
  };

  const sqliteSource = sqlitePaths[platform];
  if (sqliteSource && fs.existsSync(sqliteSource)) {
    if (copyLib(platform, sqliteSource, destDir)) found++;
  } else {
    console.warn(`  ⚠️  SQLite not found at: ${sqliteSource}`);
    console.warn(`      Please install SQLite or provide the library manually.`);
  }

  return found > 0;
}

function main() {
  console.log('🔧 SQLite Library Bundler\n');

  const targetPlatform = process.argv[2]; // Optional: bundle specific platform

  if (targetPlatform) {
    if (!PLATFORMS.includes(targetPlatform)) {
      console.error(`❌ Unknown platform: ${targetPlatform}`);
      console.log(`Supported platforms: ${PLATFORMS.join(', ')}`);
      process.exit(1);
    }
    bundlePlatform(targetPlatform);
  } else {
    // Bundle all platforms
    let success = 0;
    for (const platform of PLATFORMS) {
      if (bundlePlatform(platform)) success++;
    }
    console.log(`\n✅ Bundled ${success}/${PLATFORMS.length} platforms`);
  }

  console.log('\n📁 Output directory: lib/');
}

main();
