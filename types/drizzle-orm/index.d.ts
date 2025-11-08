declare module 'drizzle-orm' {
  export const sql: any;
  export function eq(a: any, b: any): any;
  export function and(...args: any[]): any;
  export function or(...args: any[]): any;
}

declare module 'drizzle-orm/node-postgres' {
  export interface NodePgDatabase {
    execute(query: any, params?: unknown[]): Promise<{ rows: any[] }>;
    transaction<T>(fn: (db: NodePgDatabase) => Promise<T>): Promise<T>;
    insert(table: any): any;
    select(selection: any): any;
  }
  export function drizzle(pool: any): NodePgDatabase;
}

declare module 'drizzle-orm/pg-core' {
  export function pgTable(name: string, columns: Record<string, any>): any;
  export function text(name: string): any;
  export function boolean(name: string): any;
  export function numeric(name: string): any;
  export function timestamp(name: string, options?: Record<string, any>): any;
}
