import { sql } from 'drizzle-orm';
import { type IdentityDatabase, executeQuery } from './db';

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

interface InternalKvRow {
  key?: string;
  value?: string;
}

interface NodeAssignmentRow {
  node_id?: string | null;
  base_url?: string | null;
}

/**
 * Repository for Pod lookup operations.
 *
 * Reads Pod facts from the canonical identity_store table and from CSS
 * WrappedIndexedStorage rows when that storage backend is active.
 */
export class PodLookupRepository {
  private readonly kvTableName: string;
  private readonly indexedStoreTableName: string;

  public constructor(
    private readonly db: IdentityDatabase,
    kvTableName?: string,
  ) {
    this.kvTableName = kvTableName ?? 'internal_kv';
    this.indexedStoreTableName = 'identity_store';
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
    return indexed;
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
          results.push(indexed);
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
   * List all pods.
   */
  public async listAllPods(): Promise<PodLookupResult[]> {
    return this.getAllPods();
  }

  /**
   * Extract all pods from the configured CSS identity storage.
   */
  private async getAllPods(): Promise<PodLookupResult[]> {
    const result = await this.getAccountRowsFromKv();
    const nodeAssignments = await this.getNodeAssignments();

    const pods: PodLookupResult[] = [];

    for (const row of result) {
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
            const storageUrl = stringValue(pod.storageUrl) ?? stringValue(pod.storage);
            const podWebIds = [
              typeof pod.webId === 'string' ? pod.webId : undefined,
              ...extractPodOwnerWebIds(pod),
              ...webIds,
            ].filter((value): value is string => typeof value === 'string');
            pods.push({
              podId,
              accountId,
              baseUrl: pod.baseUrl,
              storageUrl,
              webId: dedupeStrings(podWebIds)[0],
              ...webIdsProperty(podWebIds),
              nodeId: typeof pod.nodeId === 'string' ? pod.nodeId : findNodeIdForPod(nodeAssignments, [storageUrl, pod.baseUrl]),
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
      ...await this.getPodsFromIndexedStore(nodeAssignments),
    ]);
  }

  private async getAccountRowsFromKv(): Promise<InternalKvRow[]> {
    const kvTableId = sql.identifier([this.kvTableName]);
    try {
      const result = await executeQuery<InternalKvRow>(this.db, sql`
        SELECT key, value FROM ${kvTableId}
        WHERE key LIKE 'accounts/data/%'
           OR key LIKE '/.internal/accounts/data/%'
      `);
      return result?.rows ?? [];
    } catch {
      return [];
    }
  }

  private async getNodeAssignments(): Promise<NodeAssignmentRow[]> {
    try {
      const tableId = sql.identifier(['cluster_node']);
      const result = await executeQuery<{ id?: string | null; pod_base_urls?: unknown }>(this.db, sql`
        SELECT id, pod_base_urls FROM ${tableId}
        WHERE pod_base_urls IS NOT NULL AND pod_base_urls <> ''
      `);
      return result.rows.flatMap((row) => {
        if (!row.id) {
          return [];
        }
        return parsePodBaseUrls(row.pod_base_urls).map((baseUrl) => ({
          node_id: row.id,
          base_url: baseUrl,
        }));
      });
    } catch {
      return [];
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
        const storageUrl = stringValue(pod.storageUrl) ?? stringValue(pod.storage);
        const podWebIds = [
          typeof pod.webId === 'string' ? pod.webId : undefined,
          ...extractPodOwnerWebIds(pod),
          ...webIds,
        ].filter((value): value is string => typeof value === 'string');
        pods.push({
          podId,
          accountId,
          baseUrl: pod.baseUrl,
          storageUrl,
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
   * DrizzleIndexedStorage stores CSS identity facts as typed rows in
   * identity_store; this is the canonical clustered identity source.
   */
  private async getPodsFromIndexedStore(nodeAssignments: NodeAssignmentRow[] = []): Promise<PodLookupResult[]> {
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
      const storageUrl = stringValue(pod.storageUrl) ?? stringValue(pod.storage);

      pods.push({
        podId,
        accountId,
        baseUrl,
        storageUrl,
        webId: podWebIds[0],
        ...webIdsProperty(podWebIds),
        nodeId: stringValue(pod.nodeId) ?? findNodeIdForPod(nodeAssignments, [storageUrl, baseUrl]),
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

function normalizeUrlRoot(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
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

function parsePodBaseUrls(value: unknown): string[] {
  if (Array.isArray(value)) {
    return dedupeStrings(value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0));
  }
  if (typeof value !== 'string' || value.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? dedupeStrings(parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))
      : [];
  } catch {
    return [];
  }
}

function findNodeIdForPod(assignments: NodeAssignmentRow[], urls: Array<string | undefined>): string | undefined {
  const normalizedUrls = urls.map(normalizeUrlRoot).filter((value): value is string => Boolean(value));
  if (normalizedUrls.length === 0) {
    return undefined;
  }

  let bestMatch: { nodeId: string; length: number } | undefined;
  for (const assignment of assignments) {
    if (!assignment.node_id || !assignment.base_url) {
      continue;
    }
    const assignedBase = normalizeUrlRoot(assignment.base_url);
    if (!assignedBase) {
      continue;
    }
    for (const url of normalizedUrls) {
      if (url.startsWith(assignedBase) && assignedBase.length > (bestMatch?.length ?? 0)) {
        bestMatch = {
          nodeId: assignment.node_id,
          length: assignedBase.length,
        };
      }
    }
  }

  return bestMatch?.nodeId;
}
