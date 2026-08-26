import {
  getBuiltinModels,
} from '@undefineds.co/models';

const UNDEFINEDS_AI_PROVIDER_ID = 'undefineds';
const LINX_LITE_MODEL_ID = 'linx-lite';
const UNDEFINEDS_AI_MODEL_IDS = ['linx-lite', 'linx'] as const;
const UNDEFINEDS_AI_MODEL_ID_SET = new Set<string>(UNDEFINEDS_AI_MODEL_IDS);
const DEFAULT_PLATFORM_QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_PLATFORM_GENERATION_TIMEOUT_MS = 120_000;

export interface PlatformModelListItem {
  id: string;
  object: 'model';
  owned_by: string;
  [key: string]: unknown;
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function getAiGatewayBaseUrl(): string | undefined {
  return readTrimmedEnv('DEFAULT_API_BASE')?.replace(/\/$/, '');
}

export function getAiGatewayApiKey(): string | undefined {
  return readTrimmedEnv('DEFAULT_API_KEY');
}

export function getPlatformProviderId(): string {
  return UNDEFINEDS_AI_PROVIDER_ID;
}

export function getPlatformDefaultModel(): string {
  return readTrimmedEnv('DEFAULT_MODEL') ?? LINX_LITE_MODEL_ID;
}

export function getSharedPlatformModels(): PlatformModelListItem[] {
  const discovered = getBuiltinModels(UNDEFINEDS_AI_PROVIDER_ID);
  const items = discovered.length > 0
    ? discovered.filter((model: { id: string }) => UNDEFINEDS_AI_MODEL_ID_SET.has(model.id))
    : UNDEFINEDS_AI_MODEL_IDS.map((id: string) => ({ id, provider: UNDEFINEDS_AI_PROVIDER_ID }));

  return items.map((model: {
    id: string;
    displayName?: string;
    contextLength?: number;
    maxOutputTokens?: number;
    capabilities?: string[];
  }) => ({
    id: model.id,
    object: 'model',
    owned_by: UNDEFINEDS_AI_PROVIDER_ID,
    provider: UNDEFINEDS_AI_PROVIDER_ID,
    ...(model.displayName ? { display_name: model.displayName } : {}),
    ...(model.contextLength ? { context_length: model.contextLength } : {}),
    ...(model.maxOutputTokens ? { max_output_tokens: model.maxOutputTokens } : {}),
    ...(Array.isArray(model.capabilities) ? { capabilities: model.capabilities } : {}),
  }));
}

export function isSharedPlatformModel(model?: string): boolean {
  return !!model && UNDEFINEDS_AI_MODEL_ID_SET.has(model.trim());
}

export function requireSharedPlatformModel(model: string | undefined, context: string): string {
  const resolved = (model?.trim() || getPlatformDefaultModel()).trim();
  if (!isSharedPlatformModel(resolved)) {
    throw new Error(`${context} only supports shared platform models: ${UNDEFINEDS_AI_MODEL_IDS.join(', ')}. Received: ${resolved}`);
  }
  return resolved;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = readTrimmedEnv(name);
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getPlatformQueryTimeoutMs(): number {
  return readPositiveIntegerEnv('DEFAULT_TIMEOUT_MS', DEFAULT_PLATFORM_QUERY_TIMEOUT_MS);
}

export function getPlatformGenerationTimeoutMs(): number {
  return readPositiveIntegerEnv('DEFAULT_GENERATION_TIMEOUT_MS', DEFAULT_PLATFORM_GENERATION_TIMEOUT_MS);
}

export function getPlatformTimeoutMs(): number {
  return getPlatformQueryTimeoutMs();
}
