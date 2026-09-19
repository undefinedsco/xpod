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
   * Find Pod by an explicitly recorded owner WebID URL.
   *
   * Account WebID links are not ownership. IdP/SP split deployments still use
   * the complete recorded WebID, independently of the storage base URL.
   */
  public async findByWebId(webId: string): Promise<PodLookupResult | undefined> {
    return (await this.findAllByWebId(webId))[0];
  }

  /**
   * Find all Pods explicitly owned by a WebID.
   *
   * A Cloud WebID can legitimately back both a Cloud Pod and a Local SP Pod.
   * Callers that are scoped to a storage provider must inspect all candidates
   * instead of accepting the first account record returned by CSS storage.
   */
  public async findAllByWebId(webId: string): Promise<PodLookupResult[]> {
    const exact = exactWebId(webId);
    if (!exact) {
      return [];
    }

    const results: PodLookupResult[] = [];
    const pods = await this.getAllPods();
    for (const pod of pods) {
      const matchedWebId = getPodWebIds(pod).find((candidate) => exactWebId(candidate) === exact);
      if (matchedWebId) {
        results.push({
          ...pod,
          webId: matchedWebId,
        });
      }
    }

    return results;
  }

  /**
   * Find Pods by explicit owner WebID URLs in one scan.
   */
  public async findByWebIds(webIds: string[]): Promise<PodLookupResult[]> {
    const exactTargets = new Set(webIds.map(exactWebId).filter((value): value is string => Boolean(value)));
    if (exactTargets.size === 0) {
      return [];
    }

    const results: PodLookupResult[] = [];
    const pods = await this.getAllPods();
    for (const pod of pods) {
      const matchedWebId = getPodWebIds(pod).find((candidate) => {
        const exact = exactWebId(candidate);
        return exact ? exactTargets.has(exact) : false;
      });
      if (!matchedWebId) {
        continue;
      }
      results.push({
        ...pod,
        webId: matchedWebId,
      });
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

        for (const [podId, podData] of Object.entries(podMap)) {
          const pod = podData as Record<string, unknown>;
          if (pod.baseUrl && typeof pod.baseUrl === 'string') {
            const storageUrl = stringValue(pod.storageUrl) ?? stringValue(pod.storage);
            const podWebIds = dedupeStrings(explicitPodWebIds(pod));
            pods.push({
              podId,
              accountId,
              baseUrl: pod.baseUrl,
              storageUrl,
              webId: podWebIds[0],
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

    const indexed = await this.getPodsFromIndexedStore(nodeAssignments);
    // Presence in the canonical table shadows the whole legacy record, even
    // when the canonical payload is incomplete. Never resurrect old owners.
    return [...new Map([
      ...pods.filter((pod) => !indexed.podIds.has(pod.podId)),
      ...indexed.pods,
    ].map((pod) => [pod.podId, pod])).values()];
  }

  private async getAccountRowsFromKv(): Promise<InternalKvRow[]> {
    const kvTableId = sql.identifier(this.kvTableName);
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
      const tableId = sql.identifier('cluster_node');
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
   * DrizzleIndexedStorage stores CSS identity facts as typed rows in
   * identity_store; this is the canonical clustered identity source.
   */
  private async getPodsFromIndexedStore(nodeAssignments: NodeAssignmentRow[] = []): Promise<{ pods: PodLookupResult[]; podIds: Set<string> }> {
    const storeTableId = sql.identifier(this.indexedStoreTableName);
    let result: { rows?: Array<{ container?: string; id?: string; payload?: unknown }> } | undefined;
    try {
      result = await executeQuery(this.db, sql`
        SELECT container, id, payload FROM ${storeTableId}
        WHERE container IN ('pod', 'owner')
      `);
    } catch (error: unknown) {
      // Legacy-only installations have no canonical table. An unavailable or
      // unreadable existing table must not reactivate legacy ownership.
      if (!isMissingIdentityStore(error)) throw error;
      return { pods: [], podIds: new Set() };
    }

    const podIds = new Set<string>();
    const podPayloads = new Map<string, Record<string, unknown>>();
    const ownerWebIdsByPodId = new Map<string, string[]>();

    for (const row of result?.rows ?? []) {
      if (!row.id || !row.container) {
        continue;
      }
      if (row.container === 'pod') podIds.add(row.id);
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
      }
    }

    const pods: PodLookupResult[] = [];
    for (const [podId, pod] of podPayloads) {
      const baseUrl = stringValue(pod.baseUrl);
      const accountId = stringValue(pod.accountId);
      if (!baseUrl || !accountId) {
        continue;
      }
      const explicitPodWebIds = [
        stringValue(pod.webId),
        ...(ownerWebIdsByPodId.get(podId) ?? []),
      ].filter((value): value is string => typeof value === 'string');
      const podWebIds = dedupeStrings(explicitPodWebIds);
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

    return { pods, podIds };
  }
}

function isMissingIdentityStore(error: unknown): boolean {
  const visited = new Set<unknown>();
  while (error && typeof error === 'object' && !visited.has(error)) {
    visited.add(error);
    const failure = error as { code?: string; message?: string; cause?: unknown };
    if (failure.message === 'no such table: identity_store'
      || (failure.code === '42P01' && failure.message === 'relation "identity_store" does not exist')) {
      return true;
    }
    error = failure.cause;
  }
  return false;
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

function explicitPodWebIds(pod: Record<string, unknown>): string[] {
  return [
    typeof pod.webId === 'string' ? pod.webId : undefined,
    ...extractPodOwnerWebIds(pod),
  ].filter((value): value is string => typeof value === 'string');
}

function exactWebId(webId: string | undefined): string | undefined {
  // WebID identity is the complete original string, not URL equivalence.
  return webId && webId === webId.trim() && !/[\r\n\t]/u.test(webId) ? webId : undefined;
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
