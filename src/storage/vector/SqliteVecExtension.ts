import type { SqliteDatabase } from '../SqliteRuntime';

interface SqliteVecModule {
  load?: (database: unknown, extensionPath: string) => void;
  getLoadablePath: () => string;
}

function getSqliteVecModule(): SqliteVecModule {
  return require('sqlite-vec') as SqliteVecModule;
}

export function getSqliteVecExtensionPath(): string {
  return getSqliteVecModule().getLoadablePath();
}

export function loadSqliteVecExtension(database: SqliteDatabase): void {
  const sqliteVec = getSqliteVecModule();
  const extensionPath = sqliteVec.getLoadablePath();

  if (database.kind === 'node-better-sqlite3' && sqliteVec.load) {
    sqliteVec.load(database.native, extensionPath);
    return;
  }

  database.loadExtension(extensionPath);
}
