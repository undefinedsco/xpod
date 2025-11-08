import { sql } from 'drizzle-orm';
import type { IdentityDatabase } from './db';

export interface PodLookupResult {
  podId: string;
  accountId: string;
  baseUrl: string;
  edgeNodeId?: string;
}

export class PodLookupRepository {
  public constructor(private readonly db: IdentityDatabase) {}

  public async findByResourceIdentifier(resourcePath: string): Promise<PodLookupResult | undefined> {
    const podTable = sql.identifier(['identity_pod']);
    const baseUrlExpr = sql`(${sql.identifier(['payload'])} ->> 'baseUrl')`;
    const accountExpr = sql`(${sql.identifier(['payload'])} ->> 'accountId')`;
    const edgeNodeExpr = sql`(${sql.identifier(['payload'])} ->> 'edgeNodeId')`;
    const result = await this.db.execute(sql`
      SELECT id, ${accountExpr} AS account_id, ${baseUrlExpr} AS base_url, ${edgeNodeExpr} AS edge_node_id
      FROM ${podTable}
      WHERE ${baseUrlExpr} IS NOT NULL
        AND ${resourcePath} LIKE ${baseUrlExpr} || '%'
      ORDER BY length(${baseUrlExpr}) DESC
      LIMIT 1
    `);
    if (result.rows.length === 0) {
      return undefined;
    }
    const row = result.rows[0];
    return {
      podId: row.id as string,
      accountId: row.account_id as string,
      baseUrl: row.base_url as string,
      edgeNodeId: row.edge_node_id == null ? undefined : String(row.edge_node_id),
    };
  }
}
