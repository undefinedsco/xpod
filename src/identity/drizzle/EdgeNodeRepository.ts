import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import type { IdentityDatabase } from './db';
import { executeStatement, executeQuery, toDbTimestamp, fromDbTimestamp } from './db';
import { edgeNodes } from './schema';

export interface EdgeNodeSummary {
  nodeId: string;
  displayName?: string;
  nodeType: 'center' | 'edge' | 'sp';
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
  nodeType: 'center' | 'edge' | 'sp';
  metadata?: Record<string, unknown> | null;
}

export interface CenterNodeInfo {
  nodeId: string;
  displayName?: string;
  internalIp: string;
  internalPort: number;
  connectivityStatus: 'unknown' | 'reachable' | 'unreachable';
  lastSeen?: Date;
}

export interface CreateSpNodeResult {
  nodeId: string;
  nodeToken: string;
  serviceToken: string;
  createdAt: string;
}

export interface SpNodeInfo {
  nodeId: string;
  displayName?: string;
  publicUrl: string;
  serviceTokenHash: string;
  lastSeen?: Date;
}

export class EdgeNodeRepository {
  public constructor(private readonly db: IdentityDatabase) {}

  public async listNodes(): Promise<EdgeNodeSummary[]> {
    const result = await executeQuery(this.db, sql`
      SELECT en.id,
             en.display_name,
             en.node_type,
             en.created_at,
             en.updated_at,
             en.last_seen,
             en.metadata,
             COALESCE(pods.count, 0) AS pod_count
      FROM identity_edge_node en
      LEFT JOIN (
        SELECT node_id, COUNT(*) AS count
        FROM identity_edge_node_pod
        GROUP BY node_id
      ) pods ON pods.node_id = en.id
      ORDER BY en.created_at ASC
    `);

    return result.rows.map((row: any): EdgeNodeSummary => {
      const createdAt = fromDbTimestamp(row.created_at);
      const updatedAt = fromDbTimestamp(row.updated_at);
      const lastSeen = fromDbTimestamp(row.last_seen);
      return {
        nodeId: String(row.id),
        displayName: row.display_name == null ? undefined : String(row.display_name),
        nodeType: (['center', 'edge', 'sp'].includes(row.node_type) ? row.node_type : 'edge') as 'center' | 'edge' | 'sp',
        podCount: Number(row.pod_count ?? 0),
        createdAt: createdAt?.toISOString(),
        updatedAt: updatedAt?.toISOString(),
        lastSeen: lastSeen?.toISOString(),
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? null),
      };
    });
  }

  public async createNode(displayName?: string, _accountId?: string): Promise<CreateEdgeNodeResult> {
    const nodeId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = new Date();
    const ts = toDbTimestamp(this.db, now);

    await executeStatement(this.db, sql`
      INSERT INTO identity_edge_node (id, display_name, token_hash, created_at, updated_at)
      VALUES (${nodeId}, ${displayName ?? null}, ${tokenHash}, ${ts}, ${ts})
    `);

    return {
      nodeId,
      token,
      createdAt: now.toISOString(),
    };
  }

  /**
   * Node/account 关系待产品化后单独建模；当前阶段不再在节点表上持久化账号归属。
   */
  public async getNodeOwner(_nodeId: string): Promise<string | undefined> {
    return undefined;
  }

  public async getNodeSecret(nodeId: string): Promise<EdgeNodeSecret | undefined> {
    const result = await executeQuery(this.db, sql`
      SELECT id, display_name, token_hash, node_type, metadata
      FROM identity_edge_node
      WHERE id = ${nodeId}
      LIMIT 1
    `);
    if (result.rows.length === 0) {
      return undefined;
    }
    const row = result.rows[0] as any;
    return {
      nodeId: String(row.id),
      displayName: row.display_name == null ? undefined : String(row.display_name),
      tokenHash: String(row.token_hash ?? ''),
      nodeType: (['center', 'edge', 'sp'].includes(row.node_type) ? row.node_type : 'edge') as 'center' | 'edge' | 'sp',
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? null),
    };
  }

  public async updateNodeHeartbeat(nodeId: string, metadata: Record<string, unknown> | null, timestamp: Date): Promise<void> {
    const payload = metadata == null ? null : JSON.stringify(metadata);
    const ts = toDbTimestamp(this.db, timestamp);

    await executeStatement(this.db, sql`
      UPDATE identity_edge_node
      SET metadata = ${payload},
          last_seen = ${ts},
          updated_at = ${ts}
      WHERE id = ${nodeId}
    `);
  }

  public async updateNodeMode(nodeId: string, options: {
    accessMode: 'direct' | 'proxy';
    ipv4?: string;
    publicPort?: number;
    subdomain?: string;
    connectivityStatus?: 'unknown' | 'reachable' | 'unreachable';
    capabilities?: Record<string, unknown>;
  }): Promise<void> {
    const capabilitiesPayload = options.capabilities ? JSON.stringify(options.capabilities) : null;
    const now = new Date();
    const ts = toDbTimestamp(this.db, now);

    await executeStatement(this.db, sql`
      UPDATE identity_edge_node
      SET access_mode = ${options.accessMode},
          ipv4 = ${options.ipv4 ?? null},
          public_port = ${options.publicPort ?? null},
          subdomain = ${options.subdomain ?? null},
          connectivity_status = ${options.connectivityStatus ?? 'unknown'},
          capabilities = ${capabilitiesPayload},
          last_connectivity_check = ${ts},
          updated_at = ${ts}
      WHERE id = ${nodeId}
    `);
  }

  public async getNodeConnectivityInfo(nodeId: string): Promise<{
    nodeId: string;
    accessMode?: string;
    ipv4?: string;
    publicPort?: number;
    subdomain?: string;
    connectivityStatus?: string;
    lastConnectivityCheck?: Date;
  } | undefined> {
    const result = await executeQuery(this.db, sql`
      SELECT id, access_mode, ipv4, public_port, subdomain,
             connectivity_status, last_connectivity_check
      FROM identity_edge_node
      WHERE id = ${nodeId}
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return undefined;
    }

    const row = result.rows[0] as any;
    return {
      nodeId: String(row.id),
      accessMode: row.access_mode ? String(row.access_mode) : undefined,
      ipv4: row.ipv4 ? String(row.ipv4) : undefined,
      publicPort: row.public_port ? Number(row.public_port) : undefined,
      subdomain: row.subdomain ? String(row.subdomain) : undefined,
      connectivityStatus: row.connectivity_status ? String(row.connectivity_status) : undefined,
      lastConnectivityCheck: fromDbTimestamp(row.last_connectivity_check),
    };
  }

  public async mergeNodeMetadata(nodeId: string, patch: Record<string, unknown>): Promise<void> {
    // Read current metadata
    const current = await this.getNodeMetadata(nodeId);
    if (!current) {
      throw new Error(`Node ${nodeId} not found`);
    }

    // Merge in application layer
    const merged = { ...(current.metadata ?? {}), ...patch };
    const payload = JSON.stringify(merged);
    const ts = toDbTimestamp(this.db, new Date());

    await executeStatement(this.db, sql`
      UPDATE identity_edge_node
      SET metadata = ${payload},
          updated_at = ${ts}
      WHERE id = ${nodeId}
    `);
  }

  public async getNodeMetadata(nodeId: string): Promise<{ nodeId: string; metadata: Record<string, unknown> | null; lastSeen?: Date } | undefined> {
    const result = await executeQuery(this.db, sql`
      SELECT id, metadata, last_seen
      FROM identity_edge_node
      WHERE id = ${nodeId}
      LIMIT 1
    `);
    if (result.rows.length === 0) {
      return undefined;
    }
    const row = result.rows[0] as any;
    return {
      nodeId: String(row.id),
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? null),
      lastSeen: fromDbTimestamp(row.last_seen),
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
    const result = await executeQuery(this.db, sql`
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
    const row = result.rows[0] as any;
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
    const result = await executeQuery(this.db, sql`
      SELECT id, access_mode, metadata, subdomain
      FROM identity_edge_node
      WHERE subdomain = ${normalized}
      LIMIT 1
    `);
    if (result.rows.length === 0) {
      return undefined;
    }
    const row = result.rows[0] as any;
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

  // ============ Center Node Methods ============

  /**
   * Register or update a center node in the cluster.
   * Center nodes use the same table as edge nodes but with nodeType='center'.
   */
  public async registerCenterNode(options: {
    nodeId: string;
    displayName?: string;
    internalIp: string;
    internalPort: number;
  }): Promise<{ nodeId: string; token: string }> {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = Math.floor(Date.now() / 1000); // Unix timestamp for SQLite compatibility

    // Use upsert pattern: INSERT ... ON CONFLICT UPDATE
    await executeStatement(this.db, sql`
      INSERT INTO identity_edge_node (
        id, display_name, token_hash, node_type, internal_ip, internal_port,
        connectivity_status, created_at, updated_at, last_seen
      )
      VALUES (
        ${options.nodeId}, ${options.displayName ?? null}, ${tokenHash}, 'center',
        ${options.internalIp}, ${options.internalPort}, 'unknown', ${now}, ${now}, ${now}
      )
      ON CONFLICT (id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        internal_ip = EXCLUDED.internal_ip,
        internal_port = EXCLUDED.internal_port,
        updated_at = EXCLUDED.updated_at,
        last_seen = EXCLUDED.last_seen
    `);

    return { nodeId: options.nodeId, token };
  }

  /**
   * Update center node heartbeat with internal endpoint info.
   */
  public async updateCenterNodeHeartbeat(
    nodeId: string,
    internalIp: string,
    internalPort: number,
    timestamp: Date,
  ): Promise<void> {
    const ts = Math.floor(timestamp.getTime() / 1000); // Unix timestamp for SQLite compatibility
    await executeStatement(this.db, sql`
      UPDATE identity_edge_node
      SET internal_ip = ${internalIp},
          internal_port = ${internalPort},
          last_seen = ${ts},
          updated_at = ${ts},
          connectivity_status = 'reachable'
      WHERE id = ${nodeId} AND node_type = 'center'
    `);
  }

  /**
   * List all center nodes in the cluster.
   */
  public async listCenterNodes(): Promise<CenterNodeInfo[]> {
    const result = await executeQuery(this.db, sql`
      SELECT id, display_name, internal_ip, internal_port, connectivity_status, last_seen
      FROM identity_edge_node
      WHERE node_type = 'center'
      ORDER BY created_at ASC
    `);

    return result.rows.map((row: any): CenterNodeInfo => ({
      nodeId: String(row.id),
      displayName: row.display_name == null ? undefined : String(row.display_name),
      internalIp: String(row.internal_ip ?? ''),
      internalPort: Number(row.internal_port ?? 0),
      connectivityStatus: (row.connectivity_status ?? 'unknown') as 'unknown' | 'reachable' | 'unreachable',
      lastSeen: fromDbTimestamp(row.last_seen),
    }));
  }

  /**
   * Get a specific center node by ID.
   */
  public async getCenterNode(nodeId: string): Promise<CenterNodeInfo | undefined> {
    const result = await executeQuery(this.db, sql`
      SELECT id, display_name, internal_ip, internal_port, connectivity_status, last_seen
      FROM identity_edge_node
      WHERE id = ${nodeId} AND node_type = 'center'
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return undefined;
    }

    const row = result.rows[0] as any;
    return {
      nodeId: String(row.id),
      displayName: row.display_name == null ? undefined : String(row.display_name),
      internalIp: String(row.internal_ip ?? ''),
      internalPort: Number(row.internal_port ?? 0),
      connectivityStatus: (row.connectivity_status ?? 'unknown') as 'unknown' | 'reachable' | 'unreachable',
      lastSeen: fromDbTimestamp(row.last_seen),
    };
  }

  /**
   * Find a center node by its internal endpoint (for routing).
   */
  public async findCenterNodeByEndpoint(internalIp: string, internalPort: number): Promise<CenterNodeInfo | undefined> {
    const result = await executeQuery(this.db, sql`
      SELECT id, display_name, internal_ip, internal_port, connectivity_status, last_seen
      FROM identity_edge_node
      WHERE node_type = 'center' AND internal_ip = ${internalIp} AND internal_port = ${internalPort}
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return undefined;
    }

    const row = result.rows[0] as any;
    return {
      nodeId: String(row.id),
      displayName: row.display_name == null ? undefined : String(row.display_name),
      internalIp: String(row.internal_ip ?? ''),
      internalPort: Number(row.internal_port ?? 0),
      connectivityStatus: (row.connectivity_status ?? 'unknown') as 'unknown' | 'reachable' | 'unreachable',
      lastSeen: fromDbTimestamp(row.last_seen),
    };
  }

  /**
   * Mark a center node as unreachable (for health checks).
   */
  public async markCenterNodeUnreachable(nodeId: string): Promise<void> {
    const ts = toDbTimestamp(this.db, new Date());
    await executeStatement(this.db, sql`
      UPDATE identity_edge_node
      SET connectivity_status = 'unreachable',
          updated_at = ${ts}
      WHERE id = ${nodeId} AND node_type = 'center'
    `);
  }

  /**
   * Remove a center node from the cluster.
   */
  public async removeCenterNode(nodeId: string): Promise<boolean> {
    // Note: For SQLite, we can't easily get affected row count, so just execute and return true
    await executeStatement(this.db, sql`
      DELETE FROM identity_edge_node
      WHERE id = ${nodeId} AND node_type = 'center'
    `);
    return true;
  }

  // ============ Account-based Node Methods ============

  /**
   * List nodes owned by a specific account
   */
  public async listNodesByAccount(accountId: string): Promise<Array<{
    nodeId: string;
    displayName?: string;
    capabilities: Record<string, unknown> | null;
    stringCapabilities: string[] | null;
    accessMode: string | null;
    lastSeen: Date | null;
    connectivityStatus: string | null;
  }>> {
    void accountId;
    return [];
  }

  /**
   * Delete a node
   */
  public async deleteNode(nodeId: string): Promise<boolean> {
    // First delete associated pods
    await executeStatement(this.db, sql`
      DELETE FROM identity_edge_node_pod WHERE node_id = ${nodeId}
    `);

    // Then delete the node
    const result = await executeQuery(this.db, sql`
      DELETE FROM identity_edge_node
      WHERE id = ${nodeId}
      RETURNING id
    `);

    return result.rows.length > 0;
  }

  // ============ SP (Storage Provider) Node Methods ============

  /**
   * Register or update an SP node (UPSERT by nodeId).
   *
   * SP 本地生成 deviceId 作为 nodeId，注册时带上来。
   * 同一 nodeId 重复注册时更新 publicUrl、token 等，保留原记录。
   * 不传 nodeId 则 Cloud 随机分配。
   */
  public async registerSpNode(options: {
    publicUrl: string;
    displayName?: string;
    /** SP 提供的设备 ID，作为 nodeId（不传则随机生成） */
    nodeId?: string;
    /** SP 提供的 serviceToken，不传则随机生成 */
    serviceToken?: string;
  }): Promise<CreateSpNodeResult> {
    const nodeId = options.nodeId || randomUUID();
    const nodeToken = randomBytes(32).toString('base64url');
    const nodeTokenHash = createHash('sha256').update(nodeToken).digest('hex');
    const serviceToken = options.serviceToken || randomBytes(32).toString('base64url');
    const now = new Date();
    const ts = toDbTimestamp(this.db, now);

    await executeStatement(this.db, sql`
      INSERT INTO identity_edge_node (
        id, display_name, token_hash, service_token_hash,
        node_type, public_url,
        connectivity_status, created_at, updated_at
      )
      VALUES (
        ${nodeId}, ${options.displayName ?? null}, ${nodeTokenHash}, ${serviceToken},
        'sp', ${options.publicUrl}, 'unknown', ${ts}, ${ts}
      )
      ON CONFLICT (id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        token_hash = EXCLUDED.token_hash,
        service_token_hash = EXCLUDED.service_token_hash,
        public_url = EXCLUDED.public_url,
        updated_at = EXCLUDED.updated_at
    `);

    return {
      nodeId,
      nodeToken,
      serviceToken,
      createdAt: now.toISOString(),
    };
  }

  /**
   * Get SP node info by nodeId.
   */
  public async getSpNode(nodeId: string): Promise<SpNodeInfo | undefined> {
    const result = await executeQuery(this.db, sql`
      SELECT id, display_name, public_url, service_token_hash, last_seen
      FROM identity_edge_node
      WHERE id = ${nodeId} AND node_type = 'sp'
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return undefined;
    }

    const row = result.rows[0] as any;
    return {
      nodeId: String(row.id),
      displayName: row.display_name == null ? undefined : String(row.display_name),
      publicUrl: String(row.public_url ?? ''),
      serviceTokenHash: String(row.service_token_hash ?? ''),
      lastSeen: fromDbTimestamp(row.last_seen),
    };
  }
}
