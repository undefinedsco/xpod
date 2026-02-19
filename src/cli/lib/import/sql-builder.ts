/**
 * Build SQL queries from TriplesMap logical tables + udfs:filter extensions.
 *
 * Handles:
 * - rr:tableName → SELECT * FROM "tableName"
 * - rr:sqlQuery  → use as-is (wrapped as subquery if filters apply)
 * - udfs:filter  → WHERE clauses for whitelist/blacklist/timeRange
 */

import type { TriplesMap, Filters } from './types';

/**
 * Escape a SQL string value (single quotes doubled).
 * This is for building static filter clauses from mapping config — NOT user input.
 */
function escapeStr(val: string): string {
  return val.replace(/'/g, "''");
}

function buildWhereClause(filters: Filters): string {
  const conditions: string[] = [];

  if (filters.whitelist) {
    for (const entry of filters.whitelist) {
      const vals = entry.values.map((v) => `'${escapeStr(v)}'`).join(', ');
      conditions.push(`"${entry.column}" IN (${vals})`);
    }
  }

  if (filters.blacklist) {
    for (const entry of filters.blacklist) {
      const vals = entry.values.map((v) => `'${escapeStr(v)}'`).join(', ');
      conditions.push(`"${entry.column}" NOT IN (${vals})`);
    }
  }

  if (filters.timeRange) {
    const { column, after, before } = filters.timeRange;
    if (after) {
      conditions.push(`"${column}" >= '${escapeStr(after)}'`);
    }
    if (before) {
      conditions.push(`"${column}" < '${escapeStr(before)}'`);
    }
  }

  return conditions.length > 0 ? conditions.join(' AND ') : '';
}

/**
 * Build a SQL query string from a TriplesMap definition.
 */
export function buildSql(map: TriplesMap): string {
  const where = map.filters ? buildWhereClause(map.filters) : '';

  if (map.logicalTable.sqlQuery) {
    // User-provided SQL query
    if (!where) return map.logicalTable.sqlQuery;
    // Wrap as subquery and apply filters
    return `SELECT * FROM (${map.logicalTable.sqlQuery}) AS _sub WHERE ${where}`;
  }

  if (map.logicalTable.tableName) {
    const base = `SELECT * FROM "${map.logicalTable.tableName}"`;
    return where ? `${base} WHERE ${where}` : base;
  }

  throw new Error(`TriplesMap "${map.id}" has neither tableName nor sqlQuery`);
}
