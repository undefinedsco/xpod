declare module 'drizzle-orm/pg-core/columns/jsonb' {
  import { jsonb } from 'drizzle-orm/pg-core';
  export { jsonb };
}

declare module 'drizzle-orm/pg-core/columns/bigint' {
  import { bigint } from 'drizzle-orm/pg-core';
  export { bigint };
}

declare module 'drizzle-orm/pg-core/primary-keys' {
  import { primaryKey } from 'drizzle-orm/pg-core';
  export { primaryKey };
}

declare module 'drizzle-orm/node-postgres/session' {
  export type NodePgTransaction<TDatabase = unknown, TResult = unknown> = unknown;
}

declare module 'drizzle-orm/node-postgres' {
  export type NodePgDatabase = unknown;
  export function drizzle(...args: any[]): NodePgDatabase;
}

declare module 'drizzle-orm' {
  export const sql: any;
}
