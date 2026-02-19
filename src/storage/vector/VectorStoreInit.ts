/**
 * Vector Store Initialization Module
 *
 * Handles platform-specific SQLite + sqlite-vec extension loading
 * Supports both Bun and Node.js runtimes
 */

import path from 'node:path';
import fs from 'node:fs';
import { PACKAGE_ROOT } from '../../runtime';

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
      sqlitePath: '', // Use system SQLite
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

    // macOS/Windows need custom SQLite with extension support
    if (process.platform === 'darwin' || process.platform === 'win32') {
      if (!libs.useSystemSQLite && libs.sqlitePath) {
        Database.setCustomSQLite(libs.sqlitePath);
        console.log('[VectorStore] Using bundled SQLite:', libs.sqlitePath);
      } else if (libs.useSystemSQLite) {
        console.log('[VectorStore] Using system SQLite with sqlite-vec');
      }
    }

    return true;
  } catch (e) {
    console.error('[VectorStore] Failed to initialize Bun SQLite:', e);
    return false;
  }
}

/**
 * Get sqlite-vec extension path for better-sqlite3
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
