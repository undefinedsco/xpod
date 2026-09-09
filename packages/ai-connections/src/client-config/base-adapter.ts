import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AiClientConfigTransaction } from './transaction';
import type {
  AiClientConfigAdapter,
  AiClientConfigPlan,
  AiClientModelReference,
  AiConnectionsClientProfile,
  ClientDetection,
  ClientInspection,
  ClientVerification,
  ConfigWrite,
} from './types';

/** Stable, machine-readable errors shared by all coding-client adapters. */
export class AiClientConfigError extends Error {
  public readonly code: 'model_catalog_empty' | 'model_catalog_invalid' | 'model_not_available';

  public constructor(
    code: 'model_catalog_empty' | 'model_catalog_invalid' | 'model_not_available',
    message: string = code,
  ) {
    super(message);
    this.name = 'AiClientConfigError';
    this.code = code;
  }
}

interface OwnershipState {
  version: 1;
  client: string;
  webIdHash: string;
  files: Array<{
    path: string;
    existed: boolean;
    backupPath?: string;
  }>;
}

export function hashWebId(webId: string): string {
  return crypto.createHash('sha256').update(webId.trim(), 'utf8').digest('hex');
}

export function normalizeV1Endpoint(endpoint: string): string {
  const normalized = endpoint.trim().replace(/\/+$/, '');
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

export function normalizeMessagesEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function parseJsonObject(content: string | undefined, label: string): Record<string, unknown> {
  if (!content?.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Cannot configure ${label}: invalid JSON (${String(error)})`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Cannot configure ${label}: root must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function looksLikePreviousXpodValue(value: unknown): boolean {
  return typeof value === 'string' && (
    value.includes('xpod') ||
    value.includes('/api/ai') ||
    value.includes('xpod.')
  );
}

export function profileApiKey(profile: AiConnectionsClientProfile): string {
  const legacyField = ['gateway', 'Key'].join('');
  const value = profile.apiKey ?? (profile as unknown as Record<string, unknown>)[legacyField];
  return typeof value === 'string' ? value : '';
}

/**
 * Resolve a requested model against the already-filtered Gateway catalog.
 *
 * The Gateway owns visibility and provider alias semantics. This boundary only
 * accepts the resulting typed projection and prevents stale/unpicked models
 * from leaking into a local client config. An unqualified id is accepted only
 * when it maps to one catalog entry; provider-qualified ids are deterministic.
 */
export function resolveActiveModel(profile: AiConnectionsClientProfile): string {
  const catalog = normalizeActiveModels(profile.activeModels);
  const requested = profile.model?.trim();
  if (!requested) return catalog[0].qualifiedId;

  const exact = catalog.filter((model) => model.qualifiedId.toLowerCase() === requested.toLowerCase());
  if (exact.length === 1) return exact[0].qualifiedId;
  if (exact.length > 1) throw new AiClientConfigError('model_not_available');

  const aliases = catalog.filter((model) => model.id.toLowerCase() === requested.toLowerCase());
  if (aliases.length === 1) return aliases[0].qualifiedId;
  throw new AiClientConfigError('model_not_available');
}

/** Return all active, validated models for clients that expose a model list. */
export function activeModelReferences(profile: AiConnectionsClientProfile): Array<{
  id: string;
  name: string;
}> {
  return normalizeActiveModels(profile.activeModels).map((model) => ({
    id: model.qualifiedId,
    name: model.displayName ?? model.qualifiedId,
  }));
}

interface NormalizedActiveModel {
  id: string;
  qualifiedId: string;
  displayName?: string;
}

function normalizeActiveModels(models: readonly AiClientModelReference[] | undefined): NormalizedActiveModel[] {
  if (!Array.isArray(models) || models.length === 0) {
    throw new AiClientConfigError('model_catalog_empty');
  }

  const normalized: NormalizedActiveModel[] = [];
  const seenQualified = new Set<string>();
  for (const model of models) {
    if (!model || typeof model.id !== 'string' || !model.id.trim()) continue;
    if (model.availability !== undefined && model.availability !== 'available') continue;
    const id = model.id.trim();
    const provider = typeof model.provider === 'string' ? model.provider.trim() : '';
    const qualifiedId = provider && !id.toLowerCase().startsWith(`${provider.toLowerCase()}/`)
      ? `${provider}/${id}`
      : id;
    const key = qualifiedId.toLowerCase();
    if (seenQualified.has(key)) {
      throw new AiClientConfigError('model_catalog_invalid', 'Active Gateway catalog contains duplicate model ids');
    }
    seenQualified.add(key);
    normalized.push({
      id: provider && id.toLowerCase().startsWith(`${provider.toLowerCase()}/`)
        ? id.slice(provider.length + 1)
        : id,
      qualifiedId,
      ...(typeof model.displayName === 'string' && model.displayName.trim()
        ? { displayName: model.displayName.trim() }
        : {}),
    });
  }
  if (normalized.length === 0) {
    throw new AiClientConfigError('model_catalog_empty');
  }
  return normalized;
}

/** Apply catalog validation once at the shared adapter boundary. */
export function normalizeClientProfile(profile: AiConnectionsClientProfile): AiConnectionsClientProfile {
  return {
    ...profile,
    model: resolveActiveModel(profile),
  };
}

export function stripLegacyXpodObject(value: Record<string, unknown>): void {
  const legacy = value.xpod;
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
    delete value.xpod;
  }
}

export abstract class BaseAiClientConfigAdapter implements AiClientConfigAdapter {
  protected readonly transaction: AiClientConfigTransaction;
  protected readonly statePath: string;

  protected constructor(
    protected readonly client: string,
    private readonly executable: string,
    protected readonly configPaths: string[],
    stateDirectory: string,
    transaction = new AiClientConfigTransaction(),
  ) {
    this.transaction = transaction;
    this.statePath = path.join(stateDirectory, `.xpod-ai-connections-${client}.json`);
  }

  public async detect(): Promise<ClientDetection> {
    return {
      installed: await this.isExecutableOnPath(),
      configExists: (await Promise.all(this.configPaths.map((filePath) => this.exists(filePath)))).some(Boolean),
      configPaths: [...this.configPaths],
    };
  }

  public async inspect(): Promise<ClientInspection> {
    const state = await this.readState();
    return {
      ownership: state ? 'owned' : 'unowned',
      ...(state ? { webIdHash: state.webIdHash } : {}),
      configPaths: [...this.configPaths],
    };
  }

  public async plan(profile: AiConnectionsClientProfile): Promise<AiClientConfigPlan> {
    const normalizedProfile = this.validateProfile(profile);
    const ownerHash = hashWebId(normalizedProfile.webId);
    const currentState = await this.readState();
    if (currentState && currentState.webIdHash !== ownerHash) {
      throw new Error(`${this.client} AI Connection projection is owned by another WebID`);
    }

    const contents = new Map<string, string | undefined>();
    for (const filePath of this.configPaths) {
      await this.rejectSymlink(filePath);
      contents.set(filePath, await this.readOptional(filePath));
    }
    const projected = await this.project(normalizedProfile, contents);
    const timestamp = Date.now();
    const files = this.configPaths.map((filePath) => {
      const prior = currentState?.files.find((file) => file.path === filePath);
      const existed = contents.get(filePath) !== undefined;
      return prior ?? {
        path: filePath,
        existed,
        ...(existed ? { backupPath: `${filePath}.xpod-backup-${timestamp}` } : {}),
      };
    });
    const writes: ConfigWrite[] = [...projected.entries()].map(([filePath, content]) => ({
      path: filePath,
      content,
      backupPath: files.find((file) => file.path === filePath)?.backupPath,
      createBackup: !currentState && contents.get(filePath) !== undefined,
    }));
    const state: OwnershipState = {
      version: 1,
      client: this.client,
      webIdHash: ownerHash,
      files,
    };
    writes.push({ path: this.statePath, content: stringifyJson(state) });
    return { client: this.client, webIdHash: ownerHash, writes };
  }

  public async apply(plan: AiClientConfigPlan): Promise<void> {
    if (plan.client !== this.client) {
      throw new Error(`Cannot apply ${plan.client} plan with ${this.client} adapter`);
    }
    await this.transaction.apply(plan.writes);
  }

  public async verify(profile: AiConnectionsClientProfile): Promise<ClientVerification> {
    const normalizedProfile = this.validateProfile(profile);
    const state = await this.readState();
    if (!state || state.webIdHash !== hashWebId(normalizedProfile.webId)) {
      return { ok: false, reason: 'AI Connection ownership does not match the current WebID' };
    }
    return this.verifyProjection(normalizedProfile);
  }

  public async restore(webId: string): Promise<void> {
    const state = await this.readState();
    if (!state) return;
    if (state.webIdHash !== hashWebId(webId)) {
      throw new Error(`${this.client} AI Connection projection is owned by another WebID`);
    }
    const writes: ConfigWrite[] = [];
    for (const file of state.files) {
      await this.rejectSymlink(file.path);
      const current = await this.readOptional(file.path);
      let original: string | undefined;
      if (file.existed) {
        if (!file.backupPath) {
          throw new Error(`Missing ${this.client} backup metadata for ${file.path}`);
        }
        await this.rejectSymlink(file.backupPath);
        original = await this.readOptional(file.backupPath);
        if (original === undefined) {
          throw new Error(`Missing ${this.client} backup at ${file.backupPath}`);
        }
      }
      writes.push({
        path: file.path,
        content: await this.restoreFile(file.path, current, original, file.existed),
      });
    }
    writes.push({ path: this.statePath, content: null });
    await this.transaction.apply(writes);
  }

  protected abstract project(
    profile: AiConnectionsClientProfile,
    current: Map<string, string | undefined>,
  ): Promise<Map<string, string>>;

  protected abstract verifyProjection(profile: AiConnectionsClientProfile): Promise<ClientVerification>;

  protected abstract restoreFile(
    filePath: string,
    current: string | undefined,
    original: string | undefined,
    originallyExisted: boolean,
  ): Promise<string | null>;

  protected normalizeProfile(profile: AiConnectionsClientProfile): AiConnectionsClientProfile {
    return normalizeClientProfile(profile);
  }

  protected async readOptional(filePath: string): Promise<string | undefined> {
    try {
      return await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private validateProfile(profile: AiConnectionsClientProfile): AiConnectionsClientProfile {
    if (!profile.endpoint.trim()) throw new Error('AI Connection endpoint is required');
    if (!profileApiKey(profile).trim()) throw new Error('AI Connection API key is required');
    if (!profile.webId.trim()) throw new Error('Current WebID is required');
    return this.normalizeProfile(profile);
  }

  private async readState(): Promise<OwnershipState | undefined> {
    await this.rejectSymlink(this.statePath);
    const content = await this.readOptional(this.statePath);
    if (!content) return undefined;
    const parsed = parseJsonObject(content, `${this.client} ownership state`);
    if (parsed.version !== 1 || parsed.client !== this.client || typeof parsed.webIdHash !== 'string' ||
      !Array.isArray(parsed.files)) {
      throw new Error(`Invalid ${this.client} AI Connection ownership state`);
    }
    return parsed as unknown as OwnershipState;
  }

  private async rejectSymlink(filePath: string): Promise<void> {
    try {
      if ((await fs.promises.lstat(filePath)).isSymbolicLink()) {
        throw new Error(`Refusing to configure symbolic link: ${filePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      return (await fs.promises.lstat(filePath)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async isExecutableOnPath(): Promise<boolean> {
    const pathValue = process.env.PATH ?? '';
    for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
      try {
        await fs.promises.access(path.join(directory, this.executable), fs.constants.X_OK);
        return true;
      } catch {
        // Continue searching PATH.
      }
    }
    return false;
  }
}
