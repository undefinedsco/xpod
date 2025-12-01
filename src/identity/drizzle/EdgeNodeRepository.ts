import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import type { IdentityDatabase } from './db';
import { edgeNodes } from './schema';

export interface EdgeNodeSummary {
  nodeId: string;
  displayName?: string;
  podCount: number;
  createdAt?: string;
  updatedAt?: string;
  lastSeen?: string;
  metadata?: Record<string, unknown> | null;
}

export interface CreateEdgeNodeResult {
  nodeId: string;
  token: string;
  createdAt: string;
}

export interface EdgeNodeSecret {
  nodeId: string;
  displayName?: string;
  tokenHash: string;
  metadata?: Record<string, unknown> | null;
}

export class EdgeNodeRepository {
  public constructor(private readonly db: IdentityDatabase) {}

  public async listNodes(): Promise<EdgeNodeSummary[]> {
    const result = await this.db.execute(sql`
      SELECT en.id,
             en.display_name,
             en.created_at,
             en.updated_at,
             en.last_seen,
             en.metadata,
             COALESCE(pods.count, 0) AS pod_count
      FROM identity_edge_node en
      LEFT JOIN (
        SELECT node_id, COUNT(*)::integer AS count
        FROM identity_edge_node_pod
        GROUP BY node_id
      ) pods ON pods.node_id = en.id
      ORDER BY en.created_at ASC
    `);

    return result.rows.map((row: any): EdgeNodeSummary => ({
      nodeId: String(row.id),
      displayName: row.display_name == null ? undefined : String(row.display_name),
      podCount: Number(row.pod_count ?? 0),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : undefined,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : undefined,
      lastSeen: row.last_seen instanceof Date ? row.last_seen.toISOString() : undefined,
      metadata: row.metadata ?? null,
    }));
  }

  public async createNode(displayName?: string): Promise<CreateEdgeNodeResult> {
    const nodeId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = new Date();

    await this.db.execute(sql`
      INSERT INTO identity_edge_node (id, display_name, token_hash, created_at, updated_at)
      VALUES (${nodeId}, ${displayName ?? null}, ${tokenHash}, ${now}, ${now})
    `);

    return {
      nodeId,
      token,
      createdAt: now.toISOString(),
    };
  }

  public async getNodeSecret(nodeId: string): Promise<EdgeNodeSecret | undefined> {
    const result = await this.db.execute(sql`
      SELECT id, display_name, token_hash, metadata
      FROM identity_edge_node
      WHERE id = ${nodeId}
      LIMIT 1
    `);
    if (result.rows.length === 0) {
      return undefined;
    }
    const row = result.rows[0];
    return {
      nodeId: String(row.id),
      displayName: row.display_name == null ? undefined : String(row.display_name),
      tokenHash: String(row.token_hash ?? ''),
      metadata: row.metadata ?? null,
    };
  }

  public async updateNodeHeartbeat(nodeId: string, metadata: Record<string, unknown> | null, timestamp: Date): Promise<void> {
    const payload = metadata == null ? null : JSON.stringify(metadata);
    await this.db.execute(sql`
      UPDATE identity_edge_node
      SET metadata = ${payload}::jsonb,
          last_seen = ${timestamp},
          updated_at = ${timestamp}
      WHERE id = ${nodeId}
    `);
  }

  public async updateNodeMode(nodeId: string, options: {
    accessMode: 'direct' | 'proxy';
    publicIp?: string;
    publicPort?: number;
    subdomain?: string;
    connectivityStatus?: 'unknown' | 'reachable' | 'unreachable';
    capabilities?: Record<string, unknown>;
  }): Promise<void> {
    const capabilitiesPayload = options.capabilities ? JSON.stringify(options.capabilities) : null;
    const now = new Date();
    
    await this.db.execute(sql`
      UPDATE identity_edge_node
      SET access_mode = ${options.accessMode},
          public_ip = ${options.publicIp ?? null},
          public_port = ${options.publicPort ?? null},
          subdomain = ${options.subdomain ?? null},
          connectivity_status = ${options.connectivityStatus ?? 'unknown'},
          capabilities = ${capabilitiesPayload}::jsonb,
          last_connectivity_check = ${now},
          updated_at = ${now}
      WHERE id = ${nodeId}
    `);
  }

  public async getNodeConnectivityInfo(nodeId: string): Promise<{
    nodeId: string;
    accessMode?: string;
    publicIp?: string;
    publicPort?: number;
    subdomain?: string;
    connectivityStatus?: string;
    lastConnectivityCheck?: Date;
  } | undefined> {
    const result = await this.db.execute(sql`
      SELECT id, access_mode, public_ip, public_port, subdomain, 
             connectivity_status, last_connectivity_check
      FROM identity_edge_node
      WHERE id = ${nodeId}
      LIMIT 1
    `);
    
    if (result.rows.length === 0) {
      return undefined;
    }
    
    const row = result.rows[0];
    return {
      nodeId: String(row.id),
      accessMode: row.access_mode ? String(row.access_mode) : undefined,
      publicIp: row.public_ip ? String(row.public_ip) : undefined,
      publicPort: row.public_port ? Number(row.public_port) : undefined,
      subdomain: row.subdomain ? String(row.subdomain) : undefined,
      connectivityStatus: row.connectivity_status ? String(row.connectivity_status) : undefined,
      lastConnectivityCheck: row.last_connectivity_check instanceof Date ? row.last_connectivity_check : undefined,
    };
  }

  public async mergeNodeMetadata(nodeId: string, patch: Record<string, unknown>): Promise<void> {
    const payload = JSON.stringify(patch);
    await this.db.execute(sql`
      UPDATE identity_edge_node
      SET metadata = COALESCE(metadata, '{}'::jsonb) || ${payload}::jsonb,
          updated_at = now()
      WHERE id = ${nodeId}
    `);
  }

  public async getNodeMetadata(nodeId: string): Promise<{ nodeId: string; metadata: Record<string, unknown> | null; lastSeen?: Date } | undefined> {
    const result = await this.db.execute(sql`
      SELECT id, metadata, last_seen
      FROM identity_edge_node
      WHERE id = ${nodeId}
      LIMIT 1
    `);
    if (result.rows.length === 0) {
      return undefined;
    }
    const row = result.rows[0];
    return {
      nodeId: String(row.id),
      metadata: row.metadata ?? null,
      lastSeen: row.last_seen instanceof Date ? row.last_seen : undefined,
    };
  }

  public async replaceNodePods(nodeId: string, pods: string[]): Promise<void> {
    await this.db.transaction(async (tx: IdentityDatabase) => {
      await tx.execute(sql`DELETE FROM identity_edge_node_pod WHERE node_id = ${nodeId}`);
      if (pods.length > 0) {
        const values = pods.map((baseUrl) => sql`(${nodeId}, ${baseUrl})`);
        await tx.execute(sql`
          INSERT INTO identity_edge_node_pod (node_id, base_url)
          VALUES ${sql.join(values, sql`, `)}
          ON CONFLICT DO NOTHING
        `);
      }
    });
  }

  public async findNodeByResourcePath(path: string): Promise<{ nodeId: string; baseUrl: string; accessMode?: string; metadata?: Record<string, unknown> | null } | undefined> {
    const result = await this.db.execute(sql`
      SELECT en.id,
             en.access_mode,
             en.metadata,
             pods.base_url
      FROM identity_edge_node_pod pods
      JOIN identity_edge_node en ON en.id = pods.node_id
      WHERE ${path} LIKE pods.base_url || '%'
      ORDER BY length(pods.base_url) DESC
      LIMIT 1
    `);
    if (result.rows.length === 0) {
      return undefined;
    }
    const row = result.rows[0];
    return {
      nodeId: String(row.id),
      baseUrl: String(row.base_url),
      accessMode: row.access_mode ? String(row.access_mode) : undefined,
      metadata: row.metadata ?? null,
    };
  }

  public async findNodeBySubdomain(hostname: string): Promise<{ nodeId: string; accessMode?: string; metadata?: Record<string, unknown> | null; subdomain?: string } | undefined> {
    const normalized = hostname.trim().toLowerCase();
    if (normalized.length === 0) {
      return undefined;
    }
    const result = await this.db.execute(sql`
      SELECT id, access_mode, metadata, subdomain
      FROM identity_edge_node
      WHERE subdomain = ${normalized}
      LIMIT 1
    `);
    if (result.rows.length === 0) {
      return undefined;
    }
    const row = result.rows[0];
    return {
      nodeId: String(row.id),
      accessMode: row.access_mode ? String(row.access_mode) : undefined,
      metadata: row.metadata ?? null,
      subdomain: row.subdomain ? String(row.subdomain) : undefined,
    };
  }

  public matchesToken(tokenHash: string, token: string): boolean {
    if (!tokenHash || typeof tokenHash !== 'string') {
      return false;
    }
    try {
      const expected = Buffer.from(tokenHash, 'hex');
      const actual = createHash('sha256').update(token).digest();
      if (expected.length !== actual.length) {
        return false;
      }
      return timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }

  /**
   * Get node capabilities and related information for admin queries
   */
  public async getNodeCapabilities(nodeId: string): Promise<{
    nodeId: string;
    capabilities: Record<string, unknown> | null;
    stringCapabilities: string[] | null;
    accessMode: string | null;
    lastSeen: Date | null;
    connectivityStatus: string | null;
  } | undefined> {
    const row = await this.db
      .select({
        id: edgeNodes.id,
        capabilities: edgeNodes.capabilities,
        metadata: edgeNodes.metadata,
        accessMode: edgeNodes.accessMode,
        lastSeen: edgeNodes.lastSeen,
        connectivityStatus: edgeNodes.connectivityStatus,
      })
      .from(edgeNodes)
      .where(eq(edgeNodes.id, nodeId))
      .limit(1);

    if (row.length === 0) {
      return undefined;
    }

    const node = row[0];
    const metadata = node.metadata as Record<string, unknown> | null;
    
    return {
      nodeId: node.id,
      capabilities: node.capabilities as Record<string, unknown> | null,
      stringCapabilities: metadata?.capabilities as string[] ?? null,
      accessMode: node.accessMode,
      lastSeen: node.lastSeen,
      connectivityStatus: node.connectivityStatus,
    };
  }

  /**
   * List all nodes with their capability information
   */
  public async listNodeCapabilities(): Promise<Array<{
    nodeId: string;
    capabilities: Record<string, unknown> | null;
    stringCapabilities: string[] | null;
    accessMode: string | null;
    lastSeen: Date | null;
    connectivityStatus: string | null;
  }>> {
    const rows = await this.db
      .select({
        id: edgeNodes.id,
        capabilities: edgeNodes.capabilities,
        metadata: edgeNodes.metadata,
        accessMode: edgeNodes.accessMode,
        lastSeen: edgeNodes.lastSeen,
        connectivityStatus: edgeNodes.connectivityStatus,
      })
      .from(edgeNodes)
      .orderBy(edgeNodes.lastSeen);

    return rows.map((row: typeof rows[0]) => {
      const metadata = row.metadata as Record<string, unknown> | null;
      
      return {
        nodeId: row.id,
        capabilities: row.capabilities as Record<string, unknown> | null,
        stringCapabilities: metadata?.capabilities as string[] ?? null,
        accessMode: row.accessMode,
        lastSeen: row.lastSeen,
        connectivityStatus: row.connectivityStatus,
      };
    });
  }
}
