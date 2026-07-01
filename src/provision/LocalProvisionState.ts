import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_LOCAL_SETUP_PROVIDER_ID = 'local';
export const DEFAULT_LOCAL_SETUP_FILE_NAME = '.xpod-cloud-registration.json';

export interface LocalProvisionState {
  nodeId?: string;
  nodeToken?: string;
  serviceToken?: string;
  provisionCode?: string;
  publicUrl?: string;
  spDomain?: string;
  cloudIdentityUrl?: string;
  cloudApiUrl?: string;
  provisionUrl?: string;
  registeredAt?: number;
}

export interface LocalProvisionStateUpdate {
  nodeId: string;
  nodeToken: string;
  serviceToken: string;
  provisionCode: string;
  publicUrl?: string;
  spDomain?: string;
  cloudUrl?: string;
  cloudBaseUrl?: string;
}

export function resolveLocalSetupProviderId(value: string | undefined): string {
  return value?.trim() || DEFAULT_LOCAL_SETUP_PROVIDER_ID;
}

export function resolveLocalSetupPath(value: string | undefined, rootDir = process.env.CSS_ROOT_FILE_PATH || './data'): string {
  return path.resolve(value?.trim() || path.join(rootDir, DEFAULT_LOCAL_SETUP_FILE_NAME));
}

export function readLocalProvisionState(
  setupPath: string,
  providerId: string,
): LocalProvisionState | undefined {
  const existing = readJsonObjectFile(setupPath);
  const state = readJsonObject(existing[providerId]);
  if (Object.keys(state).length === 0) {
    return undefined;
  }

  return {
    nodeId: readString(state.nodeId),
    nodeToken: readString(state.nodeToken),
    serviceToken: readString(state.serviceToken),
    provisionCode: readString(state.provisionCode),
    publicUrl: normalizeUrl(readString(state.publicUrl)),
    spDomain: readString(state.spDomain),
    cloudIdentityUrl: normalizeUrl(readString(state.cloudIdentityUrl)),
    cloudApiUrl: normalizeUrl(readString(state.cloudApiUrl)),
    provisionUrl: readString(state.provisionUrl),
    registeredAt: typeof state.registeredAt === 'number' && Number.isFinite(state.registeredAt)
      ? state.registeredAt
      : undefined,
  };
}

export function upsertLocalProvisionState(
  setupPath: string,
  providerId: string,
  state: LocalProvisionStateUpdate,
): void {
  const existing = readJsonObjectFile(setupPath);
  const previous = readJsonObject(existing[providerId]);
  const cloudIdentityUrl = normalizeUrl(state.cloudBaseUrl);
  const cloudApiUrl = normalizeUrl(state.cloudUrl);
  const provisionUrl = cloudIdentityUrl
    ? `${cloudIdentityUrl.replace(/\/+$/u, '')}/.account/?provisionCode=${encodeURIComponent(state.provisionCode)}`
    : readString(previous.provisionUrl);

  existing[providerId] = {
    ...previous,
    nodeId: state.nodeId,
    nodeToken: state.nodeToken,
    serviceToken: state.serviceToken,
    provisionCode: state.provisionCode,
    publicUrl: normalizeUrl(state.publicUrl),
    spDomain: readString(state.spDomain),
    provisionUrl,
    cloudIdentityUrl,
    cloudApiUrl,
    registeredAt: typeof previous.registeredAt === 'number' && Number.isFinite(previous.registeredAt)
      ? previous.registeredAt
      : Date.now(),
  };

  fs.mkdirSync(path.dirname(setupPath), { recursive: true });
  fs.writeFileSync(setupPath, `${JSON.stringify(existing, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(setupPath, 0o600);
  } catch {
    // Some filesystems do not support chmod; the local runtime can still proceed.
  }
}

function readJsonObjectFile(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }

    return readJsonObject(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return {};
  }
}

function readJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  try {
    return new URL(value.trim()).toString().replace(/\/+$/u, '') + '/';
  } catch {
    return value.trim();
  }
}
