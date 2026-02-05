declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string);
    query(sql: string): {
      get(...params: any[]): any;
      all(...params: any[]): any[];
      run(...params: any[]): { changes: number; lastInsertRowid: number };
    };
    exec(sql: string): void;
    transaction(fn: () => void): () => void;
    close(): void;
  }
}

declare module 'drizzle-orm/bun-sqlite' {
  import { Database } from 'bun:sqlite';
  export interface BunSQLiteDatabase {
    select(): any;
    insert(table: any): any;
    update(table: any): any;
    delete(table: any): any;
  }
  export function drizzle(db: Database): BunSQLiteDatabase;
}
