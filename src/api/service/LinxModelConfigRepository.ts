import { getSharedPool } from '../../storage/database/PostgresPoolManager';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DataFactory, Parser, Writer } from 'n3';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XPOD_CREDENTIAL = 'https://vocab.xpod.dev/credential#';
const XPOD_AI = 'https://vocab.xpod.dev/ai#';

const AI_CONFIG_PREDICATES = [
  RDF_TYPE,
  `${XPOD_CREDENTIAL}provider`,
  `${XPOD_CREDENTIAL}service`,
  `${XPOD_CREDENTIAL}status`,
  `${XPOD_CREDENTIAL}apiKey`,
  `${XPOD_CREDENTIAL}baseUrl`,
  `${XPOD_CREDENTIAL}proxyUrl`,
  `${XPOD_CREDENTIAL}timeoutMs`,
  `${XPOD_CREDENTIAL}weight`,
  `${XPOD_CREDENTIAL}isDefault`,
  `${XPOD_CREDENTIAL}lastUsedAt`,
  `${XPOD_CREDENTIAL}failCount`,
  `${XPOD_CREDENTIAL}rateLimitResetAt`,
  `${XPOD_AI}baseUrl`,
  `${XPOD_AI}proxyUrl`,
  `${XPOD_AI}routingPolicy`,
  `${XPOD_AI}hasModel`,
  `${XPOD_AI}defaultModel`,
];

const CREDENTIAL_HEALTH_PREDICATES = [
  `${XPOD_CREDENTIAL}status`,
  `${XPOD_CREDENTIAL}lastUsedAt`,
  `${XPOD_CREDENTIAL}failCount`,
  `${XPOD_CREDENTIAL}rateLimitResetAt`,
];

interface LocalAIConfigRow {
  graph: string;
  subject: string;
  predicate: string;
  object_kind?: string | null;
  object_key?: string | null;
  object_text?: string | null;
  object?: string | null;
}

export interface LinxModelConfigRepositoryOptions {
  resourceFetch?: typeof fetch;
  fileRootPath?: string;
  allowDatabaseFallback?: boolean;
  allowResourceFallback?: boolean;
}

export interface LocalAIProviderRecord {
  id: string;
  graph: string;
  subject: string;
  baseUrl?: string;
  proxyUrl?: string;
  routingPolicy?: string;
  hasModel?: string;
  defaultModel?: string;
}

export interface LocalAICredentialRecord {
  id: string;
  graph: string;
  subject: string;
  providerId: string;
  providerRef?: string;
  service?: string;
  status?: string;
  apiKey?: string;
  baseUrl?: string;
  proxyUrl?: string;
  timeoutMs?: number;
  weight?: number;
  isDefault?: boolean;
  lastUsedAt?: string;
  failCount?: number;
  rateLimitResetAt?: string;
}

export interface LocalAICandidate {
  providerId: string;
  credentialId?: string;
  credentialSubject?: string;
  credentialGraph?: string;
  credential: LocalAICredentialRecord | Record<string, unknown>;
  apiKey: string;
  baseUrl: string;
  proxyUrl?: string;
  timeoutMs?: number;
}

export interface LocalAIConfig {
  providerId: string;
  model: string;
  candidates: LocalAICandidate[];
  source: 'pod' | 'env' | 'none';
}

export async function readPodLocalAIConfig(
  requestedProviderId: string,
  webId?: string,
  options: LinxModelConfigRepositoryOptions = {},
): Promise<{ providerId: string; model?: string; candidates: LocalAICandidate[] } | null> {
  const fileRootPath = options.fileRootPath ?? createDefaultPodFileRootPath();
  const usesFileSource = Boolean(fileRootPath);
  const allowFallback = options.allowDatabaseFallback ?? !usesFileSource;
  const allowResourceFallback = options.allowResourceFallback ?? !usesFileSource;
  if (fileRootPath) {
    try {
      const fileConfig = await readPodLocalAIConfigFromFiles(requestedProviderId, webId, fileRootPath);
      if (fileConfig) return fileConfig;
    } catch (error) {
      if (!allowFallback) throw error;
    }
  }

  const resourceFetch = options.resourceFetch ?? createDefaultPodResourceFetch();
  if (resourceFetch && allowResourceFallback) {
    try {
      const resourceConfig = await readPodLocalAIConfigFromResources(requestedProviderId, webId, resourceFetch);
      if (resourceConfig) return resourceConfig;
    } catch (error) {
      if (!allowFallback) throw error;
    }
  }

  if (!allowFallback) return null;

  const pool = getSharedPool({ connectionString: resolveDatabaseUrl() });
  const podBase = resolvePodBaseFromWebId(webId);
  const result = await pool.query<LocalAIConfigRow>(
    `SELECT graph, subject, predicate, object_kind, object_key, object_text, object
     FROM quints
     WHERE predicate = ANY($1::text[])
       AND ($2::text = '' OR graph LIKE $3::text OR subject LIKE $3::text)`,
    [AI_CONFIG_PREDICATES, podBase, `${podBase}%`],
  );

  return resolveLocalAIConfigFromRows(requestedProviderId, result.rows, webId);
}

async function readPodLocalAIConfigFromResources(
  requestedProviderId: string,
  webId: string | undefined,
  resourceFetch: typeof fetch,
): Promise<{ providerId: string; model?: string; candidates: LocalAICandidate[] } | null> {
  const podBase = resolvePodBaseFromWebId(webId);
  if (!podBase) return null;

  const credentialUrl = credentialDocumentUrl(podBase);
  const credentialText = await fetchResourceText(resourceFetch, credentialUrl);
  if (!credentialText.trim()) return null;

  const rows = parseTurtleRows(credentialUrl, credentialText);
  const providerUrls = new Set<string>();
  const requestedProvider = normalizeProviderId(requestedProviderId);
  if (requestedProvider) {
    providerUrls.add(providerDocumentUrl(podBase, requestedProvider));
  }

  for (const row of rows) {
    if (row.predicate !== `${XPOD_CREDENTIAL}provider`) continue;
    const providerUrl = resolvePodResourceUrl(row.object_key || row.object_text || row.object || '', podBase);
    if (providerUrl && providerUrl.includes('/settings/providers/')) {
      providerUrls.add(providerUrl);
    }
  }

  for (const providerUrl of providerUrls) {
    const providerText = await fetchResourceText(resourceFetch, providerUrl).catch(() => '');
    if (!providerText.trim()) continue;
    rows.push(...parseTurtleRows(providerUrl, providerText));
  }

  return resolveLocalAIConfigFromRows(requestedProviderId, rows, webId);
}

async function readPodLocalAIConfigFromFiles(
  requestedProviderId: string,
  webId: string | undefined,
  fileRootPath: string,
): Promise<{ providerId: string; model?: string; candidates: LocalAICandidate[] } | null> {
  const podBase = resolvePodBaseFromWebId(webId);
  if (!podBase) return null;

  const credentialUrl = credentialDocumentUrl(podBase);
  const credentialText = await readResourceFileText(fileRootPath, credentialUrl);
  if (!credentialText.trim()) return null;

  const rows = parseTurtleRows(credentialUrl, credentialText);
  const providerUrls = new Set<string>();
  const requestedProvider = normalizeProviderId(requestedProviderId);
  if (requestedProvider) {
    providerUrls.add(providerDocumentUrl(podBase, requestedProvider));
  }

  for (const row of rows) {
    if (row.predicate !== `${XPOD_CREDENTIAL}provider`) continue;
    const providerUrl = resolvePodResourceUrl(row.object_key || row.object_text || row.object || '', podBase);
    if (providerUrl && providerUrl.includes('/settings/providers/')) {
      providerUrls.add(providerUrl);
    }
  }

  for (const providerUrl of providerUrls) {
    const providerText = await readResourceFileText(fileRootPath, providerUrl).catch(() => '');
    if (!providerText.trim()) continue;
    rows.push(...parseTurtleRows(providerUrl, providerText));
  }

  return resolveLocalAIConfigFromRows(requestedProviderId, rows, webId);
}

function resolveLocalAIConfigFromRows(
  requestedProviderId: string,
  rows: LocalAIConfigRow[],
  webId?: string,
): { providerId: string; model?: string; candidates: LocalAICandidate[] } | null {
  const records = buildLocalAIRecords(rows, webId);
  let candidates = selectLocalAICandidates(requestedProviderId, records.credentials, records.providers);
  let providerId = requestedProviderId;

  if (candidates.length === 0 && requestedProviderId === 'openai') {
    const openaiLike = records.credentials.find((credential) => credential.providerId.startsWith('openai'));
    if (openaiLike) {
      providerId = openaiLike.providerId;
      candidates = selectLocalAICandidates(providerId, records.credentials, records.providers);
    }
  }

  if (candidates.length === 0) {
    const defaultCredential = records.credentials.find((credential) => credential.isDefault && isCredentialAvailable(credential))
      ?? records.credentials.find(isCredentialAvailable);
    if (defaultCredential) {
      providerId = defaultCredential.providerId;
      candidates = selectLocalAICandidates(providerId, records.credentials, records.providers);
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  const provider = records.providers.find((entry) => sameProvider(entry.id, providerId));
  return {
    providerId,
    model: normalizeModelId(provider?.defaultModel ?? provider?.hasModel),
    candidates,
  };
}

export function selectLocalAICandidates(
  providerId: string,
  credentials: LocalAICredentialRecord[],
  providers: LocalAIProviderRecord[] = [],
): LocalAICandidate[] {
  const provider = normalizeProviderId(providerId);
  if (!provider) return [];

  const providerRecord = providers.find((entry) => sameProvider(entry.id, provider));
  const rows = credentials.filter((credential) => (
    sameProvider(credential.providerId, provider)
    && isCredentialAvailable(credential)
    && Boolean(credential.apiKey?.trim())
  ));
  if (rows.length === 0) return [];

  const byHealth = rows.slice().sort((left, right) => {
    const failDiff = normalizeInteger(left.failCount) - normalizeInteger(right.failCount);
    if (failDiff !== 0) return failDiff;
    return left.id.localeCompare(right.id);
  });
  const byRotation = rows.slice().sort((left, right) => {
    const usedDiff = normalizeTimestamp(left.lastUsedAt) - normalizeTimestamp(right.lastUsedAt);
    if (usedDiff !== 0) return usedDiff;
    const failDiff = normalizeInteger(left.failCount) - normalizeInteger(right.failCount);
    if (failDiff !== 0) return failDiff;
    return left.id.localeCompare(right.id);
  });

  const routingPolicy = normalizeRoutingPolicy(providerRecord?.routingPolicy);
  const orderedRows = (() => {
    if (routingPolicy === 'failover') {
      const defaults = rows.filter((row) => row.isDefault);
      const defaultIds = new Set(defaults.map((row) => row.id));
      return [
        ...defaults.sort((left, right) => normalizeInteger(left.failCount) - normalizeInteger(right.failCount)),
        ...byHealth.filter((row) => !defaultIds.has(row.id)),
      ];
    }

    if (routingPolicy === 'random') {
      return rows.slice().sort(() => Math.random() - 0.5);
    }

    if (routingPolicy === 'weighted') {
      const healthiestFailCount = normalizeInteger(byHealth[0]?.failCount);
      const primaryPool = byHealth.filter((row) => normalizeInteger(row.failCount) === healthiestFailCount);
      const weighted = primaryPool.map((row) => ({ row, weight: Math.max(1, normalizeInteger(row.weight) || 1) }));
      const total = weighted.reduce((sum, item) => sum + item.weight, 0);
      let cursor = Math.random() * total;
      let chosen = weighted[0]?.row;
      for (const item of weighted) {
        cursor -= item.weight;
        if (cursor <= 0) {
          chosen = item.row;
          break;
        }
      }
      return [
        ...(chosen ? [chosen] : []),
        ...byHealth.filter((row) => row !== chosen),
      ];
    }

    return byRotation;
  })();

  const candidates: LocalAICandidate[] = [];
  for (const credential of orderedRows) {
    const baseUrl = normalizeBaseUrl(credential.baseUrl) || normalizeBaseUrl(providerRecord?.baseUrl) || getDefaultBaseUrl(provider);
    if (!baseUrl || !credential.apiKey) continue;
    candidates.push({
      providerId: provider,
      credentialId: credential.id,
      credentialSubject: credential.subject,
      credentialGraph: credential.graph,
      credential,
      apiKey: credential.apiKey,
      baseUrl,
      proxyUrl: credential.proxyUrl || providerRecord?.proxyUrl,
      timeoutMs: credential.timeoutMs,
    });
  }
  return candidates;
}

export async function recordCandidateSuccess(
  candidate: LocalAICandidate,
  options: LinxModelConfigRepositoryOptions = {},
): Promise<void> {
  if (!candidate.credentialSubject || !candidate.credentialGraph) return;
  await writeCredentialHealth(candidate, {
    lastUsedAt: new Date(),
    failCount: 0,
    status: 'active',
    rateLimitResetAt: null,
  }, options);
}

export async function recordCandidateFailure(
  candidate: LocalAICandidate,
  error: unknown,
  options: LinxModelConfigRepositoryOptions = {},
): Promise<void> {
  if (!candidate.credentialSubject || !candidate.credentialGraph) return;
  const failCount = normalizeInteger((candidate.credential as LocalAICredentialRecord).failCount) + 1;
  const patch: Record<string, unknown> = { failCount };
  if (isRateLimitError(error)) {
    patch.status = 'rate_limited';
    patch.rateLimitResetAt = new Date(Date.now() + 5 * 60_000);
  }
  await writeCredentialHealth(candidate, patch, options);
}

function buildLocalAIRecords(rows: LocalAIConfigRow[], webId?: string): {
  providers: LocalAIProviderRecord[];
  credentials: LocalAICredentialRecord[];
} {
  const podBase = resolvePodBaseFromWebId(webId);
  const bySubject = new Map<string, { graph: string; values: Record<string, string> }>();

  for (const row of rows) {
    if (podBase && !row.graph.startsWith(podBase) && !row.subject.startsWith(podBase)) {
      continue;
    }

    const field = row.predicate.startsWith(XPOD_CREDENTIAL) || row.predicate.startsWith(XPOD_AI)
      ? row.predicate.split('#').pop()
      : row.predicate === RDF_TYPE
        ? 'type'
        : '';
    if (!field) continue;

    const current = bySubject.get(row.subject) ?? { graph: row.graph, values: {} };
    const value = row.object_text || row.object_key || row.object || '';
    current.values[field] = value;
    bySubject.set(row.subject, current);
  }

  const providers: LocalAIProviderRecord[] = [];
  const credentials: LocalAICredentialRecord[] = [];

  for (const [subject, item] of bySubject) {
    const values = item.values;
    if (values.apiKey || values.provider) {
      credentials.push({
        id: normalizeResourceId(subject),
        graph: item.graph,
        subject,
        providerId: normalizeProviderId(values.provider || ''),
        providerRef: values.provider,
        service: values.service,
        status: values.status,
        apiKey: values.apiKey,
        baseUrl: values.baseUrl,
        proxyUrl: values.proxyUrl,
        timeoutMs: normalizePositiveInteger(values.timeoutMs),
        weight: normalizePositiveInteger(values.weight),
        isDefault: normalizeBoolean(values.isDefault),
        lastUsedAt: values.lastUsedAt,
        failCount: normalizeInteger(values.failCount),
        rateLimitResetAt: values.rateLimitResetAt,
      });
      continue;
    }

    if (values.baseUrl || values.routingPolicy || values.hasModel || values.defaultModel || values.type?.endsWith('#Provider')) {
      providers.push({
        id: normalizeProviderId(subject),
        graph: item.graph,
        subject,
        baseUrl: values.baseUrl,
        proxyUrl: values.proxyUrl,
        routingPolicy: values.routingPolicy,
        hasModel: values.hasModel,
        defaultModel: values.defaultModel,
      });
    }
  }

  const providerBySubject = new Map(providers.flatMap((provider) => [
    [provider.subject, provider.id],
    [provider.graph, provider.id],
  ] as Array<[string, string]>));
  for (const credential of credentials) {
    credential.providerId = providerBySubject.get(credential.providerRef || '') || normalizeProviderId(credential.providerRef || credential.providerId);
  }

  const score = (record: { graph: string; subject: string }) => {
    if (!podBase) return 0;
    return record.graph.startsWith(podBase) || record.subject.startsWith(podBase) ? 0 : 1;
  };

  providers.sort((left, right) => score(left) - score(right) || left.id.localeCompare(right.id));
  credentials.sort((left, right) => score(left) - score(right) || left.id.localeCompare(right.id));
  return { providers, credentials };
}

async function writeCredentialHealth(
  candidate: LocalAICandidate,
  patch: Record<string, unknown>,
  options: LinxModelConfigRepositoryOptions = {},
): Promise<void> {
  const graph = candidate.credentialGraph;
  const subject = candidate.credentialSubject;
  if (!graph || !subject) return;

  const fileRootPath = options.fileRootPath ?? createDefaultPodFileRootPath();
  const usesFileSource = Boolean(fileRootPath);
  const allowFallback = options.allowDatabaseFallback ?? !usesFileSource;
  if (fileRootPath && isHttpUrl(graph)) {
    try {
      await writeCredentialHealthToFile(fileRootPath, graph, subject, patch);
      return;
    } catch (error) {
      if (!allowFallback) throw error;
    }
  }

  const resourceFetch = options.resourceFetch ?? createDefaultPodResourceFetch();
  if (resourceFetch && isHttpUrl(graph)) {
    try {
      await writeCredentialHealthToResource(resourceFetch, graph, subject, patch);
      return;
    } catch (error) {
      if (!allowFallback) throw error;
    }
  }

  if (!allowFallback) return;

  const pool = getSharedPool({ connectionString: resolveDatabaseUrl() });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const predicates = CREDENTIAL_HEALTH_PREDICATES.filter((predicate) => {
      const field = predicate.split('#').pop() || '';
      return Object.prototype.hasOwnProperty.call(patch, field);
    });

    if (predicates.length > 0) {
      await client.query(
        'DELETE FROM quints WHERE graph = $1 AND subject = $2 AND predicate = ANY($3::text[])',
        [graph, subject, predicates],
      );
    }

    for (const [field, value] of Object.entries(patch)) {
      if (value === null || value === undefined) continue;
      const predicate = `${XPOD_CREDENTIAL}${field}`;
      const row = field === 'failCount'
        ? typedLiteral(graph, subject, predicate, String(value), XSD_INTEGER)
        : value instanceof Date
          ? typedLiteral(graph, subject, predicate, value.toISOString(), XSD_DATE_TIME)
          : text(graph, subject, predicate, String(value));
      await client.query(
        `INSERT INTO quints (graph, subject, predicate, object, object_kind, object_key, object_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [row.graph, row.subject, row.predicate, row.object, row.object_kind, row.object_key, row.object_text],
      );
    }
    await client.query('COMMIT');
  } catch {
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

async function writeCredentialHealthToResource(
  resourceFetch: typeof fetch,
  graph: string,
  subject: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const predicates = CREDENTIAL_HEALTH_PREDICATES.filter((predicate) => {
    const field = predicate.split('#').pop() || '';
    return Object.prototype.hasOwnProperty.call(patch, field);
  });
  if (predicates.length === 0) return;

  const deletes = predicates
    .map((predicate, index) => `<${subject}> <${predicate}> ?o${index} .`)
    .join('\n');
  const where = predicates
    .map((predicate, index) => `OPTIONAL { <${subject}> <${predicate}> ?o${index} . }`)
    .join('\n');
  const inserts = Object.entries(patch)
    .map(([field, value]) => credentialHealthTriple(subject, field, value))
    .filter((value): value is string => Boolean(value))
    .join('\n');

  const update = `DELETE {\n${deletes}\n}\nINSERT {\n${inserts}\n}\nWHERE {\n${where}\n}`;
  const response = await resourceFetch(graph, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/sparql-update' },
    body: update,
  });
  if (!response.ok) {
    throw new Error(`Persist model credential health failed: ${response.status} ${await response.text().catch(() => response.statusText)}`);
  }
}

async function writeCredentialHealthToFile(
  fileRootPath: string,
  graph: string,
  subject: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const filePath = resourceFilePath(fileRootPath, graph);
  const content = await fs.readFile(filePath, 'utf8');
  const parser = new Parser({ baseIRI: graph });
  const healthPredicates = new Set(CREDENTIAL_HEALTH_PREDICATES.filter((predicate) => {
    const field = predicate.split('#').pop() || '';
    return Object.prototype.hasOwnProperty.call(patch, field);
  }));
  if (healthPredicates.size === 0) return;

  const writer = new Writer({ prefixes: {
    cred: `${XPOD_CREDENTIAL}`,
    ai: `${XPOD_AI}`,
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  } });
  for (const quad of parser.parse(content)) {
    if (
      quad.subject.termType === 'NamedNode'
      && quad.subject.value === subject
      && quad.predicate.termType === 'NamedNode'
      && healthPredicates.has(quad.predicate.value)
    ) {
      continue;
    }
    writer.addQuad(quad.subject, quad.predicate, quad.object);
  }

  for (const [field, value] of Object.entries(patch)) {
    const quad = credentialHealthQuad(subject, field, value);
    if (quad) writer.addQuad(quad.subject, quad.predicate, quad.object);
  }

  const turtle = await new Promise<string>((resolve, reject) => {
    writer.end((error, result) => error ? reject(error) : resolve(result));
  });
  await fs.writeFile(filePath, turtle, 'utf8');
}

function normalizeResourceId(value?: string): string {
  if (!value) return '';
  const clean = value.trim().replace(/\/$/, '');
  const hash = clean.lastIndexOf('#');
  if (hash >= 0 && hash < clean.length - 1) {
    const fragment = clean.slice(hash + 1);
    if (fragment !== 'this') return fragment;
  }
  const noHash = hash >= 0 ? clean.slice(0, hash) : clean;
  const tail = noHash.split('/').pop() || noHash;
  return tail.endsWith('.ttl') ? tail.slice(0, -4) : tail;
}

export function normalizeProviderId(value?: string): string {
  return normalizeResourceId(value).trim().toLowerCase();
}

function credentialDocumentUrl(podBase: string): string {
  return new URL('settings/credentials.ttl', podBase).href;
}

function providerDocumentUrl(podBase: string, providerId: string): string {
  return new URL(`settings/providers/${providerId}.ttl`, podBase).href;
}

async function readResourceFileText(fileRootPath: string, url: string): Promise<string> {
  try {
    return await fs.readFile(resourceFilePath(fileRootPath, url), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function resourceFilePath(fileRootPath: string, resourceUrl: string): string {
  const baseUrl = process.env.CSS_BASE_URL || 'http://localhost:5737/';
  const base = new URL(baseUrl);
  const url = new URL(resourceUrl);
  if (url.origin !== base.origin) {
    throw new Error(`Resource URL origin does not match CSS_BASE_URL: ${resourceUrl}`);
  }

  const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!relativePath || relativePath.split('/').includes('..')) {
    throw new Error(`Unsafe Pod resource path: ${resourceUrl}`);
  }

  return path.resolve(fileRootPath, relativePath);
}

async function fetchResourceText(resourceFetch: typeof fetch, url: string): Promise<string> {
  const response = await resourceFetch(url, { headers: { Accept: 'text/turtle' } });
  if (response.status === 404) return '';
  if (!response.ok) {
    throw new Error(`Read model config resource failed: ${response.status} ${await response.text().catch(() => response.statusText)}`);
  }
  return response.text();
}

function parseTurtleRows(graph: string, content: string): LocalAIConfigRow[] {
  const parser = new Parser({ baseIRI: graph });
  return parser.parse(content).flatMap((quad) => {
    if (quad.subject.termType !== 'NamedNode' || quad.predicate.termType !== 'NamedNode') {
      return [];
    }

    if (quad.object.termType === 'NamedNode') {
      return [{
        graph,
        subject: quad.subject.value,
        predicate: quad.predicate.value,
        object_kind: 'iri',
        object_key: quad.object.value,
        object_text: quad.object.value,
        object: quad.object.value,
      }];
    }

    if (quad.object.termType === 'Literal') {
      const value = quad.object.value;
      const object = quad.object.datatype?.value
        ? `"${value.replace(/"/g, '\\"')}"^^${quad.object.datatype.value}`
        : JSON.stringify(value);
      return [{
        graph,
        subject: quad.subject.value,
        predicate: quad.predicate.value,
        object_kind: 'literal',
        object_key: object,
        object_text: value,
        object,
      }];
    }

    return [];
  });
}

function resolvePodResourceUrl(value: string, podBase: string): string {
  const clean = value.trim();
  if (!clean) return '';
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(clean)) {
    try {
      const parsedValue = new URL(clean);
      const parsedPod = new URL(podBase);
      if (parsedValue.origin === parsedPod.origin && parsedValue.pathname.startsWith('/settings/')) {
        return new URL(`${parsedValue.pathname.replace(/^\/+/, '')}${parsedValue.search}${parsedValue.hash}`, parsedPod).href;
      }
    } catch {
      return clean;
    }
    return clean;
  }
  return new URL(clean.replace(/^\/+/, ''), podBase).href;
}

function createDefaultPodResourceFetch(): typeof fetch | undefined {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return undefined;
  if (process.env.LINX_MODEL_CONFIG_RESOURCE_FETCH === 'off') return undefined;
  if (!process.env.CSS_BASE_URL && !process.env.CSS_INTERNAL_URL) return undefined;
  return fetch;
}

function createDefaultPodFileRootPath(): string | undefined {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return undefined;
  return path.resolve(process.env.CSS_ROOT_FILE_PATH || './data');
}

export function normalizeModelId(value?: string): string {
  const normalized = normalizeResourceId(value);
  if (!normalized.includes('/')) return normalized;
  return normalized.split('/').slice(1).join('/') || normalized;
}

export function inferProviderFromModel(model?: string): string | undefined {
  if (typeof model !== 'string' || !model.includes('/')) return undefined;
  return model.split('/')[0];
}

function sameProvider(left?: string, right?: string): boolean {
  const leftId = normalizeProviderId(left);
  const rightId = normalizeProviderId(right);
  return Boolean(leftId && rightId && leftId === rightId);
}

function normalizeRoutingPolicy(value?: string): 'least_recently_used' | 'failover' | 'random' | 'weighted' {
  return value === 'failover' || value === 'random' || value === 'weighted' || value === 'least_recently_used'
    ? value
    : 'least_recently_used';
}

function isCredentialAvailable(credential: LocalAICredentialRecord): boolean {
  const service = credential.service?.toLowerCase() || 'ai';
  if (service !== 'ai') return false;

  const status = credential.status?.toLowerCase() || 'active';
  if (status === 'inactive') return false;
  if (status === 'rate_limited') {
    const resetAt = normalizeTimestamp(credential.rateLimitResetAt);
    return resetAt > 0 && resetAt <= Date.now();
  }
  return status === 'active';
}

export function normalizeBaseUrl(value?: string): string {
  const normalized = value?.trim().replace(/\/$/, '') || '';
  if (!normalized) return '';
  if (normalized.endsWith('/chat/completions')) {
    return normalized.slice(0, -'/chat/completions'.length);
  }
  if (normalized.endsWith('/responses')) {
    return normalized.slice(0, -'/responses'.length);
  }
  return normalized;
}

function getDefaultBaseUrl(providerId: string): string {
  if (providerId === 'openai' || providerId.startsWith('openai')) return 'https://api.openai.com/v1';
  if (providerId === 'deepseek') return 'https://api.deepseek.com/v1';
  if (providerId === 'openrouter') return 'https://openrouter.ai/api/v1';
  if (providerId === 'ollama') return 'http://localhost:11434/v1';
  return '';
}

function normalizeBoolean(value?: string): boolean {
  return value === 'true' || value === '1';
}

function normalizeInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const parsed = normalizeInteger(value);
  return parsed > 0 ? parsed : undefined;
}

function normalizeTimestamp(value?: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function resolvePodBaseFromWebId(webId?: string): string {
  if (!webId) return '';
  try {
    const url = new URL(webId);
    const marker = '/profile/card';
    const markerIndex = url.pathname.indexOf(marker);
    if (markerIndex >= 0) {
      url.pathname = `${url.pathname.slice(0, markerIndex + 1)}`;
      url.hash = '';
      url.search = '';
      return url.toString();
    }
    return `${url.origin}/`;
  } catch {
    return '';
  }
}

function isRateLimitError(error: unknown): boolean {
  const status = typeof error === 'object' && error ? (error as { status?: unknown }).status : undefined;
  if (status === 429) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('rate limit') || message.includes('too many requests');
}

function text(graph: string, subject: string, predicate: string, value: string) {
  const object = JSON.stringify(value);
  return { graph, subject, predicate, object, object_kind: 'text', object_key: object, object_text: value };
}

function literal(graph: string, subject: string, predicate: string, object: string, objectText: string) {
  return { graph, subject, predicate, object, object_kind: 'literal', object_key: object, object_text: objectText };
}

function typedLiteral(graph: string, subject: string, predicate: string, value: string, datatype: string) {
  return literal(graph, subject, predicate, `"${value.replace(/"/g, '\\"')}"^^${datatype}`, value);
}

function credentialHealthTriple(subject: string, field: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const predicate = `${XPOD_CREDENTIAL}${field}`;
  if (field === 'failCount') {
    return `<${subject}> <${predicate}> ${normalizeInteger(value)} .`;
  }
  if (value instanceof Date) {
    return `<${subject}> <${predicate}> "${sparqlString(value.toISOString())}"^^<${XSD_DATE_TIME}> .`;
  }
  return `<${subject}> <${predicate}> "${sparqlString(String(value))}" .`;
}

function credentialHealthQuad(subject: string, field: string, value: unknown) {
  if (value === null || value === undefined) return null;
  const predicate = `${XPOD_CREDENTIAL}${field}`;
  if (field === 'failCount') {
    return DataFactory.quad(
      DataFactory.namedNode(subject),
      DataFactory.namedNode(predicate),
      DataFactory.literal(String(normalizeInteger(value)), DataFactory.namedNode(XSD_INTEGER)),
    );
  }
  if (value instanceof Date) {
    return DataFactory.quad(
      DataFactory.namedNode(subject),
      DataFactory.namedNode(predicate),
      DataFactory.literal(value.toISOString(), DataFactory.namedNode(XSD_DATE_TIME)),
    );
  }
  return DataFactory.quad(
    DataFactory.namedNode(subject),
    DataFactory.namedNode(predicate),
    DataFactory.literal(String(value)),
  );
}

function sparqlString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function resolveDatabaseUrl(): string {
  return process.env.CSS_SPARQL_ENDPOINT
    || process.env.CSS_IDENTITY_DB_URL
    || process.env.DATABASE_URL
    || 'postgresql://postgres:postgres@localhost:5432/xpod_local';
}
