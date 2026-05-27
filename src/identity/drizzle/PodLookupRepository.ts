import { sql } from 'drizzle-orm';
import { type IdentityDatabase, executeQuery, executeStatement } from './db';

export interface PodLookupResult {
  podId: string;
  accountId: string;
  baseUrl: string;
  storageUrl?: string;
  webId?: string;
  webIds?: string[];
  nodeId?: string;
  edgeNodeId?: string;
}

export interface PodMigrationStatus {
  podId: string;
  nodeId?: string;
  migrationStatus?: 'syncing' | 'done' | null;
  migrationTargetNode?: string;
  migrationProgress?: number;
}

interface InternalKvRow {
  key?: string;
  value?: string;
  id?: string;
  account_id?: string;
  base_url?: string;
  storage_url?: string;
  node_id?: string;
  edge_node_id?: string;
}

interface PodUsageRow {
  pod_id?: string;
  storage_url?: string | null;
}

/**
 * Repository for Pod lookup operations.
 *
 * Reads Pod data from CSS's internal_kv table where account data is stored.
 * CSS stores account data at key "accounts/data/{accountId}" with Pod info
 * nested in the "**pod**" field.
 */
export class PodLookupRepository {
  private readonly kvTableName: string;
  private readonly indexedStoreTableName: string;
  private readonly usageTableName: string;

  public constructor(
    private readonly db: IdentityDatabase,
    kvTableName?: string,
  ) {
    this.kvTableName = kvTableName ?? 'internal_kv';
    this.indexedStoreTableName = 'identity_store';
    this.usageTableName = 'identity_pod_usage';
  }

  /**
   * Find Pod by resource path (matches longest canonical storage/base URL prefix).
   */
  public async findByResourceIdentifier(resourcePath: string): Promise<PodLookupResult | undefined> {
    const pods = await this.getAllPods();

    let bestMatch: PodLookupResult | undefined;
    let bestLength = 0;

    for (const pod of pods) {
      const candidateBase = pod.storageUrl ?? pod.baseUrl;
      if (resourcePath.startsWith(candidateBase) && candidateBase.length > bestLength) {
        bestMatch = pod;
        bestLength = candidateBase.length;
      }
    }

    return bestMatch;
  }

  /**
   * Get Pod by ID.
   */
  public async findById(podId: string): Promise<PodLookupResult | undefined> {
    const pods = await this.getAllPods();
    return pods.find((p) => p.podId === podId);
  }

  /**
   * Find Pod by a linked WebID URL.
   *
   * CSS account data stores WebID links separately from Pod base URLs. This is
   * the precise lookup for IdP/SP split deployments where the WebID path does
   * not have to match the storage base URL.
   */
  public async findByWebId(webId: string): Promise<PodLookupResult | undefined> {
    const normalized = normalizeWebId(webId);
    if (!normalized) {
      return undefined;
    }

    const pods = await this.getAllPods();
    for (const pod of pods) {
      const matchedWebId = getPodWebIds(pod).find((candidate) => normalizeWebId(candidate) === normalized);
      if (matchedWebId) {
        return {
          ...pod,
          webId: matchedWebId,
        };
      }
    }
    const indexed = await this.findByWebIdIndex(normalized);
    if (!indexed) {
      return undefined;
    }
    const usage = await this.getUsageByPodId();
    return {
      ...indexed,
      storageUrl: indexed.storageUrl ?? usage.get(indexed.podId)?.storageUrl,
    };
  }

  /**
   * Find Pods by linked WebID URLs in one scan.
   */
  public async findByWebIds(webIds: string[]): Promise<PodLookupResult[]> {
    const normalizedTargets = new Set(webIds.map(normalizeWebId).filter((value): value is string => Boolean(value)));
    if (normalizedTargets.size === 0) {
      return [];
    }

    const results: PodLookupResult[] = [];
    const pods = await this.getAllPods();
    for (const pod of pods) {
      const matchedWebId = getPodWebIds(pod).find((candidate) => {
        const normalized = normalizeWebId(candidate);
        return normalized ? normalizedTargets.has(normalized) : false;
      });
      if (!matchedWebId) {
        continue;
      }
      results.push({
        ...pod,
        webId: matchedWebId,
      });
    }
    if (results.length < normalizedTargets.size) {
      const seen = new Set(results.map((result) => normalizeWebId(result.webId)).filter(Boolean));
      for (const normalized of normalizedTargets) {
        if (seen.has(normalized)) {
          continue;
        }
        const indexed = await this.findByWebIdIndex(normalized);
        if (indexed) {
          const usage = await this.getUsageByPodId();
          results.push({
            ...indexed,
            storageUrl: indexed.storageUrl ?? usage.get(indexed.podId)?.storageUrl,
          });
        }
      }
    }
    return results;
  }

  /**
   * List Pods for a specific account.
   */
  public async listByAccountId(accountId: string): Promise<PodLookupResult[]> {
    const pods = await this.getAllPods();
    return pods.filter((pod) => pod.accountId === accountId);
  }

  /**
   * Set the canonical storage URL for a Pod in identity_pod_usage.
   */
  public async setStorageUrl(podId: string, accountId: string, storageUrl: string): Promise<void> {
    const tableId = sql.identifier([this.usageTableName]);
    await executeStatement(this.db, sql`
      INSERT INTO ${tableId} (pod_id, account_id, storage_url)
      VALUES (${podId}, ${accountId}, ${storageUrl})
      ON CONFLICT (pod_id) DO UPDATE SET
        account_id = ${accountId},
        storage_url = ${storageUrl}
    `);
  }

  /**
   * Get migration status for a Pod from identity_pod_usage table.
   */
  public async getMigrationStatus(podId: string): Promise<PodMigrationStatus | undefined> {
    try {
      const tableId = sql.identifier([this.usageTableName]);
      const result = await executeQuery<{
        pod_id?: string;
        id?: string;
        node_id?: string | null;
        migration_status?: string | null;
        migration_target_node?: string | null;
        migration_progress?: number | null;
      }>(this.db, sql`
        SELECT pod_id, node_id, migration_status, migration_target_node, migration_progress
        FROM ${tableId}
        WHERE pod_id = ${podId}
        LIMIT 1
      `);

      if (result.rows.length === 0) {
        return undefined;
      }
      const row = result.rows[0];
      return {
        podId: row.pod_id ?? row.id ?? podId,
        nodeId: row.node_id ?? undefined,
        migrationStatus: row.migration_status as 'syncing' | 'done' | null | undefined,
        migrationTargetNode: row.migration_target_node ?? undefined,
        migrationProgress: row.migration_progress ?? undefined,
      };
    } catch {
      // Table might not exist.
      return undefined;
    }
  }

  /**
   * Set the nodeId for a Pod in identity_pod_usage table.
   */
  public async setNodeId(podId: string, nodeId: string): Promise<void> {
    const tableId = sql.identifier([this.usageTableName]);
    await executeStatement(this.db, sql`
      INSERT INTO ${tableId} (pod_id, account_id, node_id)
      VALUES (${podId}, '', ${nodeId})
      ON CONFLICT (pod_id) DO UPDATE SET node_id = ${nodeId}
    `);
  }

  /**
   * Update migration status for a Pod in identity_pod_usage table.
   */
  public async setMigrationStatus(
    podId: string,
    status: 'syncing' | 'done' | null,
    targetNode?: string | null,
    progress?: number | null,
  ): Promise<void> {
    const tableId = sql.identifier([this.usageTableName]);
    await executeStatement(this.db, sql`
      INSERT INTO ${tableId} (pod_id, account_id, migration_status, migration_target_node, migration_progress)
      VALUES (${podId}, '', ${status}, ${targetNode ?? null}, ${progress ?? 0})
      ON CONFLICT (pod_id) DO UPDATE SET
        migration_status = ${status},
        migration_target_node = ${targetNode ?? null},
        migration_progress = ${progress ?? 0}
    `);
  }

  /**
   * List all pods.
   */
  public async listAllPods(): Promise<PodLookupResult[]> {
    return this.getAllPods();
  }

  /**
   * Extract all pods from CSS's internal_kv storage.
   *
   * It keeps backward compatibility with legacy rows that already expose
   * id/account_id/base_url columns (used by some unit tests and older schemas).
   */
  private async getAllPods(): Promise<PodLookupResult[]> {
    const kvTableId = sql.identifier([this.kvTableName]);

    const result = await executeQuery<InternalKvRow>(this.db, sql`
      SELECT key, value FROM ${kvTableId}
      WHERE key LIKE 'accounts/data/%'
         OR key LIKE '/.internal/accounts/data/%'
    `);
    const usageByPodId = await this.getUsageByPodId();

    const pods: PodLookupResult[] = [];

    for (const row of result?.rows ?? []) {
      if (row.id && row.account_id && row.base_url) {
        pods.push({
          podId: String(row.id),
          accountId: String(row.account_id),
          baseUrl: String(row.base_url),
          storageUrl: row.storage_url ? String(row.storage_url) : undefined,
          nodeId: row.node_id ? String(row.node_id) : undefined,
          edgeNodeId: row.edge_node_id ? String(row.edge_node_id) : undefined,
        });
        continue;
      }

      if (!row.key || row.value === undefined) {
        continue;
      }

      try {
        const accountId = extractAccountIdFromAccountDataKey(row.key);
        if (!accountId) {
          continue;
        }
        const data = unwrapStoredValue(typeof row.value === 'string' ? JSON.parse(row.value) : row.value);

        const podMap = (data as any)['**pod**'] || (data as any).pod || {};
        const webIds = extractAccountWebIds(data);

        for (const [podId, podData] of Object.entries(podMap)) {
          const pod = podData as Record<string, unknown>;
          if (pod.baseUrl && typeof pod.baseUrl === 'string') {
            const usage = usageByPodId.get(podId);
            const podWebIds = [
              typeof pod.webId === 'string' ? pod.webId : undefined,
              ...extractPodOwnerWebIds(pod),
              ...webIds,
            ].filter((value): value is string => typeof value === 'string');
            pods.push({
              podId,
              accountId,
              baseUrl: pod.baseUrl,
              storageUrl: stringValue(pod.storageUrl) ?? usage?.storageUrl,
              webId: dedupeStrings(podWebIds)[0],
              ...webIdsProperty(podWebIds),
              nodeId: typeof pod.nodeId === 'string' ? pod.nodeId : undefined,
              edgeNodeId: typeof pod.edgeNodeId === 'string' ? pod.edgeNodeId : undefined,
            });
          }
        }
      } catch {
        // Skip malformed entries.
      }
    }

    return mergePodLookupResults([
      ...pods,
      ...await this.getPodsFromIndexedStore(),
    ]);
  }

  private async getUsageByPodId(): Promise<Map<string, { storageUrl?: string }>> {
    const tableId = sql.identifier([this.usageTableName]);
    try {
      const result = await executeQuery<PodUsageRow>(this.db, sql`
        SELECT pod_id, storage_url FROM ${tableId}
      `);
      const byPodId = new Map<string, { storageUrl?: string }>();
      for (const row of result.rows) {
        if (!row.pod_id) {
          continue;
        }
        byPodId.set(row.pod_id, {
          storageUrl: row.storage_url ?? undefined,
        });
      }
      return byPodId;
    } catch {
      return new Map();
    }
  }

  /**
   * Fast path for CSS WrappedIndexedStorage. WebID indexes point to the root
   * account id, so a single indexed key plus account data row can resolve the
   * profile without scanning all account records.
   */
  private async findByWebIdIndex(webId: string): Promise<PodLookupResult | undefined> {
    const accountIds = await this.readStringArrayFromKv(`accounts/index/webIdLink/webId/${encodeURIComponent(webId)}`);
    for (const accountId of accountIds) {
      const account = await this.readAccountData(accountId);
      if (!account) {
        continue;
      }
      const pods = this.extractPodsFromAccountData(accountId, account);
      const match = pods.find((pod) => getPodWebIds(pod).some((candidate) => normalizeWebId(candidate) === webId));
      if (match) {
        return {
          ...match,
          webId,
        };
      }
      if (pods.length === 1) {
        return {
          ...pods[0],
          webId,
          ...webIdsProperty([webId, ...getPodWebIds(pods[0])]),
        };
      }
    }
    return undefined;
  }

  private async readAccountData(accountId: string): Promise<Record<string, unknown> | undefined> {
    for (const key of [`accounts/data/${accountId}`, `/.internal/accounts/data/${accountId}`]) {
      const value = await this.readKvValue(key);
      const record = parsePayloadRecord(value);
      if (record) {
        return record;
      }
    }
    return undefined;
  }

  private async readStringArrayFromKv(key: string): Promise<string[]> {
    const value = await this.readKvValue(key);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  }

  private async readKvValue(key: string): Promise<unknown> {
    const tableId = sql.identifier([this.kvTableName]);
    try {
      const result = await executeQuery<{ value?: unknown }>(this.db, sql`
        SELECT value FROM ${tableId}
        WHERE key = ${key}
        LIMIT 1
      `);
      if (result.rows.length === 0) {
        return undefined;
      }
      return parseStoredValue(result.rows[0].value);
    } catch {
      return undefined;
    }
  }

  private extractPodsFromAccountData(accountId: string, data: Record<string, unknown>): PodLookupResult[] {
    const podMap = (data as any)['**pod**'] || (data as any).pod || {};
    const webIds = extractAccountWebIds(data);
    const pods: PodLookupResult[] = [];

    for (const [podId, podData] of Object.entries(podMap)) {
      const pod = podData as Record<string, unknown>;
      if (pod.baseUrl && typeof pod.baseUrl === 'string') {
        const podWebIds = [
          typeof pod.webId === 'string' ? pod.webId : undefined,
          ...extractPodOwnerWebIds(pod),
          ...webIds,
        ].filter((value): value is string => typeof value === 'string');
        pods.push({
          podId,
          accountId,
          baseUrl: pod.baseUrl,
          storageUrl: stringValue(pod.storageUrl),
          webId: dedupeStrings(podWebIds)[0],
          ...webIdsProperty(podWebIds),
          nodeId: typeof pod.nodeId === 'string' ? pod.nodeId : undefined,
          edgeNodeId: typeof pod.edgeNodeId === 'string' ? pod.edgeNodeId : undefined,
        });
      }
    }

    return pods;
  }

  /**
   * Older Xpod/CSS deployments may have used the IndexedStorage-compatible
   * identity_store table instead of CSS's WrappedIndexedStorage JSON tree in
   * internal_kv. Keep this as a read-only compatibility source so hosted WebID
   * profile lookup still works after storage implementation changes.
   */
  private async getPodsFromIndexedStore(): Promise<PodLookupResult[]> {
    const storeTableId = sql.identifier([this.indexedStoreTableName]);
    let result: { rows?: Array<{ container?: string; id?: string; payload?: unknown }> } | undefined;
    try {
      result = await executeQuery(this.db, sql`
        SELECT container, id, payload FROM ${storeTableId}
        WHERE container IN ('pod', 'owner', 'webIdLink')
      `);
    } catch {
      return [];
    }

    const podPayloads = new Map<string, Record<string, unknown>>();
    const ownerWebIdsByPodId = new Map<string, string[]>();
    const webIdsByAccountId = new Map<string, string[]>();

    for (const row of result?.rows ?? []) {
      if (!row.id || !row.container) {
        continue;
      }
      const payload = parsePayloadRecord(row.payload);
      if (!payload) {
        continue;
      }

      if (row.container === 'pod') {
        podPayloads.set(row.id, payload);
        continue;
      }

      if (row.container === 'owner') {
        const podId = stringValue(payload.podId);
        const webId = stringValue(payload.webId);
        if (podId && webId) {
          appendMapValue(ownerWebIdsByPodId, podId, webId);
        }
        continue;
      }

      if (row.container === 'webIdLink') {
        const accountId = stringValue(payload.accountId);
        const webId = stringValue(payload.webId);
        if (accountId && webId) {
          appendMapValue(webIdsByAccountId, accountId, webId);
        }
      }
    }

    const pods: PodLookupResult[] = [];
    for (const [podId, pod] of podPayloads) {
      const baseUrl = stringValue(pod.baseUrl);
      const accountId = stringValue(pod.accountId);
      if (!baseUrl || !accountId) {
        continue;
      }
      const podWebIds = dedupeStrings([
        stringValue(pod.webId),
        ...(ownerWebIdsByPodId.get(podId) ?? []),
        ...(webIdsByAccountId.get(accountId) ?? []),
      ].filter((value): value is string => typeof value === 'string'));

      pods.push({
        podId,
        accountId,
        baseUrl,
        storageUrl: stringValue(pod.storageUrl),
        webId: podWebIds[0],
        ...webIdsProperty(podWebIds),
        nodeId: stringValue(pod.nodeId),
        edgeNodeId: stringValue(pod.edgeNodeId),
      });
    }

    return pods;
  }
}

function extractAccountIdFromAccountDataKey(key: string): string | undefined {
  const marker = 'accounts/data/';
  const index = key.indexOf(marker);
  if (index < 0) {
    return undefined;
  }
  const accountId = key.slice(index + marker.length).replace(/\.json$/u, '');
  return accountId || undefined;
}

function extractAccountWebIds(data: unknown): string[] {
  if (!data || typeof data !== 'object') {
    return [];
  }

  const record = data as Record<string, unknown>;
  const linkMap = record['**webIdLink**'] || record.webIdLink || {};
  if (!linkMap || typeof linkMap !== 'object') {
    return [];
  }

  return Object.values(linkMap as Record<string, unknown>)
    .map((value) => {
      if (!value || typeof value !== 'object') {
        return undefined;
      }
      const webId = (value as Record<string, unknown>).webId;
      return typeof webId === 'string' ? webId : undefined;
    })
    .filter((value): value is string => typeof value === 'string');
}

function extractPodOwnerWebIds(pod: Record<string, unknown>): string[] {
  const ownerMap = pod['**owner**'] || pod.owner || {};
  if (!ownerMap || typeof ownerMap !== 'object') {
    return [];
  }

  return Object.values(ownerMap as Record<string, unknown>)
    .map((value) => {
      if (!value || typeof value !== 'object') {
        return undefined;
      }
      const webId = (value as Record<string, unknown>).webId;
      return typeof webId === 'string' ? webId : undefined;
    })
    .filter((value): value is string => typeof value === 'string');
}

function normalizeWebId(webId: string | undefined): string | undefined {
  if (!webId) {
    return undefined;
  }
  try {
    return new URL(webId).toString();
  } catch {
    return webId;
  }
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function getPodWebIds(pod: PodLookupResult): string[] {
  return dedupeStrings([
    pod.webId,
    ...(pod.webIds ?? []),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0));
}

function webIdsProperty(values: string[]): Pick<PodLookupResult, 'webIds'> {
  const webIds = dedupeStrings(values);
  return webIds.length > 1 ? { webIds } : {};
}

function mergePodLookupResults(values: PodLookupResult[]): PodLookupResult[] {
  const byPodId = new Map<string, PodLookupResult>();
  for (const value of values) {
    const existing = byPodId.get(value.podId);
    if (!existing) {
      byPodId.set(value.podId, value);
      continue;
    }

    const webIds = dedupeStrings([
      ...getPodWebIds(existing),
      ...getPodWebIds(value),
    ]);
    byPodId.set(value.podId, {
      ...existing,
      baseUrl: existing.baseUrl || value.baseUrl,
      storageUrl: existing.storageUrl ?? value.storageUrl,
      accountId: existing.accountId || value.accountId,
      webId: webIds[0],
      ...webIdsProperty(webIds),
      nodeId: existing.nodeId ?? value.nodeId,
      edgeNodeId: existing.edgeNodeId ?? value.edgeNodeId,
    });
  }
  return [...byPodId.values()];
}

function parsePayloadRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      const unwrapped = unwrapStoredValue(parsed);
      return unwrapped && typeof unwrapped === 'object' ? unwrapped as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }
  const unwrapped = unwrapStoredValue(value);
  return typeof unwrapped === 'object' ? unwrapped as Record<string, unknown> : undefined;
}

function parseStoredValue(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return unwrapStoredValue(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return unwrapStoredValue(value);
}

function unwrapStoredValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'key' in value && 'payload' in value) {
    return (value as Record<string, unknown>).payload;
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function appendMapValue(map: Map<string, string[]>, key: string, value: string): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}
