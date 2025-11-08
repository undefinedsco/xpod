import { Pool, types } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

export type IdentityDatabase = any;

const dbCache = new Map<string, { pool: Pool; db: IdentityDatabase }>();

const JSON_OIDS = [ 114, 3802 ];

for (const oid of JSON_OIDS) {
  types.setTypeParser(oid, (value) => (value == null ? null : JSON.parse(value)));
}

export function getIdentityDatabase(connectionString: string): IdentityDatabase {
  let cached = dbCache.get(connectionString);
  if (cached) {
    return cached.db;
  }
  const pool = new Pool({ connectionString });
  const db = drizzle(pool);
  cached = { pool, db };
  dbCache.set(connectionString, cached);
  return db;
}

export async function closeAllIdentityConnections(): Promise<void> {
  await Promise.all([...dbCache.values()].map(({ pool }) => pool.end()));
  dbCache.clear();
}
