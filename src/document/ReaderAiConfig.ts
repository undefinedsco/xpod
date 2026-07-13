export interface ReaderProviderRow {
  id?: string | null;
  '@id'?: string | null;
  displayName?: string | null;
  baseUrl?: string | null;
  proxyUrl?: string | null;
  defaultModel?: string | null;
  hasModel?: string | null;
}

export interface ReaderModelRow {
  id?: string | null;
  '@id'?: string | null;
  displayName?: string | null;
  modelType?: string | null;
  isProvidedBy?: string | null;
  status?: string | null;
}

export interface ReaderCredentialRow {
  id?: string | null;
  '@id'?: string | null;
  provider?: string | null;
  service?: string | null;
  status?: string | null;
  apiKey?: string | null;
  isDefault?: boolean | string | number | null;
  lastUsedAt?: string | Date | number | null;
  failCount?: number | null;
  baseUrl?: string | null;
  proxyUrl?: string | null;
}

export interface SelectReaderAiConfigInput {
  providers: ReaderProviderRow[];
  models: ReaderModelRow[];
  credentials: ReaderCredentialRow[];
  preferredProviderId?: string;
}

export interface ReaderAiConfig {
  providerId: string;
  providerDisplayName?: string;
  baseUrl?: string;
  proxyUrl?: string;
  model: string;
  modelDisplayName?: string;
  modelType: 'reader';
  credentialId: string;
}

export function selectReaderAiConfig(input: SelectReaderAiConfigInput): ReaderAiConfig | undefined {
  const preferredProviderId = normalizeProviderId(input.preferredProviderId ?? 'paddleocr');
  const provider = input.providers.find((row) => normalizeProviderId(row.id ?? row['@id']) === preferredProviderId);
  if (!provider) return undefined;

  const credential = sortCredentialCandidates(input.credentials)
    .find((row) => {
      if ((row.service ?? 'ai') !== 'ai') return false;
      if ((row.status ?? 'active') !== 'active') return false;
      return normalizeProviderId(row.provider ?? row.id ?? row['@id']) === preferredProviderId;
    });
  if (!credential) return undefined;

  const readerModels = input.models.filter((row) => {
    if ((row.status ?? 'active') === 'inactive') return false;
    if ((row.modelType ?? 'chat').toLowerCase() !== 'reader') return false;
    return normalizeProviderId(row.isProvidedBy) === preferredProviderId;
  });
  if (readerModels.length === 0) return undefined;

  const selectedModelRef = provider.defaultModel ?? provider.hasModel;
  const selectedModelId = normalizeModelId(selectedModelRef, preferredProviderId);
  const model = readerModels.find((row) => normalizeModelId(row.id ?? row['@id'], preferredProviderId) === selectedModelId)
    ?? readerModels[0];
  const modelId = normalizeModelId(model.id ?? model['@id'], preferredProviderId);
  if (!modelId) return undefined;

  return {
    providerId: preferredProviderId,
    providerDisplayName: trim(provider.displayName),
    baseUrl: trim(credential.baseUrl) ?? trim(provider.baseUrl),
    proxyUrl: trim(credential.proxyUrl) ?? trim(provider.proxyUrl),
    model: modelId,
    modelDisplayName: trim(model.displayName),
    modelType: 'reader',
    credentialId: normalizeResourceId(credential.id ?? credential['@id']) || `${preferredProviderId}-default`,
  };
}

export function normalizeProviderId(value?: string | null): string {
  const id = normalizeResourceId(value).toLowerCase();
  if (id === 'paddle') return 'paddleocr';
  return id;
}

export function normalizeModelId(value?: string | null, providerId?: string): string {
  const raw = normalizeResourceId(value);
  if (!raw.includes('/')) return raw;
  if (!providerId) return raw;
  const [prefix, ...rest] = raw.split('/');
  return normalizeProviderId(prefix) === normalizeProviderId(providerId) ? rest.join('/') : raw;
}

export function normalizeResourceId(value?: string | null): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.includes('#')) {
    const fragment = trimmed.split('#').pop();
    return fragment || trimmed;
  }
  const clean = trimmed.replace(/\/$/, '');
  const tail = clean.split('/').filter(Boolean).pop() ?? clean;
  return tail.endsWith('.ttl') ? tail.slice(0, -4) : tail;
}

function sortCredentialCandidates(credentials: ReaderCredentialRow[]): ReaderCredentialRow[] {
  return [...credentials].sort((left, right) => {
    const defaultDelta = Number(isTruthy(right.isDefault)) - Number(isTruthy(left.isDefault));
    if (defaultDelta !== 0) return defaultDelta;
    const usedDelta = timestamp(left.lastUsedAt) - timestamp(right.lastUsedAt);
    if (usedDelta !== 0) return usedDelta;
    const failDelta = (left.failCount ?? 0) - (right.failCount ?? 0);
    if (failDelta !== 0) return failDelta;
    return normalizeResourceId(left.id ?? left['@id']).localeCompare(normalizeResourceId(right.id ?? right['@id']));
  });
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function timestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function trim(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
