/**
 * Vector Store Initialization Module
 *
 * Handles platform-specific SQLite + sqlite-vec extension loading
 * Supports both Bun and Node.js runtimes
 */

import path from 'node:path';
import fs from 'node:fs';

function findPackageRoot(dir: string): string {
  let current = dir;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return dir;
}

const PACKAGE_ROOT = findPackageRoot(__dirname);

// Platform detection
const platform = `${process.platform}-${process.arch}`;

// Map platform to library names
const PLATFORM_LIBS: Record<string, { sqlite: string; vec: string }> = {
  'darwin-arm64': { sqlite: 'libsqlite3.dylib', vec: 'vec0.dylib' },
  'darwin-x64': { sqlite: 'libsqlite3.dylib', vec: 'vec0.dylib' },
  'linux-x64': { sqlite: 'libsqlite3.so', vec: 'vec0.so' },
  'linux-arm64': { sqlite: 'libsqlite3.so', vec: 'vec0.so' },
  'win32-x64': { sqlite: 'sqlite3.dll', vec: 'vec0.dll' },
};

interface VectorStoreConfig {
  sqlitePath: string;
  vecExtensionPath: string;
  useSystemSQLite: boolean;
}

function resolveSystemSqlitePath(libraryName: string): string | null {
  const candidates = (() => {
    switch (process.platform) {
      case 'darwin':
        return [
          `/usr/lib/${libraryName}`,
          `/opt/homebrew/lib/${libraryName}`,
          `/usr/local/lib/${libraryName}`,
        ];
      case 'linux':
        return [
          `/usr/lib/${libraryName}`,
          `/usr/lib64/${libraryName}`,
          `/lib/${libraryName}`,
          `/lib64/${libraryName}`,
          `/usr/lib/x86_64-linux-gnu/${libraryName}`,
          `/lib/x86_64-linux-gnu/${libraryName}`,
          `/usr/lib/aarch64-linux-gnu/${libraryName}`,
          `/lib/aarch64-linux-gnu/${libraryName}`,
          `/usr/lib/arm-linux-gnueabihf/${libraryName}`,
          `/lib/arm-linux-gnueabihf/${libraryName}`,
          `/usr/lib/x86_64-linux-gnu/${libraryName}.0`,
          `/lib/x86_64-linux-gnu/${libraryName}.0`,
          `/usr/lib/aarch64-linux-gnu/${libraryName}.0`,
          `/lib/aarch64-linux-gnu/${libraryName}.0`,
        ];
      case 'win32':
        return [];
      default:
        return [];
    }
  })();

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Get the paths for SQLite libraries
 */
export function getVectorStoreLibs(): VectorStoreConfig | null {
  const libs = PLATFORM_LIBS[platform];
  if (!libs) {
    console.warn(`[VectorStore] Unsupported platform: ${platform}`);
    return null;
  }

  // Check for bundled libraries (for packaged app)
  const bundledDir = path.join(PACKAGE_ROOT, 'lib', platform);
  const bundledSqlite = path.join(bundledDir, libs.sqlite);
  const bundledVec = path.join(bundledDir, libs.vec);

  if (fs.existsSync(bundledSqlite) && fs.existsSync(bundledVec)) {
    return {
      sqlitePath: bundledSqlite,
      vecExtensionPath: bundledVec,
      useSystemSQLite: false,
    };
  }

  // Development mode: use system SQLite + npm-installed sqlite-vec
  const nodeModulesDir = path.join(PACKAGE_ROOT, 'node_modules');
  const vecPackageDir = path.join(
    nodeModulesDir,
    `sqlite-vec-${platform.replace('-', '-')}`
  );
  const vecPath = path.join(vecPackageDir, libs.vec);

  if (fs.existsSync(vecPath)) {
    return {
      sqlitePath: resolveSystemSqlitePath(libs.sqlite) ?? '',
      vecExtensionPath: vecPath,
      useSystemSQLite: true,
    };
  }

  console.warn(`[VectorStore] Libraries not found for ${platform}`);
  return null;
}

/**
 * Initialize SQLite for Bun runtime
 */
export function initBunSQLite(): boolean {
  const isBun = typeof (globalThis as any).Bun !== 'undefined';
  if (!isBun) return false;

  const libs = getVectorStoreLibs();
  if (!libs) return false;

  try {
    const { Database } = require('bun:sqlite');

    if (libs.sqlitePath) {
      Database.setCustomSQLite(libs.sqlitePath);
      console.log(`[VectorStore] Using ${libs.useSystemSQLite ? 'system' : 'bundled'} SQLite:`, libs.sqlitePath);
    } else if (libs.useSystemSQLite) {
      console.warn('[VectorStore] System sqlite-vec found, but no loadable SQLite library was resolved');
    }

    return true;
  } catch (e) {
    console.error('[VectorStore] Failed to initialize Bun SQLite:', e);
    return false;
  }
}

/**
 * Get sqlite-vec extension path for native SQLite runtimes
 */
export function getVecExtensionPath(): string | null {
  const libs = getVectorStoreLibs();
  return libs?.vecExtensionPath || null;
}

/**
 * Check if vector search is available
 */
export function isVectorSearchAvailable(): boolean {
  return getVectorStoreLibs() !== null;
}
