import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm/sql';
import {
  type IdentityDatabase,
  executeQuery,
  isDatabaseSqlite,
  jsonFieldEquals,
  jsonFieldIn,
  jsonFieldIsPrefixOf,
} from './db';

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

interface IndexedStoreRow {
  id?: string;
  payload?: unknown;
}

/**
 * Repository for Pod lookup operations.
 *
 * Reads Pod facts from the canonical identity_store table and from CSS
 * WrappedIndexedStorage rows when that storage backend is active.
 *
 * 点查（findById / findAllByWebId / findByWebIds / listByAccountId）走字段下推
 * 快路径，避免每请求全扫 identity_store；KV 历史账户记录独立读取，
 * 同 ID 的 canonical 记录整条优先，包括无法解析的记录，不能恢复旧身份。
 * findByResourceIdentifier / listAllPods 本质上需要
 * 候选全集，仍保留全量读取（identity_store 侧用反向前缀 LIKE 下推预筛）。
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
   *
   * kv 账户行无法按 URL 下推，保持全量解析（cloud 部署 kv 为空，local 规模有限）。
   */
  public async findByResourceIdentifier(resourcePath: string): Promise<PodLookupResult | undefined> {
    const kvRows = await this.getAccountRowsFromKv();
    const nodeAssignments = await this.getNodeAssignments();
    const pods = await this.mergeCanonicalPods(
      this.extractKvPods(kvRows, nodeAssignments),
      await this.findIndexedStorePodsByResource(resourcePath, nodeAssignments),
      nodeAssignments,
    );

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
   *
   * 快路径按主键直查 identity_store 的 pod 行并补齐 owner/node 关联；
   * 独立读取 KV 历史记录，并按原始 ID 检查 canonical 遮蔽。
   */
  public async findById(podId: string): Promise<PodLookupResult | undefined> {
    const fast = await this.getIndexedStorePodsByIds([podId]);
    const legacy = (await this.getLegacyPods()).filter((pod) => pod.podId === podId);
    return (await this.mergeCanonicalPods(legacy, fast)).find((pod) => pod.podId === podId);
  }

  /**
   * Find Pod by an explicit owner or pod.webId URL.
   *
   * Pod ownership stores WebIDs separately from Pod base URLs. This is
   * the precise lookup for IdP/SP split deployments where the WebID path does
   * not have to match the storage base URL.
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
    return this.findByWebIds([webId]);
  }

  /**
   * Find Pods by explicit WebID bindings with batched canonical queries.
   */
  public async findByWebIds(webIds: string[]): Promise<PodLookupResult[]> {
    const exactTargets = new Set(webIds.map(exactWebId).filter((value): value is string => Boolean(value)));
    if (exactTargets.size === 0) {
      return [];
    }

    const legacy = await this.getLegacyPods();
    const candidates = await this.findIndexedStorePodsByWebIds([...exactTargets]);
    return this.filterPodsByWebIds(await this.mergeCanonicalPods(legacy, candidates), exactTargets);
  }

  /**
   * List Pods for a specific account.
   *
   * 定向查询与全扫描等价：kv 按账户键直取，identity_store 按 accountId 下推，
   * canonical 整条优先与 getAllPods 一致，KV 扫描补齐 .json 等历史键。
   */
  public async listByAccountId(accountId: string): Promise<PodLookupResult[]> {
    const nodeAssignments = await this.getNodeAssignments();
    const storePods = await this.getIndexedStorePodsByAccountId(accountId, nodeAssignments);
    const legacy = (await this.getLegacyPods(nodeAssignments)).filter((pod) => pod.accountId === accountId);
    return (await this.mergeCanonicalPods(legacy, storePods, nodeAssignments))
      .filter((pod) => pod.accountId === accountId);
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

    return this.mergeCanonicalPods(
      this.extractKvPods(result, nodeAssignments),
      await this.getPodsFromIndexedStore(nodeAssignments),
      nodeAssignments,
    );
  }

  // Legacy KV rows need independent discovery: an indexed match says nothing
  // about other unindexed Pods or overlapping records. Keep identity_store
  // queries targeted while applying canonical precedence to overlapping IDs.
  private async getLegacyPods(nodeAssignments?: NodeAssignmentRow[]): Promise<PodLookupResult[]> {
    const rows = await this.getAccountRowsFromKv();
    return this.extractKvPods(rows, nodeAssignments ?? await this.getNodeAssignments());
  }

  private extractKvPods(rows: InternalKvRow[], nodeAssignments: NodeAssignmentRow[]): PodLookupResult[] {
    const pods: PodLookupResult[] = [];
    for (const row of rows) {
      if (!row.key || row.value === undefined) {
        continue;
      }

      try {
        const accountId = extractAccountIdFromAccountDataKey(row.key);
        if (!accountId) {
          continue;
        }
        const data = unwrapStoredValue(typeof row.value === 'string' ? JSON.parse(row.value) : row.value);
        pods.push(...this.extractPodsFromAccountData(accountId, data as Record<string, unknown>, nodeAssignments));
      } catch {
        // Skip malformed entries.
      }
    }
    return pods;
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

  // Predicate pushdown can omit a canonical replacement with a different owner,
  // account or URL. Check legacy IDs separately, registering existence before
  // parsing so a malformed canonical record also suppresses the old Pod.
  private async mergeCanonicalPods(
    legacy: PodLookupResult[],
    candidates: PodLookupResult[],
    nodeAssignments?: NodeAssignmentRow[],
  ): Promise<PodLookupResult[]> {
    const ids = dedupeStrings(legacy.map((pod) => pod.podId));
    const rows = ids.length > 0
      ? await this.queryIndexedStoreRows(sql`container = 'pod' AND ${idIn(ids)}`)
      : [];
    const canonicalIds = new Set(rows.map((row) => row.id));
    const replacements = rows.length > 0
      ? await this.enrichIndexedStorePods(
        rowsToPodPayloadMap(rows), nodeAssignments ?? await this.getNodeAssignments(),
      )
      : [];
    const all = [...legacy.filter((pod) => !canonicalIds.has(pod.podId)), ...candidates, ...replacements];
    return [...new Map(all.map((pod) => [pod.podId, pod])).values()];
  }

  private extractPodsFromAccountData(
    accountId: string,
    data: Record<string, unknown>,
    nodeAssignments: NodeAssignmentRow[] = [],
  ): PodLookupResult[] {
    const podMap = (data as any)['**pod**'] || (data as any).pod || {};
    const pods: PodLookupResult[] = [];

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
          webId: dedupeStrings(podWebIds)[0],
          ...webIdsProperty(podWebIds),
          nodeId: typeof pod.nodeId === 'string' ? pod.nodeId : findNodeIdForPod(nodeAssignments, [storageUrl, pod.baseUrl]),
          edgeNodeId: typeof pod.edgeNodeId === 'string' ? pod.edgeNodeId : undefined,
        });
      }
    }

    return pods;
  }

  /**
   * 与全扫描一致的 WebID 匹配过滤：按 Pod 解析后的 WebID 列表按原字符串比较，
   * 命中时附加该 Pod 自身存储的 WebID。
   */
  private filterPodsByWebIds(pods: PodLookupResult[], exactTargets: Set<string>): PodLookupResult[] {
    const results: PodLookupResult[] = [];
    for (const pod of pods) {
      const matchedWebId = getPodWebIds(pod).find((candidate) => {
        const exact = exactWebId(candidate);
        return exact ? exactTargets.has(exact) : false;
      });
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
   * DrizzleIndexedStorage stores CSS identity facts as typed rows in
   * identity_store; this is the canonical clustered identity source.
   */
  private async getPodsFromIndexedStore(nodeAssignments: NodeAssignmentRow[] = []): Promise<PodLookupResult[]> {
    const storeTableId = sql.identifier(this.indexedStoreTableName);
    let rows: Array<{ container?: string; id?: string; payload?: unknown }> = [];
    try {
      const result = await executeQuery<{ container?: string; id?: string; payload?: unknown }>(this.db, sql`
        SELECT container, id, payload FROM ${storeTableId}
        WHERE container IN ('pod', 'owner')
      `);
      rows = result.rows;
    } catch (error) {
      if (isMissingIdentityStore(error)) return [];
      throw error;
    }

    const podPayloads = new Map<string, Record<string, unknown>>();
    const ownerRows: IndexedStoreRow[] = [];
    for (const row of rows) {
      if (!row.id || !row.container) {
        continue;
      }
      if (row.container === 'pod') {
        const payload = parsePayloadRecord(row.payload);
        if (payload) {
          podPayloads.set(row.id, payload);
        }
      } else if (row.container === 'owner') {
        ownerRows.push(row);
      }
    }
    return this.buildIndexedStorePods(podPayloads, ownerRows, nodeAssignments);
  }

  /**
   * 按主键直查 identity_store pod 行并补齐关联。
   */
  private async getIndexedStorePodsByIds(podIds: string[]): Promise<PodLookupResult[]> {
    if (podIds.length === 0) {
      return [];
    }
    const rows = await this.queryIndexedStoreRows(sql`container = 'pod' AND ${idIn(podIds)}`);
    return this.enrichIndexedStorePods(rowsToPodPayloadMap(rows), await this.getNodeAssignments());
  }

  /**
   * 按 payload.accountId 下推查询 identity_store pod 行并补齐关联。
   */
  private async getIndexedStorePodsByAccountId(
    accountId: string,
    nodeAssignments: NodeAssignmentRow[],
  ): Promise<PodLookupResult[]> {
    const rows = await this.queryIndexedStoreRows(
      sql`container = 'pod'`, jsonFieldEquals(this.db, 'accountId', accountId),
    );
    return this.enrichIndexedStorePods(rowsToPodPayloadMap(rows), nodeAssignments);
  }

  /**
   * 反向前缀 LIKE 预筛候选 pod 行（baseUrl/storageUrl/storage 任一前缀），
   * JS 侧 startsWith 复核由调用方（findByResourceIdentifier）执行。
   */
  private async findIndexedStorePodsByResource(
    resourcePath: string,
    nodeAssignments: NodeAssignmentRow[],
  ): Promise<PodLookupResult[]> {
    const conditions = ['baseUrl', 'storageUrl', 'storage']
      .map((field) => jsonFieldIsPrefixOf(this.db, field, resourcePath));
    const rows = await this.queryIndexedStoreRows(
      sql`container = 'pod'`, sql`(${sql.join(conditions, sql` OR `)})`,
    );
    return this.enrichIndexedStorePods(rowsToPodPayloadMap(rows), nodeAssignments);
  }

  /**
   * WebID → Pod 的下推解析：owner 按 webId 命中拿 podId，pod.webId
   * 直查；Account webIdLink 不建立 Pod ownership。
   * webIdForms 只携带完整原字符串；URL 等价不代表相同身份。
   */
  private async findIndexedStorePodsByWebIds(webIdForms: string[]): Promise<PodLookupResult[]> {
    const forms = dedupeStrings(webIdForms);
    if (forms.length === 0) {
      return [];
    }
    const [ownerMatchRows, directPodRows] = await Promise.all([
      this.queryIndexedStoreRows(sql`container = 'owner'`, jsonFieldIn(this.db, 'webId', forms)),
      this.queryIndexedStoreRows(sql`container = 'pod'`, jsonFieldIn(this.db, 'webId', forms)),
    ]);

    const podIds = dedupeStrings([
      ...ownerMatchRows.map((row) => stringValue(parsePayloadRecord(row.payload)?.podId)),
      ...directPodRows.map((row) => row.id),
    ].filter((value): value is string => Boolean(value)));
    if (podIds.length === 0) {
      return [];
    }

    const podRows = await this.queryIndexedStoreRows(sql`container = 'pod' AND ${idIn(podIds)}`);
    return this.enrichIndexedStorePods(rowsToPodPayloadMap(podRows), await this.getNodeAssignments());
  }

  /**
   * 为候选 pod 行补齐 owner 关联与 nodeAssignments，组装最终结果。
   * 与全扫描共用 buildIndexedStorePods，保证返回形状一致。
   */
  private async enrichIndexedStorePods(
    podPayloads: Map<string, Record<string, unknown>>,
    nodeAssignments: NodeAssignmentRow[],
  ): Promise<PodLookupResult[]> {
    if (podPayloads.size === 0) {
      return [];
    }
    const podIds = [...podPayloads.keys()];
    const ownerRows = await this.queryIndexedStoreRows(
      sql`container = 'owner'`, jsonFieldIn(this.db, 'podId', podIds),
    );
    return this.buildIndexedStorePods(podPayloads, ownerRows, nodeAssignments);
  }

  private async queryIndexedStoreRows(condition: SQL, jsonCondition?: SQL): Promise<IndexedStoreRow[]> {
    const storeTableId = sql.identifier(this.indexedStoreTableName);
    // Keep indexed columns outside CASE; only JSON evaluation needs protection.
    // Raw ID queries must still see malformed rows for canonical shadowing.
    const safeJsonCondition = jsonCondition && isDatabaseSqlite(this.db)
      ? sql`CASE WHEN json_valid(payload) THEN ${jsonCondition} ELSE 0 END`
      : jsonCondition;
    const safeCondition = safeJsonCondition ? sql`${condition} AND (${safeJsonCondition})` : condition;
    try {
      const result = await executeQuery<IndexedStoreRow>(this.db, sql`
        SELECT id, payload FROM ${storeTableId}
        WHERE ${safeCondition}
      `);
      return result.rows;
    } catch (error) {
      if (isMissingIdentityStore(error)) return [];
      throw error;
    }
  }

  /**
   * 组装 identity_store Pod 视图：pod 行为主体，owner 行补充 WebID，
   * nodeAssignments 兜底 nodeId。全扫描与下推快路径共用，保证返回形状一致。
   */
  private buildIndexedStorePods(
    podPayloads: Map<string, Record<string, unknown>>,
    ownerRows: IndexedStoreRow[],
    nodeAssignments: NodeAssignmentRow[],
  ): PodLookupResult[] {
    const ownerWebIdsByPodId = new Map<string, string[]>();

    for (const row of ownerRows) {
      const payload = parsePayloadRecord(row.payload);
      const podId = payload ? stringValue(payload.podId) : undefined;
      const webId = payload ? stringValue(payload.webId) : undefined;
      if (podId && webId) {
        appendMapValue(ownerWebIdsByPodId, podId, webId);
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

function idIn(ids: string[]): SQL {
  return sql`id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
}

function rowsToPodPayloadMap(rows: IndexedStoreRow[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!row.id) {
      continue;
    }
    const payload = parsePayloadRecord(row.payload);
    if (payload) {
      map.set(row.id, payload);
    }
  }
  return map;
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
