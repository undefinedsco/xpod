import type { GatewayModelProjection } from '../routing/ModelRouter';

export interface GatewayModelProjectionOptions {
  /** An operator-owned catalog cannot delegate ownership to its upstream payload. */
  ownerOverride?: string;
  fallbackOwner?: string;
}

const CAPABILITY_KEYS = [
  'toolCalls', 'parallelToolCalls', 'reasoningEffort', 'imageInput',
  'promptCaching', 'embedding', 'fast',
] as const;
const PROTOCOLS = new Set(['chatCompletions', 'responses', 'anthropic']);

/** Projects the public /v1/models contract; raw upstream objects never escape. */
export function parseGatewayModelList(payload: unknown, options: GatewayModelProjectionOptions = {}): GatewayModelProjection[] {
  const record = objectRecord(payload);
  const data = record?.data;
  if (!Array.isArray(data)) return [];
  const models: GatewayModelProjection[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    const model = projectGatewayModel(item, options);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

export function projectGatewayModel(item: unknown, options: GatewayModelProjectionOptions = {}): GatewayModelProjection | undefined {
  const record = objectRecord(item);
  const id = stringValue(record?.id);
  if (!record || !id) return undefined;
  const projection: GatewayModelProjection = {
    id,
    object: 'model',
    owned_by: options.ownerOverride ?? stringValue(record.owned_by) ?? options.fallbackOwner ?? 'cloud',
  };
  if (typeof record.context_window === 'number' && Number.isFinite(record.context_window) && record.context_window > 0) {
    projection.context_window = record.context_window;
  }
  const capabilities = objectRecord(record.capabilities);
  if (capabilities) {
    const filtered = Object.fromEntries(CAPABILITY_KEYS.flatMap((key) =>
      typeof capabilities[key] === 'boolean' ? [[key, capabilities[key]]] : []));
    if (Object.keys(filtered).length) projection.capabilities = filtered;
  }
  if (Array.isArray(record.protocols)) {
    projection.protocols = record.protocols.filter((value): value is NonNullable<GatewayModelProjection['protocols']>[number] =>
      typeof value === 'string' && PROTOCOLS.has(value));
  }
  if (record.custom === true) projection.custom = true;
  const displayName = stringValue(record.display_name);
  if (displayName) projection.display_name = displayName;
  const modalities = objectRecord(record.modalities);
  if (modalities) {
    const input = stringArray(modalities.input);
    const output = stringArray(modalities.output);
    if (input || output) projection.modalities = { ...(input ? { input } : {}), ...(output ? { output } : {}) };
  }
  const customCapabilities = stringArray(record.custom_capabilities);
  if (customCapabilities) projection.custom_capabilities = customCapabilities;
  return projection;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}
