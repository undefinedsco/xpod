import { createRequire } from 'node:module';
import {
  createSqliteDatabase,
  type SqliteOpenOptions,
  isBun,
} from './SqliteCompat';
import type { SqliteDatabase } from './SqliteCompat';
import { drizzleNodeSqlite } from './NodeSqliteDrizzle';

export type DrizzleDb = any;

interface DrizzleDeps {
  drizzle: (db: any) => DrizzleDb;
}

function getRequire(): NodeRequire {
  if (typeof require === 'function') {
    return require;
  }

  return createRequire(typeof __filename === 'string' ? __filename : `${process.cwd()}/package.json`);
}

let deps: DrizzleDeps | undefined;

function getDrizzleDeps(): DrizzleDeps {
  if (deps) {
    return deps;
  }

  if (isBun) {
    const bunSqlite = getRequire()('drizzle-orm/bun-sqlite') as {
      drizzle: (options: { client: any }) => DrizzleDb;
    };
    deps = {
      drizzle: (db: any) => bunSqlite.drizzle({ client: db }),
    };
    return deps;
  }

  try {
    const nodeSqlite = getRequire()('drizzle-orm/node-sqlite') as {
      drizzle: (options: { client: any }) => DrizzleDb;
    };
    deps = {
      drizzle: (db: any) => nodeSqlite.drizzle({ client: db }),
    };
    return deps;
  } catch {
    deps = {
      drizzle: (db: any) => drizzleNodeSqlite({ client: db }),
    };
  }
  return deps;
}

export function createDrizzleDb(sqliteDb: SqliteDatabase | any): DrizzleDb {
  const nativeDatabase = sqliteDb && typeof sqliteDb.getInternalDb === 'function'
    ? sqliteDb.getInternalDb()
    : sqliteDb;
  const db = getDrizzleDeps().drizzle(nativeDatabase);
  if (isBun) {
    db.$isBunSqlite = true;
  }
  return db;
}

export function createDrizzleSqliteDatabase(
  filePath: string,
  options: SqliteOpenOptions = {},
): { sqlite: SqliteDatabase; db: DrizzleDb } {
  const sqlite = createSqliteDatabase(filePath, {
    ...options,
    driver: isBun ? 'bun:sqlite' : 'node:sqlite',
  });
  return {
    sqlite,
    db: createDrizzleDb(sqlite),
  };
}
