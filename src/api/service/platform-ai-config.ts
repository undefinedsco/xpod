import { getDefaultBaseUrl } from './provider-registry';

const DEFAULT_PLATFORM_PROVIDER = 'undefineds';
const DEFAULT_PLATFORM_MODEL = 'linx-lite';
const DEFAULT_PLATFORM_QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_PLATFORM_GENERATION_TIMEOUT_MS = 120_000;

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function getAiGatewayBaseUrl(): string | undefined {
  const explicit = readTrimmedEnv('DEFAULT_API_BASE');
  if (explicit) {
    return explicit.replace(/\/$/, '');
  }
  return undefined;
}

export function getAiGatewayApiKey(): string | undefined {
  return readTrimmedEnv('DEFAULT_API_KEY');
}

export function getPlatformApiBaseUrl(): string | undefined {
  const explicit = readTrimmedEnv('DEFAULT_API_BASE');
  if (explicit) {
    return explicit.replace(/\/$/, '');
  }

  const aiGatewayBase = getAiGatewayBaseUrl();
  if (!aiGatewayBase) {
    const provider = getPlatformProviderId();
    if (provider === DEFAULT_PLATFORM_PROVIDER) {
      return undefined;
    }
    return getDefaultBaseUrl(provider);
  }

  return aiGatewayBase.endsWith('/v1') ? aiGatewayBase : `${aiGatewayBase}/v1`;
}

export function getPlatformApiKey(): string {
  return getAiGatewayApiKey() ?? '';
}

export function hasPlatformApiConfig(): boolean {
  return !!(getPlatformApiBaseUrl() || getPlatformApiKey());
}

export function getPlatformProviderId(): string {
  return readTrimmedEnv('DEFAULT_PROVIDER') ?? DEFAULT_PLATFORM_PROVIDER;
}

export function getPlatformDefaultModel(): string {
  return readTrimmedEnv('DEFAULT_MODEL') ?? DEFAULT_PLATFORM_MODEL;
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
