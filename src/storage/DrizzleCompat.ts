/**
 * Drizzle ORM Compatibility Layer
 *
 * Auto-selects better-sqlite3 or bun-sqlite driver based on runtime
 */

import type { SQL } from 'drizzle-orm';

const isBun = typeof (globalThis as any).Bun !== 'undefined';

export type DrizzleDb = any;

interface DrizzleDeps {
  drizzle: (db: any) => DrizzleDb;
}

let deps: DrizzleDeps | undefined;

export async function getDrizzleDeps(): Promise<DrizzleDeps> {
  if (deps) return deps;

  if (isBun) {
    const bunSqlite = await import('drizzle-orm/bun-sqlite');
    deps = { drizzle: bunSqlite.drizzle };
  } else {
    const betterSqlite = await import('drizzle-orm/better-sqlite3');
    deps = { drizzle: betterSqlite.drizzle };
  }

  return deps;
}

/**
 * Create Drizzle database instance
 */
export async function createDrizzleDb(sqliteDb: any): Promise<DrizzleDb> {
  const { drizzle } = await getDrizzleDeps();
  const db = drizzle(sqliteDb);
  // Mark as Bun SQLite for db.ts detection
  if (isBun) {
    db.$isBunSqlite = true;
  }
  return db;
}
