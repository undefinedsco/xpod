import path from 'node:path';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { getLoggerFor } from 'global-logger-factory';
import { getSqliteRuntime } from '../../storage/SqliteRuntime';
import { getSharedPool } from '../../storage/database/PostgresPoolManager';
import { isSqliteUrl } from '../../identity/drizzle/db';
import { ensureTaskCredentialTables, taskCredentialSchema } from './TaskCredentialSchema';

/** Which table layout a task-layer database handle uses. */
export interface TaskCredentialDatabase {
  db: any;
  schema: typeof taskCredentialSchema.sqlite | typeof taskCredentialSchema.pg;
}

const databaseCache = new Map<string, TaskCredentialDatabase>();

/**
 * Where the task layer keeps its own credentials.
 *
 * An explicit URL wins. Otherwise a SQLite deployment gets a sibling file next to the identity
 * database, so a leak of one store says nothing about the other. A PostgreSQL deployment keeps the
 * same server for now: the deployment follow-up is a dedicated role or schema, which is a
 * deployment decision rather than something to guess here.
 */
export function resolveTaskCredentialDatabaseUrl(input: {
  identityDatabaseUrl: string;
  configuredUrl?: string;
}): string {
  const configured = input.configuredUrl?.trim();
  if (configured) {
    return configured;
  }
  const identity = input.identityDatabaseUrl.trim();
  if (!identity) {
    throw new Error('task_credential_database_unconfigured');
  }
  if (isSqliteUrl(identity)) {
    const filename = identity.replace(/^sqlite:(\/\/)?/u, '');
    if (filename.startsWith(':memory:')) {
      // One in-memory deployment cannot host two independent files; tests get their own URL.
      return identity;
    }
    return `sqlite:${path.join(path.dirname(filename), 'tasks.sqlite')}`;
  }
  return identity;
}

/** Opens (once per URL) the task-layer database and makes sure its table exists. */
export function getTaskCredentialDatabase(url: string): TaskCredentialDatabase {
  const cached = databaseCache.get(url);
  if (cached) {
    return cached;
  }

  if (isSqliteUrl(url)) {
    const filename = url.replace(/^sqlite:(\/\/)?/u, '');
    const isMemory = filename === ':memory:' || filename.startsWith(':memory:');
    const runtime = getSqliteRuntime();
    const sqlite = runtime.openDatabase(isMemory ? ':memory:' : filename);
    if (!isMemory) {
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('busy_timeout = 5000');
      sqlite.pragma('synchronous = NORMAL');
    }
    const db = runtime.createDrizzleDatabase(sqlite);
    void ensureTaskCredentialTables(db).catch((error: unknown) => {
      getLoggerFor('TaskCredentialDatabase').error(`Task credential table unavailable: ${String(error)}`);
    });
    const handle: TaskCredentialDatabase = { db, schema: taskCredentialSchema.sqlite };
    databaseCache.set(url, handle);
    return handle;
  }

  const db = drizzlePg(getSharedPool({ connectionString: url }));
  void ensureTaskCredentialTables(db).catch((error: unknown) => {
    getLoggerFor('TaskCredentialDatabase').error(`Task credential table unavailable: ${String(error)}`);
  });
  const handle: TaskCredentialDatabase = { db, schema: taskCredentialSchema.pg };
  databaseCache.set(url, handle);
  return handle;
}

/** Test helper: forget cached handles so a fresh database can be opened at the same URL. */
export function resetTaskCredentialDatabases(): void {
  databaseCache.clear();
}

export { taskCredentialSchema };
