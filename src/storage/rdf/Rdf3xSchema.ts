import type { SqliteDatabase } from '../SqliteRuntime';

export const RDF3X_GRAPH_PROJECTION_TABLE = 'rdf3x_stat_g';

export const RDF3X_PAIR_PROJECTION_TABLE_BY_NAME = {
  SP: 'rdf3x_stat_sp',
  SO: 'rdf3x_stat_so',
  PS: 'rdf3x_stat_ps',
  PO: 'rdf3x_stat_po',
  OS: 'rdf3x_stat_os',
  OP: 'rdf3x_stat_op',
} as const;

export const RDF3X_TERM_PROJECTION_TABLE_BY_NAME = {
  S: 'rdf3x_stat_s',
  P: 'rdf3x_stat_p',
  O: 'rdf3x_stat_o',
} as const;

export const RDF3X_DERIVED_TABLES = [
  'rdf3x_metadata',
  RDF3X_GRAPH_PROJECTION_TABLE,
  ...Object.values(RDF3X_PAIR_PROJECTION_TABLE_BY_NAME),
  ...Object.values(RDF3X_TERM_PROJECTION_TABLE_BY_NAME),
] as const;

export const RDF3X_MATERIALIZED_FACT_COPY_TABLES = [
  'rdf3x_triple_membership',
  'rdf3x_spo',
  'rdf3x_sop',
  'rdf3x_pso',
  'rdf3x_pos',
  'rdf3x_osp',
  'rdf3x_ops',
] as const;

export const RDF3X_DERIVED_INDEXES = [
  'rdf3x_membership_gspo',
  'rdf3x_membership_spo',
  'rdf3x_membership_source',
] as const;

export function dropRdf3xMaterializedFactCopies(db: SqliteDatabase): void {
  dropRdf3xObjects(db, RDF3X_MATERIALIZED_FACT_COPY_TABLES, RDF3X_DERIVED_INDEXES);
}

export function dropRdf3xDerivedSchemaObjects(db: SqliteDatabase): void {
  dropRdf3xObjects(
    db,
    [...RDF3X_DERIVED_TABLES, ...RDF3X_MATERIALIZED_FACT_COPY_TABLES],
    RDF3X_DERIVED_INDEXES,
  );
}

function dropRdf3xObjects(
  db: SqliteDatabase,
  names: readonly string[],
  indexes: readonly string[],
): void {
  db.exec(indexes.map((index) => `DROP INDEX IF EXISTS ${index};`).join('\n'));
  if (names.length === 0) {
    return;
  }

  const rows = db.prepare<{ name: string; type: string }>(`
    SELECT name, type
    FROM sqlite_schema
    WHERE name IN (${names.map(() => '?').join(', ')})
  `).all(...names);

  for (const row of rows) {
    if (row.type === 'view') {
      db.exec(`DROP VIEW IF EXISTS ${row.name};`);
    } else if (row.type === 'table') {
      db.exec(`DROP TABLE IF EXISTS ${row.name};`);
    }
  }
}
