import type { PostgresRdfSqlExecutor } from './PostgresRdfSqlExecutor';

type PostgresRdfIndexKind = 'text' | 'vector';

export async function pgHasAnyDomainTable(executor: PostgresRdfSqlExecutor, tables: string[]): Promise<boolean> {
  const placeholders = tables.map((_, index) => `$${index + 1}`).join(', ');
  const rows = await executor.query<{ count: number | string }>(`
    SELECT COUNT(*) AS count
    FROM pg_tables
    WHERE schemaname = current_schema()
      AND tablename IN (${placeholders})
  `, tables);
  return Number(rows[0]?.count ?? 0) > 0;
}

export async function assertPgRequiredColumns(
  executor: PostgresRdfSqlExecutor,
  table: string,
  requiredColumns: string[],
  indexKind: PostgresRdfIndexKind,
): Promise<void> {
  const rows = await executor.query<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = $1
  `, [table]);
  if (rows.length === 0) {
    throw new Error(`Unsupported PostgreSQL RDF ${indexKind} index schema: missing table ${table}`);
  }
  const columns = new Set(rows.map((row) => row.column_name));
  for (const column of requiredColumns) {
    if (!columns.has(column)) {
      throw new Error(`Unsupported PostgreSQL RDF ${indexKind} index schema: missing column ${table}.${column}`);
    }
  }
}

export async function assertPgNotNullColumn(
  executor: PostgresRdfSqlExecutor,
  table: string,
  column: string,
  indexKind: PostgresRdfIndexKind,
): Promise<void> {
  const rows = await executor.query<{ is_nullable: string }>(`
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = $1
      AND column_name = $2
  `, [table, column]);
  if (rows[0]?.is_nullable !== 'NO') {
    throw new Error(`Unsupported PostgreSQL RDF ${indexKind} index schema: column ${table}.${column} must be NOT NULL`);
  }
}

export async function assertPgColumnType(
  executor: PostgresRdfSqlExecutor,
  table: string,
  column: string,
  expectedUdtName: string,
  indexKind: PostgresRdfIndexKind,
): Promise<void> {
  const rows = await executor.query<{ udt_name: string }>(`
    SELECT udt_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = $1
      AND column_name = $2
  `, [table, column]);
  if (rows.length === 0) {
    throw new Error(`Unsupported PostgreSQL RDF ${indexKind} index schema: missing column ${table}.${column}`);
  }
  if (rows[0].udt_name !== expectedUdtName) {
    throw new Error(`Unsupported PostgreSQL RDF ${indexKind} index schema: column ${table}.${column} must have type ${expectedUdtName}`);
  }
}

export async function assertPgUniqueColumn(
  executor: PostgresRdfSqlExecutor,
  table: string,
  column: string,
  indexKind: PostgresRdfIndexKind,
): Promise<void> {
  const rows = await executor.query<{ count: number | string }>(`
    SELECT COUNT(*) AS count
    FROM pg_constraint constraint_info
    JOIN pg_class table_info ON table_info.oid = constraint_info.conrelid
    JOIN pg_namespace namespace_info ON namespace_info.oid = table_info.relnamespace
    JOIN unnest(constraint_info.conkey) WITH ORDINALITY AS constraint_key(attnum, ordinality) ON TRUE
    JOIN pg_attribute attribute
      ON attribute.attrelid = constraint_info.conrelid
     AND attribute.attnum = constraint_key.attnum
    WHERE namespace_info.nspname = current_schema()
      AND table_info.relname = $1
      AND constraint_info.contype = 'u'
      AND array_length(constraint_info.conkey, 1) = 1
      AND attribute.attname = $2
  `, [table, column]);
  if (Number(rows[0]?.count ?? 0) === 0) {
    throw new Error(`Unsupported PostgreSQL RDF ${indexKind} index schema: column ${table}.${column} must be UNIQUE`);
  }
}
