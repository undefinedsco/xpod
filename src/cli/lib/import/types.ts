/**
 * Core types for the xpod import pipeline.
 *
 * Based on R2RML (rr:) with udfs: namespace extensions for filtering.
 */

// ============================================
// Mapping types
// ============================================

export interface ObjectMap {
  column?: string;
  template?: string;
  constant?: string;
  datatype?: string;
  language?: string;
}

export interface PredicateObjectMap {
  predicate: string;
  objectMap: ObjectMap;
}

export interface SubjectMap {
  template: string;
  class?: string;
}

export interface LogicalTable {
  tableName?: string;
  sqlQuery?: string;
}

export interface FilterWhitelistEntry {
  column: string;
  values: string[];
}

export interface FilterBlacklistEntry {
  column: string;
  values: string[];
}

export interface FilterTimeRange {
  column: string;
  after?: string;
  before?: string;
}

export interface Filters {
  whitelist?: FilterWhitelistEntry[];
  blacklist?: FilterBlacklistEntry[];
  timeRange?: FilterTimeRange;
}

export interface TriplesMap {
  id: string;
  logicalTable: LogicalTable;
  subjectMap: SubjectMap;
  predicateObjectMaps: PredicateObjectMap[];
  filters?: Filters;
}

// ============================================
// Data source types
// ============================================

export type DbType = 'postgres' | 'sqlite';

export interface DbSource {
  type: DbType;
  connectionString: string;
  encryption?: {
    cipher: string;
    key: string;
  };
}

// ============================================
// Import configuration
// ============================================

export type Granularity = 'per-table' | 'per-row';

export interface ImportOptions {
  dryRun: boolean;
  granularity: Granularity;
  baseIri?: string;
  /** Target path inside the Pod (e.g. "data/contacts.ttl") */
  targetPath: string;
}

/** A single row returned from a database query */
export type Row = Record<string, unknown>;

/** Unified database connection interface */
export interface DbConnection {
  query(sql: string): AsyncIterable<Row>;
  close(): Promise<void>;
}
