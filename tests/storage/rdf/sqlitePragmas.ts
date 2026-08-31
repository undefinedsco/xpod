export function readSqlitePragmas(index: object): {
  journalMode: string;
  busyTimeout: number;
  synchronous: number;
} {
  const db = (index as unknown as {
    requireDb(): {
      prepare<T>(sql: string): { get(...params: unknown[]): T | undefined };
    };
  }).requireDb();
  return {
    journalMode: String(firstPragmaValue(db.prepare<Record<string, unknown>>('PRAGMA journal_mode').get()) ?? '').toLowerCase(),
    busyTimeout: Number(firstPragmaValue(db.prepare<Record<string, unknown>>('PRAGMA busy_timeout').get()) ?? 0),
    synchronous: Number(firstPragmaValue(db.prepare<Record<string, unknown>>('PRAGMA synchronous').get()) ?? 0),
  };
}

function firstPragmaValue(row: Record<string, unknown> | undefined): unknown {
  return row ? Object.values(row)[0] : undefined;
}
